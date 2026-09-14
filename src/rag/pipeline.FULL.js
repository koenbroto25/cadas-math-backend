/**
 * RAG Pipeline — 3-layer hybrid (Sprint K, revisi 13 Sep 2026)
 *
 * Layer 1 : Semantic Search  — BGE-M3 via Ollama lokal (1024-dim, cosine)
 *             Corpus: ~14.926 chunks tervalidasi (exercises + explanations)
 *             strong  (≥ SIM_STRONG=0.55)  → quick_trick: return langsung
 *                                            hint_text/speech_text: few-shot context ke LLM
 *             partial (≥ SIM_PARTIAL=0.40) → few-shot context ke LLM
 *             weak    (< SIM_PARTIAL)       → corpus miss → log admin_rag_miss
 *
 * Layer 2 : LLM primary — openai/gpt-4o-mini via OpenRouter (93 key rotasi)
 *             Dipanggil jika Layer 1 partial atau miss (premium only)
 *             System prompt: PRIMING_STRUKTUR_BOT_TUTOR_MATEMATIKA_SD.md §7
 *             Corpus miss → tetap jawab + log admin_rag_miss (jadi backlog materi)
 *
 * Layer 3 : LLM fallback — gemini-3.1-flash-lite via Google AI (200 key rotasi)
 *             Dipanggil hanya jika Layer 2 gagal total (rate limit / error)
 *
 * Post-LLM : math-validator (mathjs) — verifikasi & koreksi kalkulasi
 * Post-LLM : normalizer (deterministic) — notasi → ucapan Indonesia
 * Layer out : output by access level (premium: live TTS, basic: pre-generated audio)
 *
 * Catatan arsitektur:
 *   - Lexical search (ILIKE) dihapus sebagai layer. Terlalu noise untuk corpus tervalidasi.
 *   - LLM tidak menjawab soal di luar materi kurikulum: system prompt memblok ini.
 *   - Semua corpus miss dilog ke admin_rag_miss untuk backlog pengembangan materi.
 *   - Model OpenRouter fallback diupdate: gemini-3.1-flash-lite (preview sudah shutdown Mei 2026)
 */

'use strict';

const http        = require('http');
const db          = require('../database/db');
const normalizer  = require('./normalizer');
const openrouter  = require('./openrouter-client');
const gemini      = require('./gemini-client');
const geminiTTS   = require('./gemini-tts');
const { validateMathAnswer } = require('./math-validator');

// ── Konfigurasi embedding ─────────────────────────────────────────────────────
const OLLAMA_HOST   = process.env.OLLAMA_HOST        || 'localhost';
const OLLAMA_PORT   = parseInt(process.env.OLLAMA_PORT || '11434', 10);
const OLLAMA_MODEL  = process.env.OLLAMA_EMBED_MODEL || 'bge-m3';
const EMBED_DIM     = 1024;
const EMBED_TIMEOUT = parseInt(process.env.OLLAMA_TIMEOUT_MS || '15000', 10);

// Threshold cosine similarity (dikalibrasi dari backtest BGE-M3, 13 Sep 2026)
// Corpus 14.926 chunks: MRR@10=0.9997, Recall@10=100%
const SIM_STRONG  = parseFloat(process.env.RAG_SIM_STRONG  || '0.55');
const SIM_PARTIAL = parseFloat(process.env.RAG_SIM_PARTIAL || '0.40');
const SEM_TOP_K   = parseInt(process.env.RAG_SEM_TOP_K     || '5', 10);

// ── Embedding via BGE-M3 Ollama ───────────────────────────────────────────────
async function generateEmbedding(text) {
  const truncated = String(text || '').slice(0, 512).trim();
  if (!truncated) return null;

  return new Promise(resolve => {
    const body = JSON.stringify({ model: OLLAMA_MODEL, prompt: truncated });
    const req  = http.request(
      {
        hostname: OLLAMA_HOST, port: OLLAMA_PORT,
        path:    '/api/embeddings', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: EMBED_TIMEOUT,
      },
      res => {
        let raw = '';
        res.on('data', c => (raw += c));
        res.on('end', () => {
          try {
            const p = JSON.parse(raw);
            resolve(p.embedding?.length === EMBED_DIM ? p.embedding : null);
          } catch { resolve(null); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error',   () => resolve(null));
    req.write(body); req.end();
  });
}

// ── Layer 1: Semantic Search (BGE-M3) ─────────────────────────────────────────
async function semanticSearch(question, level, conceptId) {
  try {
    // Pastikan pgvector tersedia
    const ext = await db.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    if (ext.rows.length === 0) {
      return { hit: 'none', source: 'semantic', results: [], reason: 'pgvector not installed' };
    }

    const embedding = await generateEmbedding(question);
    if (!embedding) {
      return { hit: 'none', source: 'semantic', results: [], reason: 'Ollama down / embedding gagal' };
    }

    const vecStr = '[' + embedding.map(v => v.toFixed(8)).join(',') + ']';

    // Query: filter by level, sort by cosine distance, prioritas quick_trick
    const { rows } = await db.query(
      `SELECT
         ee.chunk_text,
         ee.chunk_type,
         ee.concept_id,
         ee.exercise_id,
         ee.explanation_id,
         ee.level_id,
         1 - (ee.embedding <=> $1::vector(1024)) AS similarity
       FROM explanations_embedding ee
       WHERE ee.level_id = $2
         AND ee.embedding_ready = true
       ORDER BY
         ee.embedding <=> $1::vector(1024),
         CASE ee.chunk_type
           WHEN 'quick_trick'  THEN 1
           WHEN 'hint_text'    THEN 2
           WHEN 'speech_text'  THEN 3
           ELSE 4
         END
       LIMIT $3`,
      [vecStr, level, SEM_TOP_K]
    );

    if (rows.length === 0) {
      return { hit: 'none', source: 'semantic', results: [] };
    }

    const topSim = parseFloat(rows[0].similarity);

    if (topSim >= SIM_STRONG) {
      return { hit: 'strong', source: 'semantic', results: rows, similarity: topSim };
    }
    if (topSim >= SIM_PARTIAL) {
      return { hit: 'partial', source: 'semantic', results: rows, similarity: topSim };
    }
    return { hit: 'weak', source: 'semantic', results: rows, similarity: topSim };

  } catch (err) {
    console.error('[RAG] semanticSearch error:', err.message);
    return { hit: 'none', source: 'semantic', results: [], reason: err.message };
  }
}

/**
 * Pilih chunk terbaik dari hasil semantic search.
 * Priority: quick_trick > hint_text > speech_text > lainnya
 * Jika similarity drop > 0.05 dari top, tetap pakai top.
 */
function chooseBestChunk(rows) {
  if (!rows || rows.length === 0) return null;
  const topSim = parseFloat(rows[0].similarity);
  const PRIO   = { quick_trick: 1, hint_text: 2, speech_text: 3 };

  let best = rows[0], bestScore = Infinity;
  for (const row of rows) {
    const sim  = parseFloat(row.similarity);
    if (topSim - sim > 0.05) break;
    const score = PRIO[row.chunk_type] || 4;
    if (score < bestScore) { bestScore = score; best = row; }
  }
  return best;
}

// ── Layer 2+3: LLM (OpenRouter primary → Gemini fallback) ────────────────────
async function llmGenerate(question, level, conceptId, fewShotContext, studentId) {
  // Cek quota harian (premium feature)
  const quota = await db.query(
    `SELECT attempted_today, daily_limit FROM student_level_quota
     WHERE student_id = $1 AND current_level = $2`,
    [studentId, level]
  );
  if (quota.rows.length > 0 && quota.rows[0].attempted_today >= quota.rows[0].daily_limit) {
    return {
      hit: 'none', source: 'llm', reason: 'quota_exceeded',
      quotaExhausted: true,
      message: 'Batas tanya hari ini sudah tercapai. Coba lagi besok ya!',
    };
  }

  const systemPrompt = buildSystemPrompt(level, fewShotContext);

  let text = null, model = null, layer = null;

  // Layer 2: OpenRouter (gpt-4o-mini, 93 key rotasi)
  if (openrouter.available) {
    try {
      const result = await openrouter.generate(question, {
        system:      systemPrompt,
        temperature: 0.4,
        maxTokens:   512,
      });
      text  = result.text;
      model = result.model;
      layer = 2;
    } catch (err) {
      console.warn(`[RAG] Layer 2 OpenRouter gagal: ${err.message}. Coba Layer 3 Gemini...`);
    }
  }

  // Layer 3: Gemini langsung via Google AI (200 key rotasi)
  if (!text && gemini.available) {
    try {
      const result = await gemini.generate(question, {
        system:    systemPrompt,
        maxTokens: 512,
      });
      text  = result.text;
      model = result.model;
      layer = 3;
    } catch (err) {
      console.error(`[RAG] Layer 3 Gemini gagal: ${err.message}`);
    }
  }

  if (!text) {
    return { hit: 'none', source: 'llm', reason: 'semua LLM gagal' };
  }

  // Post-LLM: math validator
  const validation = validateMathAnswer(text, question);
  const finalText  = validation.validated ? validation.llmText : text;

  if (validation.validated && !validation.correct && validation.hasNumbers) {
    console.warn(
      `[MathValidator] Koreksi: ${validation.expr} = ${validation.correctAnswer},`,
      `LLM: ${validation.llmAnswer}, model: ${model} (L${layer})`
    );
  }

  // Update quota
  await db.query(
    `INSERT INTO student_level_quota
       (student_id, current_level, attempted_today, daily_limit, is_premium)
     VALUES ($1, $2, 1, 40, true)
     ON CONFLICT (student_id, current_level)
     DO UPDATE SET attempted_today = student_level_quota.attempted_today + 1`,
    [studentId, level]
  ).catch(e => console.warn('[RAG] quota update failed:', e.message));

  // Log biaya LLM
  const cost = layer === 2 ? 0.0001 : 0.00005;
  await db.query(
    `INSERT INTO llm_usage_log (student_id, level_id, model, estimated_cost_usd)
     VALUES ($1, $2, $3, $4)`,
    [studentId, level, model, cost]
  ).catch(e => console.warn('[RAG] llm_usage_log failed:', e.message));

  return {
    hit:   'strong',
    source: 'llm',
    text:   finalText,
    model, layer,
    mathValidation: validation.validated ? {
      correct:       validation.correct,
      correctAnswer: validation.correctAnswer,
      expr:          validation.expr,
    } : null,
  };
}

// ── Log corpus miss ke admin_rag_miss ─────────────────────────────────────────
async function logRagMiss({ studentId, level, question, topSim, topChunkText, llmAnswered, llmModel }) {
  try {
    await db.query(
      `INSERT INTO admin_rag_miss
         (student_id, level_id, question_text, top_sim_score, top_chunk_text, llm_answered, llm_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [studentId || null, level, question,
       topSim   !== undefined ? topSim : null,
       topChunkText || null,
       llmAnswered  || false,
       llmModel     || null]
    );
  } catch (err) {
    console.warn('[RAG] logRagMiss failed:', err.message);
  }
}

// ── System prompt (PRIMING §7) ────────────────────────────────────────────────
function buildSystemPrompt(level, fewShotContext = []) {
  // Estimasi jenjang kelas dari level (1-3=kelas1-2, 4-6=kelas2-3, dst)
  const kelasMap = {
    1: 'Kelas 1-2', 2: 'Kelas 1-2', 3: 'Kelas 2-3',
    4: 'Kelas 2-3', 5: 'Kelas 3-4', 6: 'Kelas 3-4',
    7: 'Kelas 4-5', 8: 'Kelas 4-5', 9: 'Kelas 4-5',
    10: 'Kelas 5-6', 11: 'Kelas 5-6', 12: 'Kelas 5-6',
    13: 'Kelas 5-6', 14: 'Kelas 6',  15: 'Kelas 6',
  };
  const jenjang = kelasMap[level] || `Level ${level}`;
  const maxKata = level <= 6 ? '10' : '15';

  const base = `Kamu adalah Kak Cadas, guru matematika SD yang hangat, sabar, dan jenius dalam menjelaskan.
Kamu BUKAN buku teks. Kamu berbicara langsung ke siswa seperti guru sungguhan di kelas.
Jenjang siswa saat ini: ${jenjang} (Level ${level}).

IDENTITAS MU:
- Sapaan ramah dan natural: "nah", "yuk", "coba kita lihat", "gitu deh", "ngerti gak?"
- Kalimat PENDEK, maksimal ${maxKata} kata per kalimat
- Ritme alami seperti napas manusia — jeda di tempat yang logis
- Cek pemahaman anak: "paham?" "ada yang bingung?" "sejauh ini oke?"
- Pakai analogi konkret dari kehidupan anak: kelereng, kue, mainan, uang jajan
- TIDAK PERNAH terdengar seperti robot atau presentasi formal

BAHASA YANG WAJIB DIPAKAI:
- Operasi: TAMBAH, DIKURANG, DIKALI, DIBAGI (bukan "plus", "minus", "kali", "bagi" formal)
- Pecahan: "PER" — "tiga per empat" (bukan "tiga banding empat")
- Desimal: "KOMA" — "dua koma lima" (bukan "two point five")
- Satuan: sebutkan penuh — sentimeter, kilogram, kilometer (bukan cm, kg, km)
- Bilangan besar: "ribu", "juta", "miliar" (bukan dieja atau pola Inggris)
- Uang: "rupiah" di akhir — "lima ribu rupiah" (bukan "Rp5.000")

BAHASA YANG DILARANG (intrusi Melayu & formalitas):
- kerana → karena | tolak → dikurang | bahagi → dibagi | awak → kamu | hendak → mau
- "Berdasarkan konsep" → "Kalau kita pakai"
- "Prosedur berikut" → "Caranya gini"
- "Dalam hal ini" → "Di sini"

STRUKTUR PENJELASAN (pilih sesuai soal):
MODE GASING: TRIK (1-2 kalimat singkat) → LANGKAH (1 langkah/baris, angka real dari soal) → MENCONGAK (jawaban + pujian santai)
MODE PMRI: KONTEKS (situasi relatable) → PANCINGAN (pertanyaan bimbingan) → EKSPLORASI (bantu anak temukan pola) → KESIMPULAN

BATAS JAWABAN:
- Jawab HANYA soal matematika yang sesuai kurikulum Level ${level}
- Jika soal di luar materi level ini atau di luar matematika SD, jawab sopan:
  "Wah, pertanyaan itu di luar materi Level ${level} ya. Tanya ke gurumu untuk yang ini!"
- Maksimal 150 kata. Tidak perlu basa-basi panjang.
- DILARANG mengarang angka — hitung ulang sebelum tulis jawaban.`;

  if (fewShotContext.length > 0) {
    return base + '\n\nCONTOH PENJELASAN DARI MATERI (gunakan sebagai referensi gaya):\n' +
      fewShotContext.slice(0, 3).map((c, i) => `[Contoh ${i + 1}]\n${c}`).join('\n---\n');
  }
  return base;
}

// ── Output by access level ────────────────────────────────────────────────────
async function generateOutput(text, level, accessType, conceptId) {
  const normalizedText = normalizer.normalizeSpeech(text);

  if (accessType === 'premium') {
    try {
      const { audioBuffer, mimeType, sampleRate } = await geminiTTS.synthesize(normalizedText);
      const wavBuffer = geminiTTS.pcmToWav(audioBuffer, sampleRate);
      const audioUrl  = `data:audio/wav;base64,${wavBuffer.toString('base64')}`;
      const visemes   = geminiTTS.pcmToVisemes(audioBuffer, sampleRate);
      return { text: normalizedText, audioUrl, visemes, tier: 'premium' };
    } catch {
      return { text: normalizedText, audioUrl: null, visemes: null, tier: 'premium', ttsError: true };
    }
  }

  // Basic: audio pre-generated dari explanations
  if (conceptId) {
    const pregenerated = await db.query(
      `SELECT audio_url FROM explanations
       WHERE concept_id = $1 AND level_id = $2 AND audio_url IS NOT NULL LIMIT 1`,
      [conceptId, level]
    ).catch(() => ({ rows: [] }));
    if (pregenerated.rows.length > 0 && pregenerated.rows[0].audio_url) {
      return { text: normalizedText, audioUrl: pregenerated.rows[0].audio_url, visemes: null, tier: 'basic' };
    }
  }

  // Fallback: level_audio_segments
  const segments = await db.query(
    `SELECT audio_url, viseme_json FROM level_audio_segments
     WHERE level_id = $1 AND audio_url IS NOT NULL
     ORDER BY CASE WHEN segment = 'main' THEN 0 ELSE 1 END, id LIMIT 1`,
    [level]
  ).catch(() => ({ rows: [] }));
  if (segments.rows.length > 0 && segments.rows[0].audio_url) {
    return {
      text: normalizedText, audioUrl: segments.rows[0].audio_url,
      visemes: segments.rows[0].viseme_json || null, tier: 'basic',
    };
  }

  return {
    text: normalizedText, audioUrl: null, visemes: null, tier: 'basic',
    upgradeMessage: `Upgrade ke Premium Level ${level} supaya Kak Cadas bisa jawab langsung pertanyaan ini!`,
  };
}

// ── Cache helpers ─────────────────────────────────────────────────────────────
async function getCached(studentId, question) {
  const { rows } = await db.query(
    `SELECT answer_text, source FROM student_questions
     WHERE student_id = $1 AND LOWER(question_text) = LOWER($2)
     ORDER BY created_at DESC LIMIT 1`,
    [studentId, question]
  );
  return rows.length > 0 ? rows[0] : null;
}

async function cacheAnswer(studentId, question, conceptId, level, source, answerText) {
  const dbSource = source === 'llm' ? 'openrouter' : source;
  if (!['lexical', 'semantic', 'openrouter'].includes(dbSource)) return;
  await db.query(
    `INSERT INTO student_questions (student_id, level_id, question_text, answer_text, source, was_helpful)
     VALUES ($1, $2, $3, $4, $5, false) ON CONFLICT DO NOTHING`,
    [studentId, level, question, answerText, dbSource]
  ).catch(e => console.warn('[RAG] cacheAnswer failed:', e.message));
}

// ── Main Pipeline ─────────────────────────────────────────────────────────────
async function askKak({ studentId, questionText, conceptId, level, accessType }) {

  // Cache exact-match
  const cached = await getCached(studentId, questionText);
  if (cached) {
    return { answer: cached.answer_text, audioUrl: null, source: cached.source, cached: true };
  }

  let answerText     = null;
  let source         = null;
  let fewShotContext = [];
  let llmMeta        = null;
  let ragMissLogged  = false;

  // ── Layer 1: Semantic Search ───────────────────────────────────────────────
  const semantic = await semanticSearch(questionText, level, conceptId);

  if (semantic.hit === 'strong') {
    // Hanya quick_trick yang boleh return langsung sebagai jawaban.
    // quick_trick dirancang sebagai trik/cara cepat yang berdiri sendiri.
    // hint_text dan speech_text adalah soal/konteks — tidak tepat dikembalikan
    // mentah sebagai jawaban karena bisa false positive (angka/konteks beda).
    const quickTrick = semantic.results.find(r => r.chunk_type === 'quick_trick');

    if (quickTrick) {
      answerText = quickTrick.chunk_text;
      source     = 'semantic';
    } else {
      // Strong hit tapi tidak ada quick_trick → pakai sebagai few-shot context
      fewShotContext = semantic.results.slice(0, 3).map(r => r.chunk_text);
    }

  } else if (semantic.hit === 'partial') {
    // Simpan sebagai few-shot context untuk LLM
    fewShotContext = semantic.results.slice(0, 3).map(r => r.chunk_text);

  } else {
    // weak / none — corpus miss, log ke admin
    const topResult = semantic.results?.[0];
    await logRagMiss({
      studentId, level, question: questionText,
      topSim:       topResult ? parseFloat(topResult.similarity) : null,
      topChunkText: topResult?.chunk_text || null,
      llmAnswered:  false,
      llmModel:     null,
    });
    ragMissLogged = true;
  }

  // ── Layer 2+3: LLM (premium only, jika belum ada jawaban) ─────────────────
  if (!answerText && accessType === 'premium') {
    const llmResult = await llmGenerate(questionText, level, conceptId, fewShotContext, studentId);

    if (llmResult.quotaExhausted) {
      return {
        answer: llmResult.message, audioUrl: null,
        source: 'quota_exceeded', quotaExhausted: true, cached: false,
      };
    }

    if (llmResult.hit === 'strong') {
      answerText = llmResult.text;
      source     = 'llm';
      llmMeta    = { model: llmResult.model, layer: llmResult.layer, mathValidation: llmResult.mathValidation };

      // Update log rag_miss jika sebelumnya dicatat sebagai miss
      if (ragMissLogged) {
        await db.query(
          `UPDATE admin_rag_miss
           SET llm_answered = true, llm_model = $1
           WHERE student_id = $2 AND level_id = $3
             AND question_text = $4
             AND created_at > NOW() - INTERVAL '5 seconds'`,
          [llmResult.model, studentId || null, level, questionText]
        ).catch(() => {});
      }
    }
  }

  // ── Tidak ada jawaban ──────────────────────────────────────────────────────
  if (!answerText) {
    const notFound = accessType === 'premium'
      ? 'Maaf, Kak Cadas belum bisa menjawab pertanyaan itu. Coba tanya dengan kata lain ya!'
      : `Belum ada jawaban untuk pertanyaan itu di Level ${level}. Coba tanya dengan kata lain, atau upgrade ke Premium untuk jawaban langsung dari Kak Cadas!`;

    await cacheAnswer(studentId, questionText, conceptId, level, 'none', notFound).catch(() => {});
    return { answer: notFound, audioUrl: null, source: 'none', cached: false };
  }

  // ── Output: normalize + TTS ────────────────────────────────────────────────
  const output = await generateOutput(answerText, level, accessType, conceptId);
  await cacheAnswer(studentId, questionText, conceptId, level, source, output.text);

  return {
    answer:         output.text,
    audioUrl:       output.audioUrl,
    visemes:        output.visemes        || null,
    source,
    tier:           output.tier,
    upgradeMessage: output.upgradeMessage || null,
    ttsError:       output.ttsError       || null,
    llmMeta,
    cached:         false,
  };
}

// ── Health checks ─────────────────────────────────────────────────────────────
async function checkOllamaHealth() {
  try {
    const vec = await generateEmbedding('test');
    return { ok: vec !== null, dim: vec?.length || 0, model: OLLAMA_MODEL };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  askKak,
  semanticSearch,
  llmGenerate,
  generateEmbedding,
  checkOllamaHealth,
  // alias lama untuk kompatibilitas route yang sudah ada
  openRouterFallback: llmGenerate,
  llmFallback:        llmGenerate,
  normalizeOutput:    (t) => normalizer.normalizeSpeech(t),
  generateOutput,
};

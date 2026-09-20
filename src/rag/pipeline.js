/**
 * RAG Pipeline â€” 5-layer hybrid (v2 â€” 15 Sep 2026)
 *
 * Layer 1 : Lexical Search  (ILIKE + JS scoring)
 * Layer 2 : Semantic Search (pgvector BGE-M3 1024-dim)
 * Layer 3 : LLM primary  â€” Gemini direct (200 key, gemini-client.js)
 * Layer 4 : LLM fallback â€” OpenRouter generateWithFallback() (93 key)
 * Post-LLM: math-validator (mathjs + soal-cerita.js) â€” verifikasi & koreksi
 * Layer 5 : Normalize â†’ Output by access level
 *
 * Perubahan dari v1:
 *   - LLM: Gemini direct JADI primary (200 key), OpenRouter jadi fallback
 *   - Post-LLM: validateWithWordProblem() menggantikan validateMathAnswer()
 *     untuk soal cerita (Layer A regex + Layer B stem)
 */

'use strict';

const crypto     = require('crypto');
const http       = require('http');
const db         = require('../database/db');
const normalizer = require('./normalizer');
const openrouter = require('./openrouter-client');
const geminiTTS  = require('./gemini-tts');
const {
  validateMathAnswer,
  validateWithWordProblem,
} = require('./math-validator');

// Gemini direct client (primary LLM â€” 200 key)
let gemini = null;
try {
  gemini = require('./gemini-client');
} catch {
  console.warn('[RAG] gemini-client.js tidak ditemukan â€” Layer 3 Gemini direct dinonaktifkan');
}

// Konfigurasi embedding Ollama (BGE-M3 1024-dim)
const OLLAMA_HOST   = process.env.OLLAMA_HOST        || 'localhost';
const OLLAMA_PORT   = parseInt(process.env.OLLAMA_PORT || '11434', 10);
const OLLAMA_MODEL  = process.env.OLLAMA_EMBED_MODEL || 'bge-m3';
const EMBED_DIM     = 1024;
const EMBED_TIMEOUT = parseInt(process.env.OLLAMA_TIMEOUT_MS || '15000', 10);

// Threshold cosine similarity BGE-M3 (dikalibrasi dari backtest Agustus 2026)
const SIM_STRONG  = parseFloat(process.env.RAG_SIM_STRONG  || '0.55');
const SIM_PARTIAL = parseFloat(process.env.RAG_SIM_PARTIAL || '0.40');
const SEM_TOP_K   = parseInt(process.env.RAG_SEM_TOP_K     || '5', 10);

// ============================================================
// Embedding via BGE-M3 Ollama
// ============================================================

/**
 * generateEmbedding(text) â†’ number[] | null
 * Embed teks via BGE-M3 Ollama lokal, return vector 1024-dim.
 */
async function generateEmbedding(text) {
  const truncated = String(text || '').slice(0, 512).trim();
  if (!truncated) return null;

  return new Promise((resolve) => {
    const body = JSON.stringify({ model: OLLAMA_MODEL, prompt: truncated });
    const req  = http.request(
      {
        hostname: OLLAMA_HOST,
        port:     OLLAMA_PORT,
        path:     '/api/embeddings',
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: EMBED_TIMEOUT,
      },
      res => {
        let raw = '';
        res.on('data', c => (raw += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (!parsed.embedding || parsed.embedding.length !== EMBED_DIM) return resolve(null);
            resolve(parsed.embedding);
          } catch { resolve(null); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error',   () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ============================================================
// Layer 1: Lexical Search
// ============================================================
async function lexicalSearch(question, level, conceptId) {
  const normalizedQ = question.toLowerCase().trim();

  if (conceptId) {
    const byConcept = await db.query(
      `SELECT id, concept_id, level_id, content, audio_url, viseme_json
       FROM explanations WHERE concept_id = $1 AND level_id = $2
       ORDER BY created_at DESC LIMIT 5`,
      [conceptId, level]
    );
    if (byConcept.rows.length > 0) {
      return { hit: 'strong', source: 'lexical', results: byConcept.rows };
    }
  }

  const fuzzy = await db.query(
    `SELECT id, concept_id, level_id, content, audio_url, viseme_json, variants
     FROM explanations
     WHERE level_id = $1 AND (content ILIKE $2 OR variants::text ILIKE $2)
     ORDER BY created_at DESC LIMIT 20`,
    [level, `%${normalizedQ}%`]
  );

  const words = normalizedQ.split(/\s+/).filter(w => w.length >= 3);
  let best = null, bestRatio = 0, bestText = null;

  for (const row of fuzzy.rows) {
    const candidates = [{ text: row.content, style: 'main' }];
    if (row.variants) {
      try {
        const arr = typeof row.variants === 'string' ? JSON.parse(row.variants) : row.variants;
        (arr || []).forEach((v, i) => {
          if (v && v.content) candidates.push({ text: v.content, style: v.explanation_style || ('variant_' + i) });
        });
      } catch (_) { /* skip */ }
    }
    for (const c of candidates) {
      const lower   = c.text.toLowerCase();
      const matched = words.filter(w => lower.includes(w)).length;
      const ratio   = words.length > 0 ? matched / words.length : 0;
      if (ratio > bestRatio) { bestRatio = ratio; best = row; bestText = c.text; }
    }
  }

  if (best && bestRatio >= 0.6) {
    best.matchedText = bestText;
    return { hit: 'strong', source: 'lexical', results: [best], similarity: bestRatio };
  }

  return { hit: 'weak', source: 'lexical', results: fuzzy.rows };
}

// ============================================================
// Layer 2: Semantic Search (BGE-M3 1024-dim)
// ============================================================

/**
 * semanticSearch(question, level, conceptId) â†’ SemanticResult
 * Baca langsung dari explanations_embedding.chunk_text (bukan JOIN ke explanations).
 * Corpus: ~16.244 chunks dari exercises + explanations.
 * Priority: quick_trick > hint_text > speech_text > explanation
 */
async function semanticSearch(question, level, conceptId) {
  if (process.env.RAG_SEMANTIC_ENABLED !== 'true') {
    return { hit: 'none', source: 'semantic', results: [], reason: 'semantic search disabled' };
  }
  try {
    const vectorCheck = await db.query(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'"
    );
    if (vectorCheck.rows.length === 0) {
      return { hit: 'none', source: 'semantic', results: [], reason: 'pgvector not available' };
    }

    const embedding = await generateEmbedding(question);
    if (!embedding) {
      return { hit: 'none', source: 'semantic', results: [], reason: 'embedding failed' };
    }

    const semantic = await db.query(
      `SELECT
         ee.chunk_text,
         ee.chunk_type,
         ee.concept_id,
         ee.exercise_id,
         ee.level_id,
         1 - (ee.embedding <=> $1::vector(1024)) AS similarity
       FROM explanations_embedding ee
       WHERE ee.level_id = $2
         AND ee.embedding_ready = true
       ORDER BY
         ee.embedding <=> $1::vector(1024),
         CASE ee.chunk_type
           WHEN 'quick_trick' THEN 1
           WHEN 'hint_text'   THEN 2
           WHEN 'speech_text' THEN 3
           ELSE 4
         END
       LIMIT $3`,
      [JSON.stringify(embedding), level, SEM_TOP_K]
    );

    if (semantic.rows.length === 0) {
      return { hit: 'none', source: 'semantic', results: [] };
    }

    const topSim = parseFloat(semantic.rows[0].similarity);

    if (topSim >= SIM_STRONG)  return { hit: 'strong',  source: 'semantic', results: semantic.rows, similarity: topSim };
    if (topSim >= SIM_PARTIAL) return { hit: 'partial', source: 'semantic', results: semantic.rows, similarity: topSim };
    return                            { hit: 'weak',    source: 'semantic', results: semantic.rows, similarity: topSim };

  } catch (err) {
    console.error('[RAG] semanticSearch error:', err.message);
    return { hit: 'none', source: 'semantic', results: [], reason: err.message };
  }
}

// ============================================================
// Layer 3+4: LLM Fallback
// Primary  : Gemini direct (200 key, gemini-client.js)
// Fallback : OpenRouter generateWithFallback() (93 key)
// ============================================================
async function llmFallback(question, level, conceptId, fewShotContext, studentId) {
  const anyLLMAvailable = (gemini && gemini.available) || openrouter.available;
  if (!anyLLMAvailable) {
    return { hit: 'none', source: 'llm', reason: 'No LLM configured' };
  }

  // Cek quota harian
  const quota = await db.query(
    `SELECT attempted_today, daily_limit FROM student_level_quota
     WHERE student_id = $1 AND current_level = $2`,
    [studentId, level]
  );
  if (quota.rows.length > 0 && quota.rows[0].attempted_today >= quota.rows[0].daily_limit) {
    return {
      hit: 'none', source: 'llm', reason: 'Quota exceeded',
      quotaExhausted: true,
      message: 'Batas tanya hari ini sudah tercapai. Coba lagi besok ya!',
    };
  }

  const systemPrompt = buildSystemPrompt(level, conceptId, fewShotContext);

  let text  = null;
  let model = null;
  let layer = null;

  // â”€â”€ Layer 3: Gemini direct (primary â€” 200 key rotasi) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (gemini && gemini.available) {
    try {
      const result = await gemini.generate(question, {
        system:    systemPrompt,
        maxTokens: 512,
      });
      text  = result.text;
      model = result.model;
      layer = 3;
    } catch (err) {
      console.warn(`[RAG] Layer 3 Gemini gagal: ${err.message}. Coba Layer 4 OpenRouter...`);
    }
  }

  // â”€â”€ Layer 4: OpenRouter (fallback â€” 93 key, generateWithFallback) â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!text && openrouter.available) {
    try {
      const result = await openrouter.generateWithFallback(question, {
        system:      systemPrompt,
        temperature: 0.4,
        maxTokens:   512,
      });
      text  = result.text;
      model = result.model;
      layer = result.layer;
    } catch (err) {
      console.error(`[RAG] Layer 4 OpenRouter juga gagal: ${err.message}`);
    }
  }

  if (!text) {
    return { hit: 'none', source: 'llm', reason: 'All LLM layers failed' };
  }

  // â”€â”€ Post-LLM Math Validator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Coba validateWithWordProblem (soal cerita aware) dulu,
  // fallback ke validateMathAnswer (ekspresi matematika eksplisit).
  let validation = validateWithWordProblem(text, question);
  if (!validation.validated) {
    validation = validateMathAnswer(text, question);
  }
  const finalText = validation.validated ? validation.llmText : text;
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // Update quota harian
  try {
    await db.query(
      `INSERT INTO student_level_quota
         (student_id, current_level, attempted_today, daily_limit, is_premium)
       VALUES ($1, $2, 1, 40, true)
       ON CONFLICT (student_id, current_level)
       DO UPDATE SET attempted_today = student_level_quota.attempted_today + 1`,
      [studentId, level]
    );
  } catch (qErr) {
    console.warn('[RAG] quota update failed:', qErr.message);
  }

  // Log biaya LLM
  // Gemini direct: ~$0.10/M in + $0.40/M out â‰ˆ $0.0001/call
  // OpenRouter gpt-4o-mini: ~$0.0002/call
  // OpenRouter gemini-lite: ~$0.0001/call
  const estimatedCost = layer === 3 ? 0.0001 : 0.0002;
  try {
    await db.query(
      `INSERT INTO llm_usage_log (student_id, level_id, model, estimated_cost_usd)
       VALUES ($1, $2, $3, $4)`,
      [studentId, level, model, estimatedCost]
    );
  } catch (logErr) {
    console.warn('[RAG] llm_usage_log insert failed:', logErr.message);
  }

  return {
    hit: 'strong', source: 'llm',
    text: finalText, model, layer,
    mathValidation: validation.validated ? {
      correct:       validation.correct,
      correctAnswer: validation.correctAnswer,
      expr:          validation.expr,
      confidence:    validation.confidence,
      tier:          validation.tier,
    } : null,
  };
}

// ============================================================
// Layer 5a: Normalization
// ============================================================
function normalizeOutput(text) {
  return normalizer.normalizeSpeech(text);
}

// ============================================================
// Layer 5b: Output by Access Level
// ============================================================
async function generateOutput(text, level, accessType, conceptId) {
  const normalizedText = normalizeOutput(text);

  if (accessType === 'premium') {
    try {
      const TTS_HARD_TIMEOUT_MS = parseInt(process.env.GEMINI_TTS_TIMEOUT_MS || '25000', 10) + 5000;
      const { audioBuffer, sampleRate } = await Promise.race([
        geminiTTS.synthesize(normalizedText),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TTS hard timeout')), TTS_HARD_TIMEOUT_MS)),
      ]);
      const wavBuffer = geminiTTS.pcmToWav(audioBuffer, sampleRate);
      const audioUrl  = `data:audio/wav;base64,${wavBuffer.toString('base64')}`;
      const visemes   = geminiTTS.pcmToVisemes(audioBuffer, sampleRate);
      return { text: normalizedText, audioUrl, visemes, tier: 'premium' };
    } catch (ttsErr) {
      console.warn('[RAG] generateOutput TTS gagal/timeout:', ttsErr.message);
      return { text: normalizedText, audioUrl: null, visemes: null, tier: 'premium', ttsError: true };
    }
  }

  if (conceptId) {
    const pregenerated = await db.query(
      `SELECT audio_url FROM explanations
       WHERE concept_id = $1 AND level_id = $2 AND audio_url IS NOT NULL LIMIT 1`,
      [conceptId, level]
    );
    if (pregenerated.rows.length > 0 && pregenerated.rows[0].audio_url) {
      return { text: normalizedText, audioUrl: pregenerated.rows[0].audio_url, visemes: null, tier: 'basic' };
    }
  }

  try {
    const segments = await db.query(
      `SELECT audio_url, viseme_json FROM level_audio_segments
       WHERE level_id = $1 AND audio_url IS NOT NULL
       ORDER BY CASE WHEN segment = 'main' THEN 0 ELSE 1 END, id LIMIT 1`,
      [level]
    );
    if (segments.rows.length > 0 && segments.rows[0].audio_url) {
      return {
        text: normalizedText, audioUrl: segments.rows[0].audio_url,
        visemes: segments.rows[0].viseme_json || null, tier: 'basic',
      };
    }
  } catch (segErr) {
    console.warn('[RAG] level_audio_segments fallback failed:', segErr.message);
  }

  return {
    text: normalizedText, audioUrl: null, visemes: null, tier: 'basic',
    upgradeMessage: `Upgrade ke Premium Level ${level} supaya Kak Cadas bisa jawab langsung pertanyaan ini!`,
  };
}

// ============================================================
// Main Pipeline Orchestrator
// ============================================================
async function askKak({ studentId, questionText, conceptId, level, accessType }) {
  var tAsk = Date.now();
  var sidShort = String(studentId || '?').slice(0, 8);
  var logStage = function(stage, extra) {
    extra = extra || '';
    console.log('[RAG][askKak] stage=' + stage + ' student=' + sidShort + ' level=' + level + ' access=' + accessType + ' ms=' + (Date.now() - tAsk) + (extra ? ' ' + extra : ''));
  };
  logStage('start', 'q=' + String(questionText || '').slice(0, 60));
  const questionHash = crypto.createHash('sha256').update(questionText.toLowerCase().trim()).digest('hex');

  // Cache check
  const cached = await db.query(
    `SELECT answer_text, source FROM student_questions
     WHERE student_id = $1 AND LOWER(question_text) = LOWER($2)
     ORDER BY created_at DESC LIMIT 1`,
    [studentId, questionText]
  );
  if (cached.rows.length > 0) {
    const cachedAnswer = cached.rows[0].answer_text;
    const cachedSource = cached.rows[0].source;
    if (accessType === 'premium' && cachedAnswer) {
      // Premium: re-generate TTS agar audio tetap ada meski dari cache
      const cachedOutput = await generateOutput(cachedAnswer, level, 'premium', conceptId);
      return { answer: cachedAnswer, audioUrl: cachedOutput.audioUrl, visemes: cachedOutput.visemes, source: cachedSource, cached: true };
    }
    return { answer: cachedAnswer, audioUrl: null, source: cachedSource, cached: true };
  }

  let answerText     = null;
  let source         = null;
  let fewShotContext = [];
  let llmMeta        = null;

  // â”€â”€ Step 1: Lexical Search â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const lexical = await lexicalSearch(questionText, level, conceptId);
  logStage('layer1-lexical', 'found=' + lexical.found);
  if (lexical.hit === 'strong') {
    answerText = lexical.results[0].matchedText || lexical.results[0].content;
    source     = 'lexical';
  }

  // â”€â”€ Step 2: Semantic Search (BGE-M3) â€” PRIMARY SOURCE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!answerText) {
    const semantic = await semanticSearch(questionText, level, conceptId);
    logStage('layer2-semantic', 'found=' + semantic.found);
    if (semantic.hit === 'strong') {
      const best = chooseBestChunk(semantic.results);
      answerText = best ? best.chunk_text : semantic.results[0].chunk_text;
      source     = 'semantic';
    } else if (semantic.hit === 'partial') {
      fewShotContext = semantic.results.slice(0, 3).map(r => r.chunk_text);
    }
  }

  // â”€â”€ Step 3+4: LLM Fallback (premium only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!answerText && accessType === 'premium') {
    const llmResult = await llmFallback(questionText, level, conceptId, fewShotContext, studentId);
    logStage('layer34-llm', 'quotaExhausted=' + (llmResult.quotaExhausted || false) + ' layer=' + (llmResult.layer || '-') + ' model=' + (llmResult.model || '-'));

    if (llmResult.quotaExhausted) {
      return { answer: llmResult.message, audioUrl: null, source: 'quota_exceeded', quotaExhausted: true, cached: false };
    }

    if (llmResult.hit === 'strong') {
      answerText = llmResult.text;
      source     = 'llm';
      llmMeta    = { model: llmResult.model, layer: llmResult.layer, mathValidation: llmResult.mathValidation };
    }
  }

  // â”€â”€ Tidak ada jawaban â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!answerText) {
    if (accessType !== 'premium') {
      const notFoundMsg = `Belum ada jawaban untuk pertanyaan itu di Level ${level}. Coba tanya dengan kata lain, atau upgrade ke Premium untuk jawaban langsung dari Kak Cadas!`;
      await cacheQuestion(studentId, questionText, questionHash, conceptId, level, 'none', notFoundMsg, null, false);
      return { answer: notFoundMsg, audioUrl: null, source: 'none', cached: false };
    }
    answerText = 'Maaf, Kak Cadas belum bisa menjawab pertanyaan itu. Coba tanya dengan kata lain ya!';
    source     = 'fallback';
  }

  // â”€â”€ Step 5: Normalize + Output â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  logStage('layer5-output', 'len=' + String(answerText || '').length);
  const output = await generateOutput(answerText, level, accessType, conceptId);
  await cacheQuestion(studentId, questionText, questionHash, conceptId, level, source, output.text, output.audioUrl, accessType === 'premium');

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

// ============================================================
// Helpers
// ============================================================

/**
 * Pilih chunk terbaik: quick_trick > hint_text > speech_text.
 * Tidak drop chunk yang similaritasnya turun >0.05 dari top.
 */
function chooseBestChunk(rows) {
  if (!rows || rows.length === 0) return null;
  const TYPE_PRIORITY = { quick_trick: 1, hint_text: 2, speech_text: 3 };
  const topSim = parseFloat(rows[0].similarity || 0);
  let best = rows[0], bestScore = Infinity;
  for (const row of rows) {
    const sim  = parseFloat(row.similarity || 0);
    if (topSim - sim > 0.05) break;
    const score = TYPE_PRIORITY[row.chunk_type] || 4;
    if (score < bestScore) { bestScore = score; best = row; }
  }
  return best;
}

async function cacheQuestion(studentId, questionText, questionHash, conceptId, level, source, answerText, audioUrl, isPremium) {
  const dbSource = source === 'llm' ? 'openrouter' : source;
  if (!['lexical', 'semantic', 'openrouter'].includes(dbSource)) return;
  try {
    await db.query(
      `INSERT INTO student_questions (student_id, level_id, question_text, answer_text, source, was_helpful)
       VALUES ($1, $2, $3, $4, $5, false)
       ON CONFLICT DO NOTHING`,
      [studentId, level, questionText, answerText, dbSource]
    );
  } catch (cErr) {
    console.warn('[RAG] cacheQuestion failed:', cErr.message);
  }
}

function buildSystemPrompt(level, conceptId, fewShotContext = []) {
  const base = `Kamu adalah Kak Cadas, tutor matematika untuk siswa SD di Indonesia.

ATURAN WAJIB:
1. Jawab HANYA pertanyaan matematika Level ${level}. Tolak sopan jika di luar topik matematika.
2. Gunakan bahasa Indonesia sederhana, mudah dipahami anak SD.
3. Jelaskan LANGKAH-LANGKAH penyelesaian â€” jangan langsung sebut jawaban akhir di awal.
4. Semua kalkulasi HARUS 100% benar. Hitung ulang sebelum menulis angka.
5. Jika ada trik cepat GASING, sebutkan sebagai opsi.
6. Untuk soal cerita: bantu siswa pahami yang diketahui dan ditanyakan dulu.
7. Respons singkat dan padat â€” maksimal 150 kata. Tidak perlu basa-basi panjang.
8. DILARANG mengarang angka atau hasil yang tidak dihitung dengan benar.`;

  if (fewShotContext.length > 0) {
    return base + '\n\nKonteks relevan dari materi:\n' + fewShotContext.slice(0, 3).join('\n---\n');
  }
  return base;
}

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
  lexicalSearch,
  semanticSearch,
  llmFallback,
  llmGenerate: llmFallback,          // alias: pipeline trial lama memanggil llmGenerate()
  openRouterFallback: llmFallback,  // alias kompatibilitas
  normalizeOutput,
  generateOutput,
  generateEmbedding,
  checkOllamaHealth,
};

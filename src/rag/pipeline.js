/**
 * RAG Pipeline — 5-layer hybrid: Lexical → Semantic → OpenRouter → Normalize → Output
 * Implements FASE 8 of final_plan_v1.1.md
 */

const crypto = require('crypto');
const db = require('../database/db');
const normalizer = require('./normalizer');
const openrouter = require('./openrouter-client');
const geminiTTS = require('./gemini-tts');

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

  // pg_trgm TIDAK terpasang di DB aktual (Sprint B) — pakai ILIKE + scoring JS.
  // Teks skenario ada di kolom JSON `variants` (gasing/pmri/quick), bukan hanya di
  // `content` (main explanation) — jadi keduanya ikut dicari.
  const fuzzy = await db.query(
    `SELECT id, concept_id, level_id, content, audio_url, viseme_json, variants
     FROM explanations
     WHERE level_id = $1 AND (content ILIKE $2 OR variants::text ILIKE $2)
     ORDER BY created_at DESC LIMIT 20`,
    [level, `%${normalizedQ}%`]
  );

  // Scoring JS: rasio kata pertanyaan (>=3 huruf) yang muncul di konten,
  // dievaluasi terhadap content DAN setiap varian di kolom variants.
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
      } catch (e) { /* variants rusak — lewati */ }
    }
    for (const c of candidates) {
      const lower = c.text.toLowerCase();
      const matched = words.filter(w => lower.includes(w)).length;
      const ratio = words.length > 0 ? matched / words.length : 0;
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
// Layer 2: Semantic Search
// ============================================================
async function semanticSearch(question, level, conceptId, threshold = 0.20) {
  // Threshold dikalibrasi untuk hashing-trick embedder (Sprint B):
  // pertanyaan terkait ~0.28-0.50, tidak terkait ~0.03-0.06.
  // Revisit saat mengganti ke model embedder nyata.
  try {
    const vectorCheck = await db.query(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'"
    );
    if (vectorCheck.rows.length === 0) {
      return { hit: 'none', source: 'semantic', results: [], reason: 'pgvector not available' };
    }

    const embedding = await generateEmbedding(question);

    const semantic = await db.query(
      `SELECT e.id, e.concept_id, e.level_id, e.content, e.audio_url, e.viseme_json,
              1 - (ee.embedding <=> $1) AS similarity
       FROM explanations_embedding ee
       JOIN explanations e ON e.id = ee.explanation_id
       WHERE ee.level_id = $2
       ORDER BY ee.embedding <=> $1
       LIMIT 5`,
      [JSON.stringify(embedding), level]
    );

    if (semantic.rows.length === 0) {
      return { hit: 'none', source: 'semantic', results: [] };
    }

    const topSim = semantic.rows[0].similarity;
    if (topSim >= 0.25) {
      return { hit: 'strong', source: 'semantic', results: semantic.rows, similarity: topSim };
    } else if (topSim >= threshold) {
      return { hit: 'partial', source: 'semantic', results: semantic.rows, similarity: topSim };
    }

    return { hit: 'weak', source: 'semantic', results: semantic.rows, similarity: topSim };
  } catch (err) {
    return { hit: 'none', source: 'semantic', results: [], reason: err.message };
  }
}
// ============================================================
// Layer 3: OpenRouter Fallback (Premium only)
// ============================================================
async function openRouterFallback(question, level, conceptId, fewShotContext, studentId) {
  if (!openrouter.available) {
    return { hit: 'none', source: 'openrouter', reason: 'OpenRouter not configured' };
  }

  // Skema aktual student_level_quota: current_level, attempted_today, daily_limit. Sprint B.
  const quota = await db.query(
    `SELECT attempted_today, daily_limit FROM student_level_quota
     WHERE student_id = $1 AND current_level = $2`,
    [studentId, level]
  );

  if (quota.rows.length > 0 && quota.rows[0].attempted_today >= quota.rows[0].daily_limit) {
    return { hit: 'none', source: 'openrouter', reason: 'Quota exceeded' };
  }

  const systemPrompt = buildSystemPrompt(level, conceptId, fewShotContext);

  try {
    const result = await openrouter.generate(question, {
      system: systemPrompt,
      temperature: 0.7,
      maxTokens: 512,
    });

    // ON CONFLICT pakai unique key aktual: (student_id, current_level). Sprint B.
    await db.query(
      `INSERT INTO student_level_quota (student_id, current_level, attempted_today, daily_limit, is_premium)
       VALUES ($1, $2, 1, 40, true)
       ON CONFLICT (student_id, current_level)
       DO UPDATE SET attempted_today = student_level_quota.attempted_today + 1`,
      [studentId, level]
    );

    // Tabel openrouter_cost_log TIDAK ADA di DB aktual — pakai llm_usage_log
    // (kolom: student_id, level_id, model, estimated_cost_usd). Sprint B.
    try {
      await db.query(
        `INSERT INTO llm_usage_log (student_id, level_id, model, estimated_cost_usd)
         VALUES ($1, $2, $3, 0)`,
        [studentId, level, result.model]
      );
    } catch (logErr) {
      console.warn('[RAG] llm_usage_log insert failed:', logErr.message);
    }

    return { hit: 'strong', source: 'openrouter', text: result.text, model: result.model };
  } catch (err) {
    return { hit: 'none', source: 'openrouter', reason: err.message };
  }
}
// ============================================================
// Layer 4: Normalization
// ============================================================
function normalizeOutput(text) {
  return normalizer.normalizeSpeech(text);
}

// ============================================================
// Layer 5: Output by Access Level
// ============================================================
async function generateOutput(text, level, accessType, conceptId) {
  const normalizedText = normalizeOutput(text);

  if (accessType === 'premium') {
    try {
      // Sprint G.2 — sample rate aktual dari response Gemini TTS (bukan hardcode),
      // dipakai untuk WAV header & pcmToVisemes agar timeline viseme presisi.
      const { audioBuffer, mimeType, sampleRate } = await geminiTTS.synthesize(normalizedText);
      const wavBuffer = geminiTTS.pcmToWav(audioBuffer, sampleRate);
      const audioUrl = `data:audio/wav;base64,${wavBuffer.toString('base64')}`;
      // Sprint G.2 — viseme dari energi RMS PCM (format identik Rhubarb
      // { mouthCues: [{start,end,value}] }) → BotCharacter lip-sync sinkron.
      const visemes = geminiTTS.pcmToVisemes(audioBuffer, sampleRate);
      return { text: normalizedText, audioUrl, visemes, tier: 'premium' };
    } catch {
      return { text: normalizedText, audioUrl: null, visemes: null, tier: 'premium', ttsError: true };
    }
  }

  // Basic tier: look for pregenerated audio
  if (conceptId) {
    const pregenerated = await db.query(
      `SELECT audio_url FROM explanations
       WHERE concept_id = $1 AND level_id = $2 AND audio_url IS NOT NULL
       LIMIT 1`,
      [conceptId, level]
    );
    if (pregenerated.rows.length > 0 && pregenerated.rows[0].audio_url) {
      return {
        text: normalizedText,
        audioUrl: pregenerated.rows[0].audio_url,
        visemes: null,
        tier: 'basic',
        upgradeMessage: null,
      };
    }
  }

  // Sprint G.1 — fallback ke level_audio_segments: audio pre-generated per level
  // (+ viseme Rhubarb) walau explanations.audio_url tidak terisi ETL.
  // Segmen 'main' diprioritaskan; jika tidak ada, segmen pertama.
  try {
    const segments = await db.query(
      `SELECT audio_url, viseme_json
       FROM level_audio_segments
       WHERE level_id = $1 AND audio_url IS NOT NULL
       ORDER BY CASE WHEN segment = 'main' THEN 0 ELSE 1 END, id
       LIMIT 1`,
      [level]
    );
    if (segments.rows.length > 0 && segments.rows[0].audio_url) {
      return {
        text: normalizedText,
        audioUrl: segments.rows[0].audio_url,
        visemes: segments.rows[0].viseme_json || null,
        tier: 'basic',
        upgradeMessage: null,
      };
    }
  } catch (segErr) {
    console.warn('[RAG] level_audio_segments fallback failed:', segErr.message);
  }

  return {
    text: normalizedText,
    audioUrl: null,
    visemes: null,
    tier: 'basic',
    upgradeMessage: `Upgrade ke Premium Level ${level} supaya Kak Cadas bisa jawab langsung pertanyaan ini!`,
  };
}
// ============================================================
// Main Pipeline Orchestrator
// ============================================================
async function askKak({ studentId, questionText, conceptId, level, accessType }) {
  const questionHash = crypto.createHash('sha256').update(questionText.toLowerCase().trim()).digest('hex');

  // Skema aktual student_questions: TIDAK ada kolom question_hash —
  // cache via exact-match pertanyaan (case-insensitive). Sprint B.
  const cached = await db.query(
    `SELECT answer_text, source FROM student_questions
     WHERE student_id = $1 AND LOWER(question_text) = LOWER($2)
     ORDER BY created_at DESC LIMIT 1`,
    [studentId, questionText]
  );

  if (cached.rows.length > 0) {
    return {
      answer: cached.rows[0].answer_text,
      audioUrl: null,
      source: cached.rows[0].source,
      cached: true,
    };
  }

  let answerText = null;
  let source = null;
  let fewShotContext = [];

  // Step 1: Lexical Search
  const lexical = await lexicalSearch(questionText, level, conceptId);
  if (lexical.hit === 'strong') {
    answerText = lexical.results[0].matchedText || lexical.results[0].content;
    source = 'lexical';
  }

  // Step 2: Semantic Search
  if (!answerText) {
    const semantic = await semanticSearch(questionText, level, conceptId);
    if (semantic.hit === 'strong') {
      answerText = semantic.results[0].content;
      source = 'semantic';
    } else if (semantic.hit === 'partial') {
      fewShotContext = semantic.results.map(r => r.content);
    }
  }

  // Step 3: OpenRouter Fallback (Premium only)
  if (!answerText && accessType === 'premium') {
    const orResult = await openRouterFallback(questionText, level, conceptId, fewShotContext, studentId);
    if (orResult.hit === 'strong') {
      answerText = orResult.text;
      source = 'openrouter';
    }
  }

  // If still no answer
  if (!answerText) {
    if (accessType !== 'premium') {
      const notFoundMsg = `Belum ada jawaban untuk pertanyaan itu di Level ${level}. Coba tanya dengan kata lain, atau upgrade ke Premium untuk jawaban langsung dari Kak Cadas!`;
      await cacheQuestion(studentId, questionText, questionHash, conceptId, level, 'none', notFoundMsg, null, false);
      return { answer: notFoundMsg, audioUrl: null, source: 'none', cached: false };
    }
    answerText = 'Maaf, Kak Cadas belum bisa menjawab pertanyaan itu. Coba tanya dengan kata lain ya!';
    source = 'fallback';
  }

  // Step 4 & 5: Normalize + Output
  const output = await generateOutput(answerText, level, accessType, conceptId);

  // Cache the result
  await cacheQuestion(studentId, questionText, questionHash, conceptId, level, source, output.text, output.audioUrl, accessType === 'premium');

  return {
    answer: output.text,
    audioUrl: output.audioUrl,
    visemes: output.visemes || null,
    source,
    tier: output.tier,
    upgradeMessage: output.upgradeMessage || null,
    // Sprint G.2 — forward ttsError supaya client tahu TTS gagal (audio null)
    // bukan karena premium off (tier tetap premium), tapi karena sintetizador.
    ttsError: output.ttsError || null,
    cached: false,
  };
}

// ============================================================
// Helper Functions
// ============================================================
async function cacheQuestion(studentId, questionText, questionHash, conceptId, level, source, answerText, audioUrl, isPremium) {
  // Skema aktual student_questions: student_id, level_id, question_text,
  // answer_text, source, llm_model, response_time_ms, was_helpful. Sprint B.
  // CHECK constraint: source hanya boleh 'lexical'|'semantic'|'openrouter' —
  // jawaban generik (none/fallback) tidak di-cache.
  if (!['lexical', 'semantic', 'openrouter'].includes(source)) {
    return;
  }
  await db.query(
    `INSERT INTO student_questions (student_id, level_id, question_text, answer_text, source, was_helpful)
     VALUES ($1, $2, $3, $4, $5, false)`,
    [studentId, level, questionText, answerText, source]
  );
}

function buildSystemPrompt(level, conceptId, fewShotContext) {
  const basePrompt = `Kamu adalah Kak Cadas, tutor matematika yang sabar dan ramah untuk siswa SD di Indonesia.
Aturan:
1. Jawab HANYA pertanyaan matematika yang sesuai Level ${level}.
2. Tolak sopan jika pertanyaan di luar topik matematika: "Kak Cadas hanya bisa bantu soal matematika ya. Coba tanya yang lain!"
3. Gunakan bahasa Indonesia yang sederhana dan mudah dipahami anak SD.
4. Jelaskan langkah-langkah dengan jelas, jangan langsung kasih jawaban akhir.
5. Jika ada trik cepat (GASING), sebutkan sebagai pilihan, bukan paksaan.
6. Untuk soal cerita, bantu siswa memahami apa yang diketahui dan ditanyakan terlebih dahulu.`;

  if (fewShotContext.length > 0) {
    return basePrompt + '\n\nContoh penjelasan yang relevan:\n' + fewShotContext.slice(0, 3).join('\n---\n');
  }

  return basePrompt;
}

async function generateEmbedding(text) {
  // Hashing-trick embedding (MVP placeholder) — Sprint B:
  // bag-of-words per token ke 384 dim (kolom DB aktual: vector(384)), 3 hash
  // functions per token, L2-normalize. Teks yang berbagi kosakata menghasilkan
  // cosine similarity tinggi, jadi layer semantic benar-benar berfungsi.
  // Ganti dengan model embedder nyata (transformers.js / Gemini embedding)
  // di produksi — ukuran vektor harus tetap 384 atau migrasi kolom.
  const DIM = 384;
  const vec = new Array(DIM).fill(0);
  const tokens = String(text || '').toLowerCase().match(/[a-z0-9\u00C0-\u024F]+/g) || [];
  for (const tok of tokens) {
    for (let k = 0; k < 3; k++) {
      const h = crypto.createHash('md5').update(tok + '#' + k).digest();
      const idx = ((h[0] << 8) | h[1]) % DIM;
      const sign = (h[2] & 1) === 0 ? 1 : -1;
      vec[idx] += sign;
    }
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? vec.map(v => v / norm) : vec;
}

module.exports = {
  askKak,
  lexicalSearch,
  semanticSearch,
  openRouterFallback,
  normalizeOutput,
  generateOutput,
  generateEmbedding,
};

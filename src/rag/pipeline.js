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

  const fuzzy = await db.query(
    `SELECT id, concept_id, level_id, content, audio_url, viseme_json,
            similarity(content, $1) AS sim
     FROM explanations
     WHERE level_id = $2 AND content ILIKE $3
     ORDER BY sim DESC LIMIT 5`,
    [normalizedQ, level, `%${normalizedQ}%`]
  );

  if (fuzzy.rows.length > 0 && fuzzy.rows[0].sim > 0.3) {
    return { hit: 'strong', source: 'lexical', results: fuzzy.rows };
  }

  return { hit: 'weak', source: 'lexical', results: fuzzy.rows };
}

// ============================================================
// Layer 2: Semantic Search
// ============================================================
async function semanticSearch(question, level, conceptId, threshold = 0.6) {
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
    if (topSim >= 0.85) {
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

  const quota = await db.query(
    `SELECT llm_calls_used, llm_calls_limit FROM student_level_quota
     WHERE student_id = $1 AND level = $2`,
    [studentId, level]
  );

  if (quota.rows.length > 0 && quota.rows[0].llm_calls_used >= quota.rows[0].llm_calls_limit) {
    return { hit: 'none', source: 'openrouter', reason: 'Quota exceeded' };
  }

  const systemPrompt = buildSystemPrompt(level, conceptId, fewShotContext);

  try {
    const result = await openrouter.generate(question, {
      system: systemPrompt,
      temperature: 0.7,
      maxTokens: 512,
    });

    await db.query(
      `INSERT INTO student_level_quota (student_id, level, llm_calls_used, quota_reset_at)
       VALUES ($1, $2, 1, NOW() + INTERVAL '30 days')
       ON CONFLICT (student_id, level)
       DO UPDATE SET llm_calls_used = student_level_quota.llm_calls_used + 1`,
      [studentId, level]
    );

    await db.query(
      `INSERT INTO openrouter_cost_log (student_id, level, cost_usd, tokens_used, model, success)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [studentId, level, 0, result.usage?.total_tokens || 0, result.model]
    );

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
      const { audioBuffer, mimeType } = await geminiTTS.synthesize(normalizedText);
      const wavBuffer = geminiTTS.pcmToWav(audioBuffer);
      const audioUrl = `data:audio/wav;base64,${wavBuffer.toString('base64')}`;
      return { text: normalizedText, audioUrl, tier: 'premium' };
    } catch {
      return { text: normalizedText, audioUrl: null, tier: 'premium', ttsError: true };
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
        tier: 'basic',
        upgradeMessage: null,
      };
    }
  }

  return {
    text: normalizedText,
    audioUrl: null,
    tier: 'basic',
    upgradeMessage: `Upgrade ke Premium Level ${level} supaya Kak Cadas bisa jawab langsung pertanyaan ini!`,
  };
}
// ============================================================
// Main Pipeline Orchestrator
// ============================================================
async function askKak({ studentId, questionText, conceptId, level, accessType }) {
  const questionHash = crypto.createHash('sha256').update(questionText.toLowerCase().trim()).digest('hex');

  // Check cache first
  const cached = await db.query(
    `SELECT answer_text, audio_url, source FROM student_questions
     WHERE student_id = $1 AND question_hash = $2
     ORDER BY created_at DESC LIMIT 1`,
    [studentId, questionHash]
  );

  if (cached.rows.length > 0) {
    return {
      answer: cached.rows[0].answer_text,
      audioUrl: cached.rows[0].audio_url,
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
    answerText = lexical.results[0].content;
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
    source,
    tier: output.tier,
    upgradeMessage: output.upgradeMessage || null,
    cached: false,
  };
}

// ============================================================
// Helper Functions
// ============================================================
async function cacheQuestion(studentId, questionText, questionHash, conceptId, level, source, answerText, audioUrl, isPremium) {
  await db.query(
    `INSERT INTO student_questions (student_id, question_text, question_hash, concept_id, level, source, answer_text, audio_url, is_premium)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [studentId, questionText, questionHash, conceptId, level, source, answerText, audioUrl, isPremium]
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
  // Placeholder: hash-based pseudo-embedding for MVP
  // Replace with real embedding model (e.g., transformers.js) in production
  const hash = crypto.createHash('md5').update(text.toLowerCase()).digest();
  const embedding = new Array(384).fill(0);
  for (let i = 0; i < hash.length; i++) {
    embedding[i % 384] = (hash[i] / 255) * 2 - 1;
  }
  const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
  return embedding.map(v => v / (norm || 1));
}

module.exports = {
  askKak,
  lexicalSearch,
  semanticSearch,
  openRouterFallback,
  normalizeOutput,
  generateOutput,
};

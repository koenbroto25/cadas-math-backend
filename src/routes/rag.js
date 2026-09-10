/**
 * RAG API Endpoints â€” FASE 8
 *
 * POST /api/rag/ask           â€” Main AskKak pipeline
 * GET  /api/rag/select-variant â€” Selection Rule for PracticeScreen
 * GET  /api/rag/quota/:studentId â€” Check remaining quota
 */

const express = require('express');
const router = express.Router();
const db = require('../database/db'); // shared pool â€” fix duplikasi koneksi (Sprint B)
const { askKak, normalizeOutput } = require('../rag/pipeline');
const { selectExplanationVariant, recordVariantShown, recordVariantHelpful } = require('../rag/selection-rule');
const { getLevelAccess } = require('../middleware/level-access');

/**
 * POST /api/rag/ask
 * Main RAG pipeline endpoint.
 * Body: { student_id, question_text, concept_id?, level }
 */
router.post('/ask', async (req, res) => {
  try {
    const { student_id, question_text, concept_id, level } = req.body;

    if (!student_id || !question_text || !level) {
      return res.status(400).json({ error: 'student_id, question_text, and level are required' });
    }

    const access = await getLevelAccess(db, student_id, level);
    if (access === 'locked') {
      return res.status(403).json({
        error: 'PREMIUM_REQUIRED',
        message: `Level ${level} belum dibeli. Upgrade untuk mengakses fitur ini.`,
        level,
      });
    }

    const result = await askKak({
      studentId: student_id,
      questionText: question_text,
      conceptId: concept_id,
      level: parseInt(level, 10),
      accessType: access,
    });

    res.json(result);
  } catch (error) {
    console.error('RAG ask error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/rag/select-variant
 * Selection Rule endpoint for PracticeScreen.
 */
router.post('/select-variant', async (req, res) => {
  try {
    const { student_id, level, concept_id, attempt_number, accuracy, avg_time_ms, target_time_ms } = req.body;

    if (!student_id || !level) {
      return res.status(400).json({ error: 'student_id and level are required' });
    }

    const result = await selectExplanationVariant(
      student_id,
      parseInt(level, 10),
      concept_id,
      {
        attemptNumber: parseInt(attempt_number || '1', 10),
        accuracy: accuracy ? parseFloat(accuracy) : undefined,
        avgTimeMs: avg_time_ms ? parseInt(avg_time_ms, 10) : undefined,
        targetTimeMs: target_time_ms ? parseInt(target_time_ms, 10) : undefined,
      }
    );

    res.json(result);
  } catch (error) {
    console.error('Select variant error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
/**
 * POST /api/rag/record-shown
 * Record that a variant was shown to a student.
 * Body: { student_id, concept_id, level, variant_id }
 */
router.post('/record-shown', async (req, res) => {
  try {
    const { student_id, concept_id, level, variant_id } = req.body;

    if (!student_id || !concept_id || !level || !variant_id) {
      return res.status(400).json({ error: 'student_id, concept_id, level, variant_id are required' });
    }

    await recordVariantShown(student_id, concept_id, parseInt(level, 10), variant_id);
    res.json({ success: true });
  } catch (error) {
    console.error('Record shown error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/rag/record-helpful
 * Record that a variant was helpful.
 * Body: { student_id, concept_id, variant_id }
 */
router.post('/record-helpful', async (req, res) => {
  try {
    const { student_id, concept_id, variant_id } = req.body;

    if (!student_id || !concept_id || !variant_id) {
      return res.status(400).json({ error: 'student_id, concept_id, variant_id are required' });
    }

    await recordVariantHelpful(student_id, concept_id, variant_id);
    res.json({ success: true });
  } catch (error) {
    console.error('Record helpful error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/rag/quota/:studentId
 * Check remaining LLM quota for a student at a level.
 * Query: level
 */
router.get('/quota/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const { level } = req.query;

    if (!level) {
      return res.status(400).json({ error: 'level query parameter is required' });
    }

    // Skema aktual student_level_quota: current_level, attempted_today,
    // daily_limit, reset_date. Sprint B.
    const quota = await db.query(
      `SELECT attempted_today, daily_limit, reset_date
       FROM student_level_quota
       WHERE student_id = $1 AND current_level = $2`,
      [studentId, parseInt(level, 10)]
    );

    if (quota.rows.length === 0) {
      return res.json({
        student_id: studentId,
        level: parseInt(level, 10),
        llm_calls_used: 0,
        llm_calls_limit: 40,
        remaining: 40,
      });
    }

    const q = quota.rows[0];
    res.json({
      student_id: studentId,
      level: parseInt(level, 10),
      llm_calls_used: q.attempted_today,
      llm_calls_limit: q.daily_limit,
      remaining: Math.max(0, q.daily_limit - q.attempted_today),
      quota_reset_at: q.reset_date,
    });
  } catch (error) {
    console.error('Quota check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/rag/normalize
 * Normalize text for speech (utility endpoint).
 * Body: { text }
 */
router.post('/normalize', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'text is required' });
    }
    const normalized = normalizeOutput(text);
    res.json({ original: text, normalized });
  } catch (error) {
    console.error('Normalize error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;



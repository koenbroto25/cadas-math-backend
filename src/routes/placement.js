/**
 * Placement Test API Endpoints (v2 — speed-first)
 *
 * POST /api/placement/start            - Start placement test (25 soal, L1-11)
 * POST /api/placement/submit           - Submit answers, get placement result
 * GET  /api/placement/status/:studentId - Check placement status
 *
 * Rules (Placement_Test_System.md §5):
 *   - 25 questions: L1-4 @2, L5-9 @3, L10-11 @1 (ceiling probes)
 *   - Hard limit 8000 ms per question; correct-but-slow = FAIL
 *   - Level pass = accuracy >= 80% AND avg_time <= 8000 ms
 *   - placed_level = first failed level (clamp 1..9); all-pass → 9 (MAX)
 *   - Early stop after 3 consecutive fails (wrong OR timeout)
 */
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');
const engine = require('../services/placementEngine');

// jsonb columns come back as parsed objects from pg; normalize defensively
function parseJsonb(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

/**
 * POST /api/placement/start
 * Start a placement test — builds a fresh 25-question set from the catalog.
 * Body: { studentId, visualOnly? }
 */
router.post('/start', async (req, res) => {
  try {
    const { studentId, visualOnly = false } = req.body;

    if (!studentId) {
      return res.status(400).json({ error: 'studentId is required' });
    }

    // Block re-test if already completed
    const existing = await db.query(
      'SELECT id, placed_level FROM placement_tests WHERE student_id = $1 AND status = $2 ORDER BY completed_at DESC LIMIT 1',
      [studentId, 'completed']
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'Placement test already completed',
        placementId: existing.rows[0].id,
        placedLevel: existing.rows[0].placed_level
      });
    }

    // Cancel stale in-progress tests for this student
    await db.query(
      "UPDATE placement_tests SET status = 'abandoned' WHERE student_id = $1 AND status = 'in_progress'",
      [studentId]
    );

    // Build the v2 question set (server-side copy includes correctAnswer)
    const questionSet = engine.buildQuestionSet();
    const clientQuestions = engine.toClientQuestions(questionSet);

    const placementId = uuidv4();
    await db.query(
      `INSERT INTO placement_tests (id, student_id, start_level, current_level, probes, total_questions, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'in_progress')`,
      [placementId, studentId, 1, 1, JSON.stringify(questionSet), engine.TOTAL_QUESTIONS]
    );

    res.json({
      placementId,
      startLevel: 1,
      visualOnly,
      totalQuestions: engine.TOTAL_QUESTIONS,
      timeLimitMs: engine.TIME_LIMIT_MS,
      exercises: clientQuestions
    });
  } catch (error) {
    console.error('Error starting placement:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/placement/submit
 * Body: { studentId, placementId, answers: [{ probeId|exerciseId, answer, timeTakenMs, timeout? }] }
 * Answers MUST be in submission order (early-stop rule depends on it).
 */
router.post('/submit', async (req, res) => {
  try {
    const { studentId, placementId, answers } = req.body;

    if (!studentId || !placementId || !answers || !Array.isArray(answers)) {
      return res.status(400).json({ error: 'studentId, placementId, and answers array are required' });
    }

    const placementResult = await db.query(
      'SELECT * FROM placement_tests WHERE id = $1 AND student_id = $2',
      [placementId, studentId]
    );
    if (placementResult.rows.length === 0) {
      return res.status(404).json({ error: 'Placement test not found' });
    }

    const placement = placementResult.rows[0];
    if (placement.status === 'completed') {
      return res.status(409).json({ error: 'Placement test already submitted', placedLevel: placement.placed_level });
    }

    const questionSet = parseJsonb(placement.probes);
    if (!Array.isArray(questionSet) || questionSet.length === 0) {
      return res.status(500).json({ error: 'Placement question set corrupted' });
    }

    // Evaluate (speed + accuracy) in submission order
    const evaluated = engine.evaluateAnswers(questionSet, answers);

    // Cut at early-stop point (client may still send remaining answers)
    let consecutive = 0;
    let cutIndex = evaluated.length;
    for (let i = 0; i < evaluated.length; i++) {
      if (!evaluated[i].correct) {
        consecutive += 1;
        if (consecutive >= engine.EARLY_STOP_FAILS) { cutIndex = i + 1; break; }
      } else {
        consecutive = 0;
      }
    }
    const evaluatedUsed = evaluated.slice(0, cutIndex);

    const result = engine.calculatePlacementV2(evaluatedUsed);
    const evaluatedAll = evaluated;

    // Write student_variant_bias (skills needing remediation) — per-skill stats
    for (const skill of Object.keys(result.prerequisite_signals || {})) {
      const skillAnswers = evaluatedAll.filter(a => a.skillArea === skill);
      if (skillAnswers.length === 0) continue;
      const correctCount = skillAnswers.filter(a => a.correct).length;
      const accuracyPercent = Math.round((correctCount / skillAnswers.length) * 100);
      if (accuracyPercent >= 100) continue;
      await db.query(
        'INSERT INTO student_variant_bias (student_id, placement_id, variant_type, correct_count, total_attempts, accuracy_percent, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) ON CONFLICT (student_id, placement_id, variant_type) DO UPDATE SET correct_count = $4, total_attempts = $5, accuracy_percent = $6, updated_at = NOW()',
        [studentId, placementId, skill, correctCount, skillAnswers.length, accuracyPercent]
      );
    }

    // Persist results
    await db.query(
      `UPDATE placement_tests
       SET status = 'completed',
           placed_level = $1,
           prerequisite_signals = $2,
           results = $3,
           level_breakdown = $4,
           early_stop_reason = $5,
           total_questions = $6,
           completed_at = NOW()
       WHERE id = $7`,
      [
        result.placed_level,
        JSON.stringify(result.prerequisite_signals),
        JSON.stringify(evaluatedAll),
        JSON.stringify(result.level_breakdown),
        result.early_stop_reason,
        engine.TOTAL_QUESTIONS,
        placementId
      ]
    );

    // Update student's current level
    await db.query(
      'UPDATE students SET current_level = $1, trial_level = $2 WHERE id = $3',
      [result.placed_level, result.placed_level, studentId]
    );

    // Aktivasi kredit menggantung (Pintu 1: ortu bayar sebelum placement).
    // Scope aktif = [placed_level .. placed_level + pending_levels - 1].
    // Gagal aktivasi TIDAK boleh menggagalkan placement — dicatat & dilanjutkan.
    let activation = null;
    try {
      const access = require('../services/accessService');
      activation = await access.activatePendingPurchases(db, studentId, result.placed_level);
    } catch (actErr) {
      console.error('[placement/submit] aktivasi kredit pending gagal:', actErr.message);
    }

    res.json({
      placementId,
      placedLevel: result.placed_level,
      levelBreakdown: result.level_breakdown,
      earlyStopped: result.early_stopped,
      earlyStopReason: result.early_stop_reason,
      stats: result.stats,
      prerequisiteSignals: result.prerequisite_signals,
      speedEmphasis: result.speed_emphasis,
      accuracyByLevel: result.accuracy_by_level,
      speedByLevel: result.speed_by_level,
      totalAnswers: evaluatedAll.length,
      correctAnswers: evaluatedAll.filter(a => a.correct).length,
      ...(activation && activation.activated.length > 0 && {
        purchaseActivation: activation
      })
    });
  } catch (error) {
    console.error('Error submitting placement:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/placement/status/:studentId
 */
router.get('/status/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;

    const completed = await db.query(
      'SELECT * FROM placement_tests WHERE student_id = $1 AND status = $2 ORDER BY completed_at DESC LIMIT 1',
      [studentId, 'completed']
    );

    if (completed.rows.length > 0) {
      const t = completed.rows[0];
      return res.json({
        hasCompleted: true,
        placementId: t.id,
        placedLevel: t.placed_level,
        earlyStopReason: t.early_stop_reason,
        levelBreakdown: parseJsonb(t.level_breakdown),
        prerequisiteSignals: parseJsonb(t.prerequisite_signals),
        completedAt: t.completed_at
      });
    }

    const inProgress = await db.query(
      "SELECT id, started_at FROM placement_tests WHERE student_id = $1 AND status = 'in_progress' ORDER BY started_at DESC LIMIT 1",
      [studentId]
    );

    res.json({
      hasCompleted: false,
      inProgress: inProgress.rows.length > 0,
      placementId: inProgress.rows[0]?.id || null
    });
  } catch (error) {
    console.error('Error fetching placement status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

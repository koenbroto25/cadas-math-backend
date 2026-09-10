/**
 * Placement Test API Endpoints
 *
 * POST /api/placement/start     - Start placement test (get probe set)
 * POST /api/placement/submit    - Submit answers, get placement result
 * GET  /api/placement/status/:studentId - Check placement status
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');

// Target times from SPEED_TARGETS_QUICK_REFERENCE (ms)
const TARGET_TIMES = {
  1: 15000, 2: 12000, 3: 10000, 4: 9000, 5: 8000,
  6: 9000, 7: 9000, 8: 8000, 9: 6000, 10: 13500,
  11: 17500, 12: 17500, 13: 25000, 14: 25000, 15: 10000
};

/**
 * POST /api/placement/start
 * Start a placement test - returns a probe set
 */
router.post('/start', async (req, res) => {
  try {
    const { studentId, visualOnly = false } = req.body;

    if (!studentId) {
      return res.status(400).json({ error: 'studentId is required' });
    }

    // Check if student already has a completed placement
    const existing = await db.query(
      'SELECT * FROM placement_tests WHERE student_id = $1 AND status = $2',
      [studentId, 'completed']
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'Placement test already completed',
        placementId: existing.rows[0].id,
        placedLevel: existing.rows[0].placed_level
      });
    }

    // Get a random placement test from the pool
    const startLevel = visualOnly ? 3 : 8;
    const placementResult = await db.query(
      'SELECT * FROM placement_tests WHERE status = $1 AND start_level = $2 LIMIT 1',
      ['completed', startLevel]
    );

    if (placementResult.rows.length === 0) {
      return res.status(404).json({ error: 'No placement test available' });
    }

    const placement = placementResult.rows[0];
    // pg returns JSONB as parsed JS object/array; handle both string and array
    const probesRaw = placement.probes;
    const exerciseIds = Array.isArray(probesRaw) ? probesRaw :
      (typeof probesRaw === 'string' ? JSON.parse(probesRaw || '[]') : []);

    // Get actual exercise data
    const exercisesResult = await db.query(
      `SELECT e.id, e.source_id, e.level_id, e.num1, e.num2, e.operation, e.correct_answer, e.question_text, e.hint_text, e.quick_trick, e.visualization_type, e.speech_text, COALESCE(c.code, 'general') as skill_code FROM exercises e LEFT JOIN concepts c ON e.concept_id = c.id WHERE e.source_id = ANY($1)`,
      [exerciseIds]
    );

    // Create in-progress placement test for student
    const newPlacementId = uuidv4();
    await db.query(`
      INSERT INTO placement_tests (id, student_id, start_level, current_level, probes, status)
      VALUES ($1, $2, $3, $4, $5, 'in_progress')
    `, [newPlacementId, studentId, placement.start_level, placement.start_level, JSON.stringify(exerciseIds)]);

    res.json({
      placementId: newPlacementId,
      startLevel: placement.start_level,
      visualOnly,
      exercises: exercisesResult.rows.map(ex => ({
        id: ex.id,
        level: ex.level_id,
        problemText: ex.question_text,
        num1: ex.num1,
        num2: ex.num2,
        operation: ex.operation,
        visualizationType: ex.visualization_type,
        speechText: ex.speech_text
      }))
    });

  } catch (error) {
    console.error('Error starting placement:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/placement/submit
 * Submit placement answers and get result
 */
router.post('/submit', async (req, res) => {
  try {
    const { studentId, placementId, answers } = req.body;

    if (!studentId || !placementId || !answers || !Array.isArray(answers)) {
      return res.status(400).json({ error: 'studentId, placementId, and answers array are required' });
    }

    // Get the placement test
    const placementResult = await db.query(
      'SELECT * FROM placement_tests WHERE id = $1 AND student_id = $2',
      [placementId, studentId]
    );

    if (placementResult.rows.length === 0) {
      return res.status(404).json({ error: 'Placement test not found' });
    }

    const placement = placementResult.rows[0];
    // pg returns JSONB as parsed JS object/array; handle both string and array
    const probesRaw = placement.probes;
    const exerciseIds = Array.isArray(probesRaw) ? probesRaw :
      (typeof probesRaw === 'string' ? JSON.parse(probesRaw || '[]') : []);

    // Get correct answers — BUG FIX #1: include concept_id
    const exercisesResult = await db.query(
      `SELECT e.id, e.source_id, e.level_id, e.correct_answer, COALESCE(c.code, 'general') as skill_code FROM exercises e LEFT JOIN concepts c ON e.concept_id = c.id WHERE e.id = ANY($1)`,
      [answers.map(a => a.exerciseId)]
    );

    const exerciseMap = {};
    for (const ex of exercisesResult.rows) {
      exerciseMap[ex.id] = ex;
    }

    // Evaluate answers — BUG FIX #2: use level_id instead of level
    const evaluatedAnswers = [];
    for (const answer of answers) {
      const exercise = exerciseMap[answer.exerciseId];
      if (!exercise) continue;

      const correct = parseFloat(answer.answer) === parseFloat(exercise.correct_answer);
      evaluatedAnswers.push({
        exerciseId: answer.exerciseId,
        level: exercise.level_id,
        skillArea: exercise.skill_code || 'general',
        correct,
        timeTakenMs: answer.timeTakenMs || null,
        userAnswer: answer.answer,
        correctAnswer: exercise.correct_answer
      });
    }

    // Calculate placement result
    const result = calculatePlacement(evaluatedAnswers);

    // Write student_variant_bias (skills needing remediation)
    const biasInserts = [];
    // BUG FIX: correct_count / total_attempts dihitung PER-SKILL dari evaluatedAnswers,
    // bukan dari agregat seluruh test.
    for (const skill of Object.keys(result.prerequisite_signals || {})) {
      const skillAnswers = evaluatedAnswers.filter(a => a.skillArea === skill);
      if (skillAnswers.length === 0) continue;
      const correctCount = skillAnswers.filter(a => a.correct).length;
      const accuracyPercent = Math.round((correctCount / skillAnswers.length) * 100);
      if (accuracyPercent >= 100) continue; // tidak perlu remediasi
      biasInserts.push({
        skill,
        correctCount,
        totalAttempts: skillAnswers.length,
        accuracyPercent
      });
    }
    if (biasInserts.length > 0) {
      for (const bias of biasInserts) {
        await db.query(
          'INSERT INTO student_variant_bias (student_id, placement_id, variant_type, correct_count, total_attempts, accuracy_percent, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) ON CONFLICT (student_id, placement_id, variant_type) DO UPDATE SET correct_count = $4, total_attempts = $5, accuracy_percent = $6, updated_at = NOW()',
          [studentId, placementId, bias.skill, bias.correctCount, bias.totalAttempts, bias.accuracyPercent]
        );
      }
      console.log('[PLACEMENT] Wrote ' + biasInserts.length + ' variant bias records');
    }

    // Save results
    const resultsJson = JSON.stringify(evaluatedAnswers);
    await db.query(`
      UPDATE placement_tests
      SET status = 'completed',
          placed_level = $1,
          prerequisite_signals = $2,
          results = $3,
          completed_at = NOW()
      WHERE id = $4
    `, [result.placed_level, JSON.stringify(result.prerequisite_signals), resultsJson, placementId]);

    // Update student's current level
    await db.query(
      'UPDATE students SET current_level = $1, trial_level = $2 WHERE id = $3',
      [result.placed_level, result.placed_level, studentId]
    );

    res.json({
      placementId,
      placedLevel: result.placed_level,
      prerequisiteSignals: result.prerequisite_signals,
      speedEmphasis: result.speed_emphasis,
      accuracyByLevel: result.accuracy_by_level,
      speedByLevel: result.speed_by_level,
      totalAnswers: evaluatedAnswers.length,
      correctAnswers: evaluatedAnswers.filter(a => a.correct).length
    });

  } catch (error) {
    console.error('Error submitting placement:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/placement/status/:studentId
 * Check placement status for a student
 */
router.get('/status/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;

    const result = await db.query(
      'SELECT id, start_level, placed_level, status, started_at, completed_at FROM placement_tests WHERE student_id = $1 ORDER BY started_at DESC LIMIT 1',
      [studentId]
    );

    if (result.rows.length === 0) {
      return res.json({ status: 'not_started', studentId });
    }

    const placement = result.rows[0];
    res.json({
      studentId,
      placementId: placement.id,
      status: placement.status,
      startLevel: placement.start_level,
      placedLevel: placement.placed_level,
      startedAt: placement.started_at,
      completedAt: placement.completed_at
    });

  } catch (error) {
    console.error('Error checking placement status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Calculate placement result based on accuracy and speed
 * BUG FIX #3: Proper fallback logic when accuracy < 80% across all levels
 */
function calculatePlacement(answers) {
  if (!answers || answers.length === 0) {
    return { placed_level: 1, prerequisite_signals: {}, speed_emphasis: 'low' };
  }

  // Group by level
  const byLevel = {};
  for (const a of answers) {
    if (!byLevel[a.level]) byLevel[a.level] = [];
    byLevel[a.level].push(a);
  }

  // Calculate accuracy per level
  const accuracyByLevel = {};
  for (const [level, items] of Object.entries(byLevel)) {
    const correct = items.filter(a => a.correct).length;
    accuracyByLevel[parseInt(level)] = correct / items.length;
  }

  // Calculate average speed per level (relative to target)
  const speedByLevel = {};
  for (const [level, items] of Object.entries(byLevel)) {
    const times = items.filter(a => a.timeTakenMs).map(a => a.timeTakenMs);
    if (times.length > 0) {
      const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
      const target = TARGET_TIMES[parseInt(level)] || 10000;
      speedByLevel[parseInt(level)] = Math.round((avgTime / target) * 100) / 100;
    }
  }

  // Find placed level: highest level with >= 80% accuracy
  let placedLevel = 1;
  const sortedLevels = Object.keys(accuracyByLevel).map(Number).sort((a, b) => b - a);
  for (const level of sortedLevels) {
    if (accuracyByLevel[level] >= 0.8) {
      placedLevel = level;
      break;
    }
  }

  // If placed level > start level with low accuracy, warn but place at highest passing level
  // If NO level passes 80%, fallback to level 1 (remedial)
  if (placedLevel === 1 && sortedLevels.length > 0 && accuracyByLevel[sortedLevels[0]] < 0.8) {
    console.warn(`[PLACEMENT] All levels < 80% accuracy. Placing at level 1 (remedial).`);
  }

  // Calculate prerequisite signals (skill areas that need work)
  const prerequisiteSignals = {};
  for (const [level, items] of Object.entries(byLevel)) {
    const l = parseInt(level);
    const correct = items.filter(a => a.correct).length;
    const accuracy = correct / items.length;

    const isRemedial = placedLevel === 1 && sortedLevels.length > 0 && accuracyByLevel[sortedLevels[0]] < 0.8;
    if (accuracy < 0.8 && (l <= placedLevel || isRemedial)) {
      const skillAreas = {};
      for (const item of items) {
        if (!item.correct) {
          const skill = item.skillArea || 'general';
          skillAreas[skill] = (skillAreas[skill] || 0) + 1;
        }
      }
      for (const [skill, count] of Object.entries(skillAreas)) {
        prerequisiteSignals[skill] = Math.round((count / items.length) * 100) / 100;
      }
    }
  }

  // Determine speed emphasis
  let speedEmphasis = 'low';
  const placedSpeed = speedByLevel[placedLevel];
  if (placedSpeed !== undefined) {
    if (placedSpeed > 1.5) speedEmphasis = 'high';
    else if (placedSpeed > 1.2) speedEmphasis = 'medium';
  }

  return {
    placed_level: placedLevel,
    prerequisite_signals: prerequisiteSignals,
    speed_emphasis: speedEmphasis,
    accuracy_by_level: accuracyByLevel,
    speed_by_level: speedByLevel
  };
}

/**
 * Extract skill area from concept_id
 */
function extractSkillArea(conceptId) {
  if (!conceptId) return 'general';
  if (conceptId.includes('add')) return 'addition_facts';
  if (conceptId.includes('sub')) return 'subtraction_facts';
  if (conceptId.includes('mult') || conceptId.includes('mul')) return 'multiplication_tables';
  if (conceptId.includes('div')) return 'division_basics';
  if (conceptId.includes('frac')) return 'fractions';
  if (conceptId.includes('dec')) return 'decimals';
  if (conceptId.includes('mixed')) return 'mixed_operations';
  return 'general';
}

module.exports = router;
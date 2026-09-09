/**
 * Upgrade Test API Endpoints
 */

const express = require('express');
const router = express.Router();
const db = require('../database/db');

/**
 * Helper: Get level access based on Addendum v1 Â§1.2
 */
async function getLevelAccess(studentId, level) {
  const result = await db.query(
    'SELECT trial_level, paid_basic_up_to_level, paid_premium_up_to_level FROM students WHERE id = $1',
    [studentId]
  );
  
  if (result.rows.length === 0) return 'locked';
  const student = result.rows[0];

  const trialLimit = student.trial_level || 3;
  const basicLimit = student.paid_basic_up_to_level || 0;
  const premiumLimit = student.paid_premium_up_to_level || 0;

  if (level <= trialLimit) return 'basic';
  if (level <= premiumLimit) return 'premium';
  if (level <= basicLimit) return 'basic';
  return 'locked';
}

/**
 * GET /api/upgrade-test/:level
 */
router.get('/:level', async (req, res) => {
  try {
    const level = parseInt(req.params.level, 10);
    const studentId = req.query.studentId;

    if (!studentId) return res.status(400).json({ error: 'studentId required' });
    if (isNaN(level)) return res.status(400).json({ error: 'Invalid level' });

    const access = await getLevelAccess(studentId, level);
    if (access === 'locked') {
      return res.status(403).json({
        error: 'PREMIUM_REQUIRED',
        pricing: {
          singleLevelIdr: 40000,
          basicBundleIdr: 100000,
          premiumBundleIdr: 165000,
          whatsappContact: process.env.ADMIN_WHATSAPP || '6281234567890'
        }
      });
    }

    const testResult = await db.query(
      'SELECT * FROM upgrade_tests WHERE level = $1 ORDER BY created_at LIMIT 1',
      [level]
    );

    if (testResult.rows.length === 0) return res.status(404).json({ error: 'Test not found' });

    const test = testResult.rows[0];
    const problems = typeof test.problems === 'string' ? JSON.parse(test.problems) : test.problems;

    res.json({
      testId: test.id,
      level: test.level,
      levelTo: test.level_to,
      testType: test.test_type,
      numProblems: test.num_problems,
      timeLimitMs: test.time_limit_ms,
      problems: problems.map(p => ({
        exercise_id: p.exercise_id,
        problem_text: p.problem_text,
        num1: p.num1,
        num2: p.num2,
        operation: p.operation,
        visualization_type: p.visualization_type
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/upgrade-test/:test_id/submit
 */
router.post('/:test_id/submit', async (req, res) => {
  try {
    const testId = req.params.test_id;
    const { studentId, answers, totalTimeMs } = req.body;

    if (!studentId || !answers) return res.status(400).json({ error: 'studentId and answers required' });

    const testResult = await db.query('SELECT * FROM upgrade_tests WHERE id = $1', [testId]);
    if (testResult.rows.length === 0) return res.status(404).json({ error: 'Test not found' });

    const test = testResult.rows[0];
    const problems = typeof test.problems === 'string' ? JSON.parse(test.problems) : test.problems;
    const threshold = parseFloat(test.pass_accuracy_threshold || 0.90);
    const timeLimit = test.time_limit_ms;

    let correct = 0;
    const evaluated = [];

    for (const ans of answers) {
      const prob = problems.find(p => (p.exercise_id || p.id) === ans.exerciseId);
      if (!prob) continue;
      const isCorrect = String(ans.answer).trim() === String(prob.correct_answer).trim();
      if (isCorrect) correct++;
      evaluated.push({ exerciseId: ans.exerciseId, correct: isCorrect });
    }

    const accuracy = evaluated.length > 0 ? correct / evaluated.length : 0;
    const withinTime = timeLimit ? (totalTimeMs <= timeLimit) : true;
    const passed = accuracy >= threshold && withinTime;

    if (passed) {
      await db.query(
        'UPDATE students SET current_level = GREATEST(current_level, $1) WHERE id = $2',
        [test.level_to, studentId]
      );
    }

    res.json({ passed, accuracy, correctCount: correct, totalProblems: evaluated.length, withinTime });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

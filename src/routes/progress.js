/**
 * POST /api/progress/session — simpan hasil sesi latihan
 * GET  /api/progress/:studentId — ringkasan progres siswa
 */
const express = require('express');
const db = require('../database/db');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Body: { student_id?, device_id?, level, results: [{ id, correct, timeMs }] }
router.post('/session', async (req, res) => {
  const { student_id, device_id, level, results } = req.body || {};

  if (!Array.isArray(results) || results.length === 0) {
    return res.status(400).json({ error: 'results wajib array berisi jawaban' });
  }
  const levelId = parseInt(level, 10);
  if (!Number.isInteger(levelId) || levelId < 1 || levelId > 15) {
    return res.status(400).json({ error: 'level harus angka 1-15' });
  }
  if (student_id && !UUID_RE.test(student_id)) {
    return res.status(400).json({ error: 'student_id harus UUID valid' });
  }

  const total = results.length;
  const correct = results.filter((r) => r.correct).length;
  const times = results.filter((r) => r.timeMs && r.timeMs > 0).map((r) => r.timeMs);
  const avgTime = times.length
    ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
    : null;

  try {
    const r = await db.query(
      `INSERT INTO student_sessions
         (student_id, device_id, level_id, total_questions, correct_count, avg_time_ms, results)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [
        student_id || null,
        device_id || null,
        levelId,
        total,
        correct,
        avgTime,
        JSON.stringify(results),
      ]
    );
    res.status(201).json({
      session_id: r.rows[0].id,
      created_at: r.rows[0].created_at,
      total_questions: total,
      correct_count: correct,
      avg_time_ms: avgTime,
    });
  } catch (err) {
    console.error('POST /api/progress/session error:', err.message);
    res.status(500).json({ error: 'gagal menyimpan sesi' });
  }
});

// GET /api/progress/:studentId
router.get('/:studentId', async (req, res) => {
  const { studentId } = req.params;
  if (!UUID_RE.test(studentId)) {
    return res.status(400).json({ error: 'student_id harus UUID valid' });
  }

  try {
    const stu = await db.query(
      'SELECT id, username, display_name, current_level, trial_level FROM students WHERE id = $1',
      [studentId]
    );
    if (stu.rowCount === 0) {
      return res.status(404).json({ error: 'student tidak ditemukan' });
    }

    const agg = await db.query(
      `SELECT COUNT(*)::int AS sessions,
              COALESCE(SUM(total_questions), 0)::int AS questions,
              COALESCE(SUM(correct_count), 0)::int AS correct
       FROM student_sessions WHERE student_id = $1`,
      [studentId]
    );

    const perLevel = await db.query(
      `SELECT level_id AS level,
              COUNT(*)::int AS sessions,
              SUM(total_questions)::int AS questions,
              SUM(correct_count)::int AS correct,
              ROUND(AVG(correct_count::numeric / NULLIF(total_questions, 0)), 3) AS accuracy
       FROM student_sessions WHERE student_id = $1
       GROUP BY level_id ORDER BY level_id`,
      [studentId]
    );

    const a = agg.rows[0];
    res.json({
      student: stu.rows[0],
      total_sessions: a.sessions,
      total_questions: a.questions,
      total_correct: a.correct,
      overall_accuracy: a.questions > 0 ? Number((a.correct / a.questions).toFixed(3)) : 0,
      per_level: perLevel.rows,
    });
  } catch (err) {
    console.error('GET /api/progress/:studentId error:', err.message);
    res.status(500).json({ error: 'gagal memuat progres' });
  }
});

module.exports = router;

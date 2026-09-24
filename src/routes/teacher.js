/**
 * routes/teacher.js - Sprint F
 * Teacher Dashboard Routes (dilindungi JWT role teacher)
 *
 * GET /api/teacher/me                            - profil guru + total_students
 * GET /api/teacher/students                      - list murid + snapshot
 * GET /api/teacher/student/:student_id/progress  - detail progress per murid
 * GET /api/teacher/student/:student_id/sessions  - history sesi (paginated)
 */
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');
const dashboardService = require('../services/marketingDashboardService');
const { verifyToken, requireRole } = require('../middleware/auth');

router.use(verifyToken);
router.use(requireRole('teacher'));

async function ownedByTeacher(teacherId, studentId) {
  const r = await db.query(
    'SELECT 1 FROM teacher_students WHERE teacher_id = $1 AND student_id = $2',
    [teacherId, studentId]
  );
  return r.rowCount > 0;
}

// GET /api/teacher/me
router.get('/me', async (req, res) => {
  try {
    const t = await db.query(
      'SELECT id, display_name, email, teacher_type FROM teachers WHERE id = $1',
      [req.auth.sub]
    );
    const count = await db.query(
      'SELECT COUNT(*)::int AS total FROM teacher_students WHERE teacher_id = $1',
      [req.auth.sub]
    );

    const ref = await db.query(
      `SELECT id, type, referral_code, referral_token FROM referrers
        WHERE teacher_id=$1::uuid AND status='approved' AND is_active=true
        ORDER BY created_at DESC LIMIT 1`, [req.auth.sub]
    );
    const marketing = ref.rows[0] ? await dashboardService.getPartnerDashboard(ref.rows[0].id) : null;
    res.json({
      teacher: t.rows[0],
      total_students: count.rows[0].total,
      marketing,
      linked_partner: ref.rows[0] || null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/teacher/students
router.get('/students', async (req, res) => {
  try {
    const rows = await db.query(`
      SELECT
        s.id,
        s.username,
        s.display_name,
        s.grade_level,
        s.current_level,
        s.trial_level,
        s.paid_basic_up_to_level,
        s.paid_premium_up_to_level,
        COUNT(ss.id)::int AS total_sessions,
        COALESCE(SUM(ss.correct_count), 0)::int AS total_benar,
        COALESCE(SUM(ss.total_questions), 0)::int AS total_soal,
        MAX(ss.created_at) AS last_session_at
      FROM students s
      JOIN teacher_students ts ON ts.student_id = s.id
      LEFT JOIN student_sessions ss ON ss.student_id = s.id
      WHERE ts.teacher_id = $1
      GROUP BY s.id, s.username, s.display_name, s.grade_level, s.current_level,
               s.trial_level, s.paid_basic_up_to_level, s.paid_premium_up_to_level
      ORDER BY s.display_name
    `, [req.auth.sub]);

    res.json({ students: rows.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/teacher/student/:student_id/progress
router.get('/student/:student_id/progress', async (req, res) => {
  try {
    if (!await ownedByTeacher(req.auth.sub, req.params.student_id)) {
      return res.status(403).json({ error: 'akses ditolak' });
    }

    const s = await db.query(`
      SELECT id, display_name, username, grade_level, current_level, trial_level,
             paid_basic_up_to_level, paid_premium_up_to_level
      FROM students WHERE id = $1
    `, [req.params.student_id]);
    if (s.rowCount === 0) return res.status(404).json({ error: 'siswa tidak ditemukan' });

    const per_level = await db.query(`
      SELECT
        level_id AS level,
        COUNT(*)::int AS total_sesi,
        COALESCE(SUM(total_questions), 0)::int AS total_soal,
        COALESCE(SUM(correct_count), 0)::int AS total_benar,
        ROUND(COALESCE(SUM(correct_count), 0)::numeric / NULLIF(SUM(total_questions), 0) * 100, 1) AS akurasi_pct,
        ROUND(AVG(avg_time_ms) / 1000.0, 1) AS rata_detik,
        MAX(created_at) AS terakhir_at
      FROM student_sessions
      WHERE student_id = $1
      GROUP BY level_id
      ORDER BY level_id
    `, [req.params.student_id]);

    const stats = await db.query(`
      SELECT
        COUNT(*)::int AS total_sesi,
        COALESCE(SUM(total_questions), 0)::int AS total_soal,
        COALESCE(SUM(correct_count), 0)::int AS total_benar,
        ROUND(COALESCE(SUM(correct_count), 0)::numeric / NULLIF(SUM(total_questions), 0) * 100, 1) AS akurasi_pct,
        COUNT(DISTINCT DATE(created_at))::int AS hari_aktif,
        MAX(created_at) AS terakhir_latihan
      FROM student_sessions
      WHERE student_id = $1
    `, [req.params.student_id]);

    res.json({
      student: s.rows[0],
      stats: stats.rows[0],
      per_level: per_level.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/teacher/student/:student_id/sessions?page=1&limit=20
router.get('/student/:student_id/sessions', async (req, res) => {
  try {
    if (!await ownedByTeacher(req.auth.sub, req.params.student_id)) {
      return res.status(403).json({ error: 'akses ditolak' });
    }

    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;

    const sessions = await db.query(`
      SELECT
        id,
        level_id AS level,
        total_questions,
        correct_count,
        ROUND(correct_count::numeric / NULLIF(total_questions, 0) * 100, 1) AS akurasi_pct,
        ROUND(avg_time_ms / 1000.0, 1) AS rata_detik,
        created_at
      FROM student_sessions
      WHERE student_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.params.student_id, limit, offset]);

    const total = await db.query(
      'SELECT COUNT(*)::int AS cnt FROM student_sessions WHERE student_id = $1',
      [req.params.student_id]
    );

    res.json({
      page,
      limit,
      total: total.rows[0].cnt,
      sessions: sessions.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

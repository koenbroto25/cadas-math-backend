/**
 * routes/parent.js - Sprint E
 * Parent Dashboard Routes (dilindungi JWT role parent)
 *
 * GET /api/parent/children                       - list semua anak + snapshot progress
 * GET /api/parent/child/:student_id/progress     - detail progress per anak per level
 * GET /api/parent/child/:student_id/sessions     - history sesi latihan (paginated)
 * GET /api/parent/child/:student_id/billing      - status billing anak
 */
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');
const { verifyToken, requireRole } = require('../middleware/auth');

router.use(verifyToken);
router.use(requireRole('parent'));

async function ownedByParent(parentId, studentId) {
  const r = await db.query(
    'SELECT 1 FROM parent_children WHERE parent_id = $1 AND student_id = $2',
    [parentId, studentId]
  );
  return r.rowCount > 0;
}

// GET /api/parent/children
router.get('/children', async (req, res) => {
  try {
    const rows = await db.query(`
      SELECT
        s.id, s.username, s.display_name, s.grade_level,
        s.current_level, s.trial_level,
        s.paid_basic_up_to_level, s.paid_premium_up_to_level,
        s.created_at,
        COUNT(ss.id)::int          AS total_sessions,
        SUM(ss.correct_count)::int AS total_benar,
        SUM(ss.total_questions)::int AS total_soal,
        MAX(ss.created_at)         AS last_session_at
      FROM students s
      JOIN parent_children pc ON pc.student_id = s.id
      LEFT JOIN student_sessions ss ON ss.student_id = s.id
      WHERE pc.parent_id = $1
      GROUP BY s.id
      ORDER BY s.display_name
    `, [req.auth.sub]);

    res.json({ children: rows.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/parent/child/:student_id/progress
router.get('/child/:student_id/progress', async (req, res) => {
  try {
    if (!await ownedByParent(req.auth.sub, req.params.student_id)) {
      return res.status(403).json({ error: 'akses ditolak' });
    }

    const s = await db.query(`
      SELECT id, display_name, grade_level, current_level, trial_level,
             paid_basic_up_to_level, paid_premium_up_to_level, created_at
      FROM students WHERE id = $1
    `, [req.params.student_id]);
    if (s.rowCount === 0) return res.status(404).json({ error: 'siswa tidak ditemukan' });

    // Akurasi per level
    const per_level = await db.query(`
      SELECT
        level_id                                                  AS level,
        COUNT(*)::int                                             AS total_sesi,
        SUM(total_questions)::int                                 AS total_soal,
        SUM(correct_count)::int                                   AS total_benar,
        ROUND(
          SUM(correct_count)::numeric / NULLIF(SUM(total_questions),0) * 100, 1
        )                                                         AS akurasi_pct,
        ROUND(AVG(avg_time_ms) / 1000.0, 1)                     AS rata_detik,
        MAX(created_at)                                           AS terakhir_at
      FROM student_sessions
      WHERE student_id = $1
      GROUP BY level_id
      ORDER BY level_id
    `, [req.params.student_id]);

    // Total stats keseluruhan
    const stats = await db.query(`
      SELECT
        COUNT(*)::int                                             AS total_sesi,
        SUM(total_questions)::int                                 AS total_soal,
        SUM(correct_count)::int                                   AS total_benar,
        ROUND(
          SUM(correct_count)::numeric / NULLIF(SUM(total_questions),0) * 100, 1
        )                                                         AS akurasi_pct,
        COUNT(DISTINCT DATE(created_at))::int                     AS hari_aktif,
        MAX(created_at)                                           AS terakhir_latihan
      FROM student_sessions
      WHERE student_id = $1
    `, [req.params.student_id]);

    res.json({
      student:   s.rows[0],
      stats:     stats.rows[0],
      per_level: per_level.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/parent/child/:student_id/sessions?page=1&limit=20
router.get('/child/:student_id/sessions', async (req, res) => {
  try {
    if (!await ownedByParent(req.auth.sub, req.params.student_id)) {
      return res.status(403).json({ error: 'akses ditolak' });
    }

    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(50, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;

    const sessions = await db.query(`
      SELECT
        id, level_id AS level, total_questions, correct_count,
        ROUND(
          correct_count::numeric / NULLIF(total_questions,0) * 100, 1
        )                      AS akurasi_pct,
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
      page, limit,
      total:    total.rows[0].cnt,
      sessions: sessions.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/parent/child/:student_id/billing
router.get('/child/:student_id/billing', async (req, res) => {
  try {
    if (!await ownedByParent(req.auth.sub, req.params.student_id)) {
      return res.status(403).json({ error: 'akses ditolak' });
    }

    const s = await db.query(`
      SELECT id, display_name, current_level,
             paid_basic_up_to_level, paid_premium_up_to_level
      FROM students WHERE id = $1
    `, [req.params.student_id]);
    if (s.rowCount === 0) return res.status(404).json({ error: 'siswa tidak ditemukan' });

    const payments = await db.query(`
      SELECT product_type, level_from, level_to, amount_idr,
             payment_method, is_confirmed, confirmed_by_admin_at, created_at
      FROM payment_records
      WHERE student_id = $1
      ORDER BY created_at DESC LIMIT 10
    `, [req.params.student_id]);

    const midtrans = await db.query(`
      SELECT product_type, level_from, level_to, amount_idr,
             status, paid_at, created_at
      FROM midtrans_invoices
      WHERE student_id = $1
      ORDER BY created_at DESC LIMIT 10
    `, [req.params.student_id]);

    res.json({
      student:         s.rows[0],
      payment_records: payments.rows,
      midtrans_invoices: midtrans.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

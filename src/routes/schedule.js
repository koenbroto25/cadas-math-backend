/**
 * routes/schedule.js - Jadwal Belajar & Device Token (Sprint S-3)
 * POST /api/schedule              - Buat/update jadwal belajar (parent)
 * GET  /api/schedule/:student_id  - Ambil jadwal aktif (parent)
 * POST /api/device-token          - Daftarkan FCM token
 */
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');
const { verifyToken, requireRole } = require('../middleware/auth');

// POST /api/schedule - parent set jadwal anak
router.post('/', verifyToken, requireRole('parent'), async (req, res) => {
  try {
    const parentId = req.auth.id;
    const { student_id, days, start_time, end_time, timezone, active } = req.body;
    if (!student_id) return res.status(400).json({ error: 'student_id wajib' });

    // Verifikasi anak milik parent ini
    const own = await db.query(
      'SELECT 1 FROM parent_children WHERE parent_id = $1 AND student_id = $2',
      [parentId, student_id]
    );
    if (own.rowCount === 0) return res.status(403).json({ error: 'akses ditolak' });

    const r = await db.query(`
      INSERT INTO study_schedules (student_id, days, start_time, end_time, timezone, active)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (student_id) DO UPDATE SET
        days       = EXCLUDED.days,
        start_time = EXCLUDED.start_time,
        end_time   = EXCLUDED.end_time,
        timezone   = EXCLUDED.timezone,
        active     = EXCLUDED.active,
        updated_at = NOW()
      RETURNING *
    `, [
      student_id,
      days || [1,2,3,4,5],
      start_time || '16:00',
      end_time   || '17:00',
      timezone   || 'Asia/Jakarta',
      active !== undefined ? active : true,
    ]);

    res.json({ schedule: r.rows[0] });
  } catch (err) {
    console.error('[schedule/post]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/schedule/:student_id - ambil jadwal aktif
router.get('/:student_id', verifyToken, async (req, res) => {
  try {
    const userId   = req.auth.id;
    const role     = req.auth.role;
    const { student_id } = req.params;

    // Parent: verifikasi kepemilikan. Student: hanya diri sendiri.
    if (role === 'parent') {
      const own = await db.query(
        'SELECT 1 FROM parent_children WHERE parent_id = $1 AND student_id = $2',
        [userId, student_id]
      );
      if (own.rowCount === 0) return res.status(403).json({ error: 'akses ditolak' });
    } else if (role === 'student') {
      if (String(userId) !== String(student_id)) {
        return res.status(403).json({ error: 'akses ditolak' });
      }
    }

    const r = await db.query(
      'SELECT * FROM study_schedules WHERE student_id = $1 AND active = TRUE',
      [student_id]
    );
    res.json({ schedule: r.rows[0] || null });
  } catch (err) {
    console.error('[schedule/get]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/device-token - daftarkan FCM token (parent atau student)
router.post('/device-token', verifyToken, async (req, res) => {
  try {
    const userId   = req.auth.id;
    const userType = req.auth.role === 'parent' ? 'parent' : 'student';
    const { token, platform } = req.body;

    if (!token)    return res.status(400).json({ error: 'token wajib' });
    if (!platform) return res.status(400).json({ error: 'platform wajib' });

    await db.query(`
      INSERT INTO device_tokens (user_id, user_type, token, platform)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (token) DO UPDATE SET
        user_id    = EXCLUDED.user_id,
        user_type  = EXCLUDED.user_type,
        platform   = EXCLUDED.platform,
        updated_at = NOW()
    `, [userId, userType, token, platform]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[device-token]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
/**
 * routes/session.js - Session Notification System (Sprint S-2)
 * POST /api/session/start      - Buat record sesi baru
 * POST /api/session/heartbeat  - Update duration_active_ms
 * POST /api/session/end        - Tutup sesi, hitung focus_ratio, trigger notif
 */
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');
const { verifyToken } = require('../middleware/auth');
const { getCardGate, cardGateBlockBody } = require('../middleware/card-gate');
const { sendSessionResultNotif, sendDistractionNotif } = require('../utils/notify');

// POST /api/session/start
router.post('/start', verifyToken, async (req, res) => {
  try {
    const studentId = req.auth.id;
    const { level } = req.body;

    // A1 / OQ-3: kartu ID wajib dibagikan sebelum latihan (siswa baru).
    // Enforcement di sini pakai token → tidak bisa dilewati dgn menghapus
    // ?student_id dari GET /api/exercises/:level.
    if (req.auth.role === 'student') {
      const gate = await getCardGate(db, studentId);
      if (gate.required) {
        return res.status(403).json(cardGateBlockBody());
      }
    }

    // Tandai sesi aktif sebelumnya sebagai incomplete (safety)
    await db.query(`
      UPDATE study_sessions
      SET status = 'incomplete', ended_at = NOW()
      WHERE student_id = $1 AND status = 'active' AND ended_at IS NULL
    `, [studentId]);

    const r = await db.query(`
      INSERT INTO study_sessions (student_id, level, status)
      VALUES ($1, $2, 'active')
      RETURNING id, started_at
    `, [studentId, level || null]);

    res.json({ session_id: r.rows[0].id, started_at: r.rows[0].started_at });
  } catch (err) {
    console.error('[session/start]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/session/heartbeat
router.post('/heartbeat', verifyToken, async (req, res) => {
  try {
    const studentId = req.auth.id;
    const { session_id, duration_active_ms } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id wajib' });

    await db.query(`
      UPDATE study_sessions
      SET duration_active_ms = $1,
          duration_total_ms  = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000
      WHERE id = $2 AND student_id = $3 AND status = 'active'
    `, [duration_active_ms || 0, session_id, studentId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[session/heartbeat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/session/end
router.post('/end', verifyToken, async (req, res) => {
  try {
    const studentId = req.auth.id;
    const {
      session_id,
      duration_active_ms = 0,
      exit_count         = 0,
      level,
      correct_count      = 0,
      total_count        = 0,
      accuracy           = 0,
      level_up           = false,
    } = req.body;

    if (!session_id) return res.status(400).json({ error: 'session_id wajib' });

    // Ambil started_at untuk hitung duration_total
    const existing = await db.query(
      'SELECT started_at FROM study_sessions WHERE id = $1 AND student_id = $2',
      [session_id, studentId]
    );
    if (existing.rowCount === 0) return res.status(404).json({ error: 'sesi tidak ditemukan' });

    const startedAt      = existing.rows[0].started_at;
    const nowMs          = Date.now();
    const duration_total = nowMs - new Date(startedAt).getTime();
    const focus_ratio    = duration_total > 0
      ? Math.min(100, (duration_active_ms / duration_total) * 100)
      : 100;

    const r = await db.query(`
      UPDATE study_sessions SET
        ended_at           = NOW(),
        duration_active_ms = $1,
        duration_total_ms  = $2,
        exit_count         = $3,
        focus_ratio        = $4,
        level              = $5,
        correct_count      = $6,
        total_count        = $7,
        accuracy           = $8,
        level_up           = $9,
        status             = 'completed'
      WHERE id = $10 AND student_id = $11
      RETURNING *
    `, [
      duration_active_ms, duration_total, exit_count,
      focus_ratio.toFixed(2), level, correct_count, total_count,
      accuracy, level_up, session_id, studentId
    ]);

    const session = r.rows[0];

    // Sesi valid: durasi aktif > 3 menit DAN ada soal
    const isValid = duration_active_ms >= 3 * 60 * 1000 && total_count > 0;

    if (isValid && !session.notif_sent) {
      // Tandai notif sudah dikirim (guard duplikat)
      await db.query(
        'UPDATE study_sessions SET notif_sent = TRUE WHERE id = $1',
        [session_id]
      );

      // Kirim notif ke parent (non-blocking)
      sendSessionResultNotif(studentId, session).catch((e) =>
        console.error('[session/end] notif error:', e.message)
      );

      // Notif distraksi jika focus_ratio < 75 dan exit_count >= 3
      if (focus_ratio < 75 && exit_count >= 3) {
        sendDistractionNotif(studentId, session).catch((e) =>
          console.error('[session/end] distraksi notif error:', e.message)
        );
      }
    }

    res.json({ ok: true, session_id, focus_ratio: focus_ratio.toFixed(2) });
  } catch (err) {
    console.error('[session/end]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
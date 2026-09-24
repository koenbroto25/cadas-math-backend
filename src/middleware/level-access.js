/**
 * Level Access Middleware — FASE 6 & 8
 * Determines access type for a student at a given level.
 *
 * Returns:
 *   'premium'  — paid_premium_up_to_level >= level
 *   'basic'    — paid_basic_up_to_level >= level
 *   'trial'    — trial_level >= level (5 soal gratis, belum bayar)
 *   'locked'   — level belum dibuka sama sekali
 *
 * CHAMPIONSHIP GATE (Placement_Test_System.md §5.8):
 *   Level >= 10 (di atas boss level 9) membutuhkan boss_gate_status.defeated
 *   di boss level 9. Jika belum dikalahkan → 'boss_locked' walau sudah dibayar.
 *   (Placement sendiri max menempatkan siswa di level 9.)
 *
 * Trial quota (5 soal) di-enforce di exercises.js — bukan di sini.
 * getLevelAccess hanya menentukan TIPE akses, bukan apakah quota habis.
 */

const BOSS_GATE_LEVEL = 9; // boss battle championship di level 9

async function getLevelAccess(pool, studentId, level) {
  const result = await pool.query(
    `SELECT paid_basic_up_to_level,
            paid_premium_up_to_level,
            trial_level
     FROM students WHERE id = $1`,
    [studentId]
  );

  if (result.rows.length === 0) return 'locked';

  const s   = result.rows[0];
  const lvl = parseInt(level, 10);

  // ── Championship gate: level di atas boss wajib kalahkan boss dulu ──────
  if (lvl > BOSS_GATE_LEVEL) {
    const gate = await pool.query(
      'SELECT defeated FROM boss_gate_status WHERE student_id = $1 AND boss_level = $2',
      [studentId, BOSS_GATE_LEVEL]
    );
    const defeated = gate.rows[0]?.defeated === true;
    if (!defeated) {
      // Gate tertutup — akses diblokir terlepas dari status pembayaran
      return 'boss_locked';
    }
  }

  // Premium — akses penuh + AskKak
  if (s.paid_premium_up_to_level !== null && s.paid_premium_up_to_level >= lvl) {
    return 'premium';
  }

  // Basic — akses penuh
  if (s.paid_basic_up_to_level !== null && s.paid_basic_up_to_level >= lvl) {
    return 'basic';
  }

  // Trial — 5 soal gratis (preview sebelum bayar)
  // trial_level di-set saat: placement result ATAU upgrade test lulus
  if (s.trial_level !== null && s.trial_level >= lvl) {
    return 'trial';
  }

  // Belum dibuka sama sekali
  return 'locked';
}

/**
 * Express middleware untuk attach req.levelAccess ke request.
 * Dipakai di route yang butuh cek akses per request.
 */
function checkLevelAccess(paramName = 'level') {
  return async (req, res, next) => {
    try {
      const studentId = req.user?.id || req.body?.student_id || req.query?.student_id;
      const level     = req.params[paramName] || req.body?.level || req.query?.level;

      if (!studentId || !level) {
        return res.status(400).json({ error: 'student_id and level are required' });
      }

      const db = require('../database/db');
      req.levelAccess = await getLevelAccess(db, studentId, level);
      req.level       = parseInt(level, 10);
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { getLevelAccess, checkLevelAccess };

/**
 * GET /api/exercises/:level         — daftar soal per level
 * GET /api/exercises/item/:id       — satu soal by source_id
 * GET /api/exercises/level-info/:level_id?student_id=xxx
 *   — info level + levelAccess + trial_remaining
 *
 * Trial enforcement (Sprint I.1):
 *   Siswa dengan akses 'trial' hanya dapat 5 soal pertama (ORDER BY source_id).
 *   Setelah 5 soal dikerjakan (dicatat via POST /api/progress/session),
 *   level_access berubah jadi 'trial_exhausted' → frontend redirect ke paywall.
 */
const express = require('express');
const db      = require('../database/db');

const router = express.Router();

const TRIAL_LIMIT = 5;

// FIELDS: tambah concept_id + concept_code untuk Selection Rule
const FIELDS = `
  e.source_id AS id, e.level_id AS level, e.question_text, e.answer_value,
  e.hint_text, e.quick_trick, e.speech_text, e.operation, e.num1, e.num2,
  e.visualization_type, e.concept_id, COALESCE(c.code, 'general') AS concept_code`;

// ── Helper: ambil atau buat trial usage record ─────────────────────────────
async function getTrialUsage(studentId, levelId) {
  const r = await db.query(
    'SELECT questions_used, exhausted FROM student_trial_usage WHERE student_id=$1 AND level_id=$2',
    [studentId, levelId]
  );
  if (r.rowCount === 0) return { questions_used: 0, exhausted: false };
  return r.rows[0];
}

// ── GET /api/exercises/:level ──────────────────────────────────────────────
// Query params opsional: ?student_id=xxx untuk enforce trial limit
router.get('/:level', async (req, res) => {
  const level = parseInt(req.params.level, 10);
  if (!Number.isInteger(level) || level < 1 || level > 15) {
    return res.status(400).json({ error: 'level harus angka 1-15' });
  }

  try {
    const studentId = req.query.student_id || null;
    let trialInfo   = null;

    // Cek akses jika student_id ada
    if (studentId) {
      const { getLevelAccess } = require('../middleware/level-access');
      const access = await getLevelAccess(db, studentId, level);

      if (access === 'locked') {
        return res.status(403).json({
          error: 'LEVEL_LOCKED',
          message: 'Level ini belum dibuka. Selesaikan trial atau bayar untuk akses penuh.',
          level_access: 'locked',
        });
      }

      if (access === 'trial') {
        const usage = await getTrialUsage(studentId, level);
        if (usage.exhausted) {
          return res.status(403).json({
            error: 'TRIAL_EXHAUSTED',
            message: 'Trial 5 soal sudah habis. Upgrade untuk lanjut latihan.',
            level_access: 'trial_exhausted',
            trial_used: usage.questions_used,
            trial_limit: TRIAL_LIMIT,
          });
        }
        trialInfo = {
          access: 'trial',
          used: usage.questions_used,
          remaining: TRIAL_LIMIT - usage.questions_used,
        };
      }
    }

    // Ambil soal — ORDER BY source_id (urutan tetap)
    const r = await db.query(
      `SELECT ${FIELDS}
       FROM exercises e
       LEFT JOIN concepts c ON e.concept_id = c.id
       WHERE e.level_id = $1
       ORDER BY e.source_id`,
      [level]
    );

    let exercises = r.rows;

    // Batasi 5 soal untuk trial
    if (trialInfo) {
      const startIdx = trialInfo.used; // lanjut dari soal yang belum dikerjakan
      exercises = exercises.slice(startIdx, startIdx + trialInfo.remaining);
    }

    res.json({
      level,
      total:      exercises.length,
      exercises,
      ...(trialInfo && {
        trial_mode:      true,
        trial_used:      trialInfo.used,
        trial_remaining: trialInfo.remaining,
        trial_limit:     TRIAL_LIMIT,
      }),
    });
  } catch (err) {
    console.error('GET /api/exercises/:level error:', err.message);
    res.status(500).json({ error: 'gagal memuat soal' });
  }
});

// ── GET /api/exercises/item/:id ────────────────────────────────────────────
router.get('/item/:id', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT ${FIELDS}
       FROM exercises e
       LEFT JOIN concepts c ON e.concept_id = c.id
       WHERE e.source_id = $1`,
      [req.params.id]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'exercise tidak ditemukan' });
    }
    res.json(r.rows[0]);
  } catch (err) {
    console.error('GET /api/exercises/item/:id error:', err.message);
    res.status(500).json({ error: 'gagal memuat soal' });
  }
});

// ── GET /api/exercises/level-info/:level_id?student_id=xxx ────────────────
router.get('/level-info/:level_id', async (req, res) => {
  try {
    const r = await db.query(
      'SELECT id, name, description FROM levels WHERE id = $1',
      [parseInt(req.params.level_id, 10)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'level tidak ditemukan' });

    const row       = { ...r.rows[0] };
    const studentId = req.query.student_id;

    if (studentId) {
      try {
        const { getLevelAccess } = require('../middleware/level-access');
        const levelId = parseInt(req.params.level_id, 10);
        const access  = await getLevelAccess(db, studentId, levelId);

        if (access === 'trial') {
          const usage = await getTrialUsage(studentId, levelId);
          if (usage.exhausted) {
            row.level_access    = 'trial_exhausted';
            row.trial_remaining = 0;
            row.trial_used      = usage.questions_used;
          } else {
            row.level_access    = 'trial';
            row.trial_remaining = TRIAL_LIMIT - usage.questions_used;
            row.trial_used      = usage.questions_used;
          }
        } else {
          row.level_access = access; // 'basic' | 'premium' | 'locked'
        }
      } catch (e) {
        console.warn('[level-info] getLevelAccess error:', e.message);
        row.level_access = 'trial';
      }
    }

    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

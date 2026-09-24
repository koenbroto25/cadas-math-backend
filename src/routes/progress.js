/**
 * POST /api/progress/session — simpan hasil sesi latihan
 * GET  /api/progress/:studentId — ringkasan progres siswa
 *
 * Sprint I.1: increment student_trial_usage saat siswa trial selesai sesi
 */
const express = require('express');
const db      = require('../database/db');
const jwt    = require('jsonwebtoken');

const router  = express.Router();
const TRIAL_LIMIT = 5;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT_SECRET = process.env.JWT_SECRET || 'cadas_app_secure_secret_key_2026';

// A3: deteksi token demo dengan flag no_persist → sesi TIDAK disimpan DB.
function isDemoNoPersist(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    return payload.role === 'demo' && payload.no_persist === true;
  } catch (_) { return false; }
}

// Helper: update trial usage
async function updateTrialUsage(studentId, levelId, questionsAnswered) {
  await db.query(
    // NOTE: $3 & $4 WAJIB di-cast ::int. Tanpa cast, PostgreSQL mendeduksi $3
    // dua kali (kolom questions_used = integer vs perbandingan `$3 >= $4` yang
    // kedua sisinya unknown) → "inconsistent types deduced for parameter $3"
    // → HTTP 500, kuota trial tidak pernah bertambah.
    `INSERT INTO student_trial_usage (student_id, level_id, questions_used, exhausted, last_used_at)
     VALUES ($1, $2, $3::int, ($3::int >= $4::int), NOW())
     ON CONFLICT (student_id, level_id) DO UPDATE
       SET questions_used = LEAST(student_trial_usage.questions_used + $3::int, $4::int),
           exhausted      = (student_trial_usage.questions_used + $3::int) >= $4::int,
           last_used_at   = NOW()`,
    [studentId, levelId, questionsAnswered, TRIAL_LIMIT]
  );
  const r = await db.query(
    'SELECT questions_used, exhausted FROM student_trial_usage WHERE student_id=$1 AND level_id=$2',
    [studentId, levelId]
  );
  return r.rows[0] || { questions_used: questionsAnswered, exhausted: false };
}

// POST /api/progress/session
router.post('/session', async (req, res) => {
  const { student_id, device_id, level, results } = req.body || {};

  // A3: demo passcode no_persist → hasil latihan tidak masuk DB (uji coba murni).
  if (isDemoNoPersist(req)) {
    return res.json({ ok: true, saved: false, reason: 'demo_no_persist' });
  }

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

  const total    = results.length;
  const correct  = results.filter((r) => r.correct).length;
  const times    = results.filter((r) => r.timeMs && r.timeMs > 0).map((r) => r.timeMs);
  const avgTime  = times.length
    ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
    : null;
  const accuracy = total > 0 ? correct / total : 0;

  try {
    const r = await db.query(
      `INSERT INTO student_sessions
         (student_id, device_id, level_id, total_questions, correct_count, avg_time_ms, results)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [student_id || null, device_id || null, levelId, total, correct, avgTime, JSON.stringify(results)]
    );

    const sessionId = r.rows[0].id;
    const createdAt = r.rows[0].created_at;

    // Trial usage tracking
    let trialStatus = null;
    if (student_id) {
      const { getLevelAccess } = require('../middleware/level-access');
      const access = await getLevelAccess(db, student_id, levelId);
      if (access === 'trial') {
        trialStatus = await updateTrialUsage(student_id, levelId, total);
      }
    }

    // Level-up check: akurasi >= 80% + akses basic/premium + >= 3 sesi
    let levelUp  = false;
    let newLevel = levelId;

    if (student_id && accuracy >= 0.8 && levelId < 15 && !trialStatus) {
      const sc = await db.query(
        'SELECT COUNT(*)::int AS cnt FROM student_sessions WHERE student_id=$1 AND level_id=$2',
        [student_id, levelId]
      );
      if (sc.rows[0].cnt >= 3) {
        // Atomic conditional update — hindari race condition check-then-act.
        // WHERE current_level = levelId memastikan hanya satu request yang bisa
        // berhasil meng-update kalau dua request datang bersamaan untuk siswa
        // yang sama; request lain akan mendapat rowCount 0 dan tidak menaikkan
        // level lagi (level tidak naik dobel).
        const upd = await db.query(
          `UPDATE students
             SET current_level = $1,
                 trial_level   = GREATEST(trial_level, $1)
           WHERE id = $2 AND current_level = $3
           RETURNING current_level`,
          [levelId + 1, student_id, levelId]
        );
        if (upd.rowCount > 0) {
          newLevel = upd.rows[0].current_level;
          levelUp  = true;
          console.log(`[level-up] student ${student_id}: ${levelId} -> ${newLevel}`);
        }
      }
    }

    res.status(201).json({
      session_id:      sessionId,
      created_at:      createdAt,
      total_questions: total,
      correct_count:   correct,
      avg_time_ms:     avgTime,
      accuracy:        Number(accuracy.toFixed(3)),
      level_up:        levelUp,
      new_level:       newLevel,
      ...(trialStatus && {
        trial_used:      trialStatus.questions_used,
        trial_exhausted: trialStatus.exhausted,
        trial_limit:     TRIAL_LIMIT,
      }),
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
      'SELECT id, username, display_name, current_level, trial_level FROM students WHERE id=$1',
      [studentId]
    );
    if (stu.rowCount === 0) return res.status(404).json({ error: 'student tidak ditemukan' });

    const agg = await db.query(
      `SELECT COUNT(*)::int AS sessions,
              COALESCE(SUM(total_questions), 0)::int AS questions,
              COALESCE(SUM(correct_count), 0)::int AS correct
       FROM student_sessions WHERE student_id=$1`,
      [studentId]
    );
    const perLevel = await db.query(
      `SELECT level_id AS level,
              COUNT(*)::int AS sessions,
              SUM(total_questions)::int AS questions,
              SUM(correct_count)::int AS correct,
              ROUND(AVG(correct_count::numeric / NULLIF(total_questions, 0)), 3) AS accuracy
       FROM student_sessions WHERE student_id=$1
       GROUP BY level_id ORDER BY level_id`,
      [studentId]
    );
    const a = agg.rows[0];
    res.json({
      student:          stu.rows[0],
      total_sessions:   a.sessions,
      total_questions:  a.questions,
      total_correct:    a.correct,
      overall_accuracy: a.questions > 0 ? Number((a.correct / a.questions).toFixed(3)) : 0,
      per_level:        perLevel.rows,
    });
  } catch (err) {
    console.error('GET /api/progress/:studentId error:', err.message);
    res.status(500).json({ error: 'gagal memuat progres' });
  }
});

module.exports = router;

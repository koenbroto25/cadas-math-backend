/**
 * Boss Battle Routes — Championship Gate (Level 9)
 *
 * POST /api/boss/start        — mulai/lanjut battle (membuat battle aktif baru)
 * POST /api/boss/hit          — submit 1 jawaban (engine: hit/slow/miss)
 * GET  /api/boss/status/:sid  — status gate + battle aktif
 * POST /api/boss/abandon      — batalkan battle aktif
 *
 * Soal boss diambil dari exercises level 9 (DB) secara acak per hit.
 * Boss battle WAJIB berada di level tempat siswa ditempatkan (level 9)
 * dan akses level harus bukan 'locked'.
 */
const express = require('express');
const db = require('../database/db');
const {
  BOSS_LEVEL,
  HIT_TIME_LIMIT_MS,
  PHASES,
  HITS_PER_PHASE,
  TOTAL_HITS,
  PLAYER_LIVES,
  newBattleState,
  applyHit,
  battleOutcome,
  summarizeTimes
} = require('../services/bossEngine');

const router = express.Router();

// ── Helper: pastikan siswa ada ──────────────────────────────────────────────
async function getStudent(studentId) {
  const r = await db.query(
    `SELECT id, current_level, trial_level FROM students WHERE id = $1`,
    [studentId]
  );
  return r.rows[0] || null;
}

// ── POST /api/boss/start ────────────────────────────────────────────────────
router.post('/start', async (req, res) => {
  try {
    const { student_id, level } = req.body || {};
    if (!student_id) return res.status(400).json({ error: 'student_id wajib' });
    const bossLevel = parseInt(level, 10) || BOSS_LEVEL;

    const student = await getStudent(student_id);
    if (!student) return res.status(404).json({ error: 'STUDENT_NOT_FOUND' });

    // Championship gate hanya relevan di level boss
    if (bossLevel !== BOSS_LEVEL) {
      return res.status(400).json({ error: 'INVALID_BOSS_LEVEL', message: `Boss battle hanya di level ${BOSS_LEVEL}` });
    }

    // Gate sudah terbuka → tidak perlu battle lagi
    const gate = await db.query(
      'SELECT defeated FROM boss_gate_status WHERE student_id = $1 AND boss_level = $2',
      [student_id, bossLevel]
    );
    if (gate.rows[0]?.defeated) {
      return res.status(409).json({ error: 'GATE_ALREADY_OPEN', message: 'Boss sudah dikalahkan sebelumnya' });
    }

    // Batalkan battle aktif lama (hanya 1 aktif per siswa)
    await db.query(
      "UPDATE boss_battles SET status = 'abandoned', completed_at = NOW() WHERE student_id = $1 AND status = 'active'",
      [student_id]
    );

    // Soal pertama (raw disimpan server-side, versi stripped dikirim ke klien)
    const rawQ = await drawQuestion(bossLevel);
    if (!rawQ) {
      return res.status(503).json({ error: 'NO_EXERCISES', message: `Tidak ada soal untuk level ${bossLevel}` });
    }

    const state = newBattleState();
    const id = `boss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await db.query(
      `INSERT INTO boss_battles
        (id, student_id, level, boss_hp, boss_hp_max, phase, total_phases,
         hits_landed, hits_needed, player_lives, player_lives_max,
         streak, best_streak, status, hit_log)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active',$14)`,
      [id, student_id, bossLevel, state.boss_hp, state.boss_hp_max, state.phase,
       state.total_phases, state.hits_landed, state.hits_needed,
       state.player_lives, state.player_lives_max, state.streak,
       state.best_streak,
       // current WAJIB diisi agar hit pertama valid (server-side key only)
       JSON.stringify({ hit_times: [], hits: [], current: { id: rawQ.id, correct_answer: rawQ.answer_value } })]
    );
    // Catat attempt di gate status
    await db.query(
      `INSERT INTO boss_gate_status (student_id, boss_level, attempts)
       VALUES ($1, $2, 1)
       ON CONFLICT (student_id) DO UPDATE SET attempts = boss_gate_status.attempts + 1, updated_at = NOW()`,
      [student_id, bossLevel]
    );

    // Soal pertama — stripped (tanpa kunci jawaban)
    const q = toClientQuestion(rawQ);

    res.json({
      battle_id: id,
      level: bossLevel,
      boss_hp: state.boss_hp,
      boss_hp_max: state.boss_hp_max,
      phase: state.phase,
      total_phases: state.total_phases,
      hits_landed: state.hits_landed,
      hits_needed: state.hits_needed,
      player_lives: state.player_lives,
      player_lives_max: state.player_lives_max,
      hit_time_limit_ms: HIT_TIME_LIMIT_MS,
      question: q
    });
  } catch (err) {
    console.error('POST /api/boss/start error:', err.message);
    res.status(500).json({ error: 'gagal memulai boss battle' });
  }
});

// ── POST /api/boss/hit ──────────────────────────────────────────────────────
router.post('/hit', async (req, res) => {
  try {
    const { battle_id, answer, time_taken_ms, timed_out } = req.body || {};
    if (!battle_id) return res.status(400).json({ error: 'battle_id wajib' });

    const br = await db.query(
      "SELECT * FROM boss_battles WHERE id = $1 AND status = 'active'",
      [battle_id]
    );
    const battle = br.rows[0];
    if (!battle) return res.status(404).json({ error: 'BATTLE_NOT_FOUND' });

    // Soal saat ini disimpan di hit_log.current
    const log = battle.hit_log || { hit_times: [], hits: [] };
    const current = log.current;
    if (!current) return res.status(409).json({ error: 'NO_ACTIVE_QUESTION' });

    // Nilai jawaban benar?
    const isCorrect =
      answer !== null && answer !== undefined && answer !== '' &&
      Math.abs(parseFloat(answer) - parseFloat(current.correct_answer)) < 0.01;

    const { state, hitResult } = applyHit(
      {
        boss_hp: battle.boss_hp,
        boss_hp_max: battle.boss_hp_max,
        phase: battle.phase,
        total_phases: battle.total_phases,
        hits_landed: battle.hits_landed,
        hits_needed: battle.hits_needed,
        player_lives: battle.player_lives,
        player_lives_max: battle.player_lives_max,
        streak: battle.streak,
        best_streak: battle.best_streak,
        hit_times: (log.hit_times || [])
      },
      { isCorrect, timeTakenMs: time_taken_ms, timedOut: timed_out === true }
    );

    const outcome = battleOutcome(state);
    const times = summarizeTimes(state.hit_times);

    // Log hit ini
    log.hit_times = state.hit_times;
    log.hits.push({
      n: battle.hits_landed + 1,
      probe_id: current.id || null,
      result: hitResult,
      correct: isCorrect,
      time_ms: Math.min(Math.round(Number(time_taken_ms) || 0), HIT_TIME_LIMIT_MS),
      at: new Date().toISOString()
    });

    // Update DB + siapkan soal berikutnya / hasil akhir
    const finished = outcome !== 'ongoing';
    const rawNext = finished ? null : await drawQuestion(battle.level);
    const nextQuestion = toClientQuestion(rawNext);

    // Simpan kunci jawaban soal berikutnya SERVER-SIDE (raw) —
    // nextQuestion yang dikirim ke klien sudah stripped
    const updatedLog = { ...log, current: rawNext ? { id: rawNext.id, correct_answer: rawNext.answer_value } : null };

    const updateQuery = `
      UPDATE boss_battles SET
        boss_hp = $2, phase = $3, hits_landed = $4,
        player_lives = $5, streak = $6, best_streak = $7,
        avg_hit_time_ms = $8, best_hit_time_ms = $9,
        status = $10, completed_at = $11, result = $12, hit_log = $13
      WHERE id = $1`;
    await db.query(updateQuery, [
      battle.id,
      state.boss_hp,
      state.phase,
      state.hits_landed,
      state.player_lives,
      state.streak,
      state.best_streak,
      times.avg_hit_time_ms,
      times.best_hit_time_ms,
      finished ? (outcome === 'boss_win' ? 'won' : 'lost') : 'active',
      finished ? new Date() : null,
      finished ? outcome : null,
      JSON.stringify(updatedLog)
    ]);

    // Gate terbuka saat menang
    if (outcome === 'boss_win') {
      await db.query(
        `INSERT INTO boss_gate_status (student_id, boss_level, defeated, last_result, best_time_ms)
         VALUES ($1, $2, TRUE, 'boss_win', $3)
         ON CONFLICT (student_id) DO UPDATE SET
           defeated = TRUE, last_result = 'boss_win',
           best_time_ms = LEAST(COALESCE(boss_gate_status.best_time_ms, 999999), $3),
           updated_at = NOW()`,
        [battle.student_id, battle.level, times.best_hit_time_ms]
      );
    } else if (finished) {
      await db.query(
        `UPDATE boss_gate_status SET last_result = $3, updated_at = NOW()
         WHERE student_id = $1 AND boss_level = $2`,
        [battle.student_id, battle.level, outcome]
      );
    }

    res.json({
      hit_result: hitResult,           // 'hit' | 'slow' | 'miss'
      correct: isCorrect,
      boss_hp: state.boss_hp,
      boss_hp_max: state.boss_hp_max,
      phase: state.phase,
      hits_landed: state.hits_landed,
      hits_needed: state.hits_needed,
      player_lives: state.player_lives,
      streak: state.streak,
      best_streak: state.best_streak,
      outcome,                          // 'ongoing' | 'boss_win' | 'boss_lose'
      question: nextQuestion,
      stats: times
    });
  } catch (err) {
    console.error('POST /api/boss/hit error:', err.message);
    res.status(500).json({ error: 'gagal memproses hit' });
  }
});

// ── Helper: ambil soal acak level 9 dari DB ────────────────────────────────
async function drawQuestion(level) {
  const r = await db.query(
    `SELECT e.source_id AS id, e.level_id AS level, e.question_text,
            e.answer_value, e.hint_text, e.operation, e.num1, e.num2
     FROM exercises e
     WHERE e.level_id = $1
     ORDER BY random()
     LIMIT 1`,
    [level]
  );
  if (r.rowCount === 0) return null;
  return r.rows[0];
}

// ── Helper: strip kunci jawaban sebelum dikirim ke klien ───────────────────
function toClientQuestion(q) {
  if (!q) return null;
  return {
    id: q.id,
    level: q.level,
    question_text: q.question_text,
    hint_text: q.hint_text,
    operation: q.operation,
    num1: q.num1,
    num2: q.num2
  };
}

// ── GET /api/boss/status/:studentId ────────────────────────────────────────
router.get('/status/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const gate = await db.query(
      'SELECT * FROM boss_gate_status WHERE student_id = $1',
      [studentId]
    );
    const active = await db.query(
      "SELECT id, level, boss_hp, boss_hp_max, phase, total_phases, hits_landed, hits_needed, player_lives, streak, best_streak, started_at FROM boss_battles WHERE student_id = $1 AND status = 'active'",
      [studentId]
    );
    const history = await db.query(
      "SELECT id, level, result, hits_landed, best_streak, avg_hit_time_ms, best_hit_time_ms, completed_at FROM boss_battles WHERE student_id = $1 AND status != 'active' ORDER BY completed_at DESC NULLS LAST LIMIT 10",
      [studentId]
    );

    res.json({
      gate: gate.rows[0] || { student_id: studentId, boss_level: BOSS_LEVEL, defeated: false, attempts: 0 },
      active_battle: active.rows[0] || null,
      recent_battles: history.rows
    });
  } catch (err) {
    console.error('GET /api/boss/status error:', err.message);
    res.status(500).json({ error: 'gagal memuat status boss' });
  }
});

// ── POST /api/boss/abandon ─────────────────────────────────────────────────
router.post('/abandon', async (req, res) => {
  try {
    const { battle_id, student_id } = req.body || {};
    if (!battle_id && !student_id) {
      return res.status(400).json({ error: 'battle_id atau student_id wajib' });
    }
    const q = battle_id
      ? ["UPDATE boss_battles SET status = 'abandoned', completed_at = NOW() WHERE id = $1 AND status = 'active' RETURNING id", [battle_id]]
      : ["UPDATE boss_battles SET status = 'abandoned', completed_at = NOW() WHERE student_id = $1 AND status = 'active' RETURNING id", [student_id]];
    const r = await db.query(q[0], q[1]);
    res.json({ abandoned: r.rowCount });
  } catch (err) {
    console.error('POST /api/boss/abandon error:', err.message);
    res.status(500).json({ error: 'gagal membatalkan battle' });
  }
});

module.exports = router;

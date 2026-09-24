/**
 * Integration test: boss battle endpoints (start → hit loop → win → gate).
 * Requires the backend server running on PORT (default 3000).
 * Requires: level 9 exercises present in DB (exercises table).
 * Uses a throwaway student row created + cleaned up by this script.
 */
const PORT = process.env.PORT || 3000;
const BASE = `http://localhost:${PORT}/api/boss`;

const db = require('../database/db');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
  console.log('  ✅ ' + msg);
}

async function main() {
  // 1. Create throwaway student placed at level 9
  const studentId = require('crypto').randomUUID();
  await db.query(
    "INSERT INTO students (id, display_id, name, kelas, parent_phone, current_level, trial_level) VALUES ($1, $2, 'TEST BOSS V2', '5', '081000000001', 9, 9)",
    [studentId, 'B' + Math.floor(Math.random() * 9000 + 1000)]
  );
  console.log('[1] student created:', studentId);

  try {
    // 2. START
    const startRes = await fetch(`${BASE}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_id: studentId, level: 9 })
    });
    if (!startRes.ok) throw new Error(`START failed: ${startRes.status} ${await startRes.text()}`);
    const start = await startRes.json();
    console.log('[2] START ok: battle=%s hp=%s/%s lives=%s timeLimit=%sms',
      start.battle_id, start.boss_hp, start.boss_hp_max, start.player_lives, start.hit_time_limit_ms);
    assert(start.boss_hp === 27 && start.total_phases === 3, 'state awal 27 HP / 3 fase');
    assert(start.question && start.question.answer_value === undefined, 'START: answer_value TIDAK bocor ke klien');
    assert(start.question && (start.question.question_text || start.question.num1 !== undefined), 'START: soal terkirim');

  // 3. Hit loop — mainkan sampai selesai (menang ATAU kalah)
  //    Strategi: jawab benar cepat -> hit; sisakan 2 kesalahan agar tidak kalah dulu.
  //    Kunci jawaban diambil dari DB (simulasi server-side — bukan kebocoran API).
  let hp = start.boss_hp;
  let lives = start.player_lives;
  let outcome = 'ongoing';
  let missBudget = 2;
  let hitCount = 0, slowCount = 0, missCount = 0;
  let rounds = 0;

  while (outcome === 'ongoing' && rounds < 60) {
    rounds++;
    const br = await db.query('SELECT hit_log FROM boss_battles WHERE id = $1', [start.battle_id]);
    const current = br.rows[0]?.hit_log?.current;
    assert(current && current.correct_answer !== undefined, `round ${rounds}: soal aktif ada di server`);

    let body;
    if (missBudget > 0 && rounds % 12 === 0) {
      missBudget--;
      body = { battle_id: start.battle_id, answer: 999999, time_taken_ms: 1000 }; // sengaja salah
    } else {
      body = { battle_id: start.battle_id, answer: current.correct_answer, time_taken_ms: 3000 };
    }

    const hitRes = await fetch(`${BASE}/hit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!hitRes.ok) throw new Error(`HIT failed: ${hitRes.status} ${await hitRes.text()}`);
    const hit = await hitRes.json();

    if (hit.question && hit.question.answer_value !== undefined) {
      throw new Error('LEAK: answer_value bocor di respons /hit!');
    }

    hp = hit.boss_hp; lives = hit.player_lives; outcome = hit.outcome;
    if (hit.hit_result === 'hit') hitCount++;
    if (hit.hit_result === 'slow') slowCount++;
    if (hit.hit_result === 'miss') missCount++;
    console.log('  round %d: %s hp=%d lives=%d outcome=%s', rounds, hit.hit_result, hp, lives, outcome);
  }

  console.log('[3] selesai: outcome=%s rounds=%d hit=%d slow=%d miss=%d', outcome, rounds, hitCount, slowCount, missCount);
  assert(['boss_win', 'boss_lose'].includes(outcome), 'battle berakhir dengan outcome final');

  // 4. Gate status
  const statusRes = await fetch(`${BASE}/status/${studentId}`);
  if (!statusRes.ok) throw new Error(`STATUS failed: ${statusRes.status}`);
  const status = await statusRes.json();
  console.log('[4] STATUS: defeated=%s attempts=%s last=%s',
    status.gate.defeated, status.gate.attempts, status.gate.last_result);
  assert(status.gate.attempts >= 1, 'attempts tercatat');
  if (outcome === 'boss_win') {
    assert(status.gate.defeated === true, 'gate TERBUKA setelah menang (defeated=true)');
  } else {
    assert(status.gate.defeated === false, 'gate tetap tertutup setelah kalah');
  }
  assert(status.recent_battles.length >= 1, 'riwayat battle tercatat');
  assert(status.active_battle === null, 'tidak ada battle aktif tersisa');

  // 5. Re-start setelah menang harus 409 GATE_ALREADY_OPEN
  if (outcome === 'boss_win') {
    const reRes = await fetch(`${BASE}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_id: studentId, level: 9 })
    });
    assert(reRes.status === 409, 're-start setelah menang → 409 GATE_ALREADY_OPEN');
  }

  // 6. Level selain 9 harus ditolak
  const badRes = await fetch(`${BASE}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ student_id: studentId, level: 5 })
  });
  assert(badRes.status === 400, 'start level != 9 → 400 INVALID_BOSS_LEVEL');

  console.log('\nSEMUA BOSS INTEGRATION TEST LULUS ✅');
} finally {
  // cleanup
  await db.query('DELETE FROM boss_gate_status WHERE student_id = $1', [studentId]);
  await db.query('DELETE FROM boss_battles WHERE student_id = $1', [studentId]);
  await db.query('DELETE FROM students WHERE id = $1', [studentId]);
  console.log('[cleanup] data test dihapus');
}
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });

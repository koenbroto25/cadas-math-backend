/**
 * Boss Battle Engine — unit test / backtest
 * Run: node src/test/test-boss-engine.js
 */
const {
  HIT_TIME_LIMIT_MS, TOTAL_HITS, PHASES, HITS_PER_PHASE, PLAYER_LIVES,
  newBattleState, applyHit, battleOutcome, summarizeTimes
} = require('../services/bossEngine');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

// T1 — konstanta championship
console.log('T1: Konstanta');
check('HIT_TIME_LIMIT_MS = 6000', HIT_TIME_LIMIT_MS === 6000);
check('TOTAL_HITS = 27 (3 fase x 9)', TOTAL_HITS === 27 && PHASES === 3 && HITS_PER_PHASE === 9);
check('PLAYER_LIVES = 3', PLAYER_LIVES === 3);

// T2 — hit sah mengurangi HP, tanpa syarat streak
console.log('T2: Hit sah');
let s = newBattleState();
let r1 = applyHit(s, { isCorrect: true, timeTakenMs: 3000 });
check('hit: hitResult "hit"', r1.hitResult === 'hit');
check('hit: HP 27 -> 26', r1.state.boss_hp === TOTAL_HITS - 1);
check('hit: streak 1', r1.state.streak === 1);
check('hit: nyawa tetap 3', r1.state.player_lives === 3);

// T3 — benar tapi lambat: NEUTRAL (HP & nyawa utuh, streak reset)
console.log('T3: Benar tapi lambat (speed wall)');
s = newBattleState();
let r3a = applyHit(s, { isCorrect: true, timeTakenMs: 5500 });
check('5.5s benar: hit', r3a.hitResult === 'hit');
let r3b = applyHit(r3a.state, { isCorrect: true, timeTakenMs: 6500 });
check('6.5s benar: "slow"', r3b.hitResult === 'slow');
check('slow: HP tidak berkurang', r3b.state.boss_hp === TOTAL_HITS - 1);
check('slow: nyawa tidak berkurang', r3b.state.player_lives === 3);
check('slow: streak reset', r3b.state.streak === 0);

// T4 — salah/timeout: nyawa -1, streak reset
console.log('T4: Salah / timeout');
s = newBattleState();
let r4a = applyHit(s, { isCorrect: false, timeTakenMs: 2000 });
check('salah: "miss"', r4a.hitResult === 'miss');
check('miss: nyawa 3 -> 2', r4a.state.player_lives === 2);
check('miss: HP utuh', r4a.state.boss_hp === TOTAL_HITS);
let r4b = applyHit(s, { isCorrect: true, timeTakenMs: 7000, timedOut: true });
check('timeout: "miss"', r4b.hitResult === 'miss');
check('timeout: nyawa berkurang', r4b.state.player_lives === 2);

// T5 — phase naik tiap 9 pukulan sah
console.log('T5: Fase');
let s5 = newBattleState();
let cur = { state: s5 };
for (let i = 0; i < 9; i++) cur = applyHit(cur.state, { isCorrect: true, timeTakenMs: 4000 });
check('9 hit: fase 2', cur.state.phase === 2);
for (let i = 0; i < 9; i++) cur = applyHit(cur.state, { isCorrect: true, timeTakenMs: 4000 });
check('18 hit: fase 3', cur.state.phase === 3);
check('18 hit: belum menang', battleOutcome(cur.state) === 'ongoing');

// T6 — BOSS_WIN setelah 27 hit sah
for (let i = 0; i < 9; i++) cur = applyHit(cur.state, { isCorrect: true, timeTakenMs: 4000 });
check('27 hit: BOSS_WIN', battleOutcome(cur.state) === 'boss_win');
check('27 hit: HP 0', cur.state.boss_hp === 0);

// T7 — BOSS_LOSE setelah 3 miss
let s7 = newBattleState();
let c7 = { state: s7 };
for (let i = 0; i < 3; i++) c7 = applyHit(c7.state, { isCorrect: false, timeTakenMs: 1000 });
check('3 miss: BOSS_LOSE', battleOutcome(c7.state) === 'boss_lose');

// T8 — campuran: hit + slow + miss tidak menggantung battle
let s8 = newBattleState();
let c8 = { state: s8 };
c8 = applyHit(c8.state, { isCorrect: true,  timeTakenMs: 3000 }); // hit
c8 = applyHit(c8.state, { isCorrect: true,  timeTakenMs: 9000 }); // slow
c8 = applyHit(c8.state, { isCorrect: false, timeTakenMs: 1000 }); // miss
check('campuran: HP -1 saja', c8.state.boss_hp === TOTAL_HITS - 1);
check('campuran: nyawa -1 saja', c8.state.player_lives === 2);
check('campuran: ongoing', battleOutcome(c8.state) === 'ongoing');

// T9 — summarizeTimes
const st = summarizeTimes(cur.state.hit_times);
check('summarizeTimes: avg & best terisi', st.avg_hit_time_ms === 4000 && st.best_hit_time_ms === 4000);

console.log(`\nHasil: ${pass} lulus, ${fail} gagal`);
process.exit(fail > 0 ? 1 : 0);

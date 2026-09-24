// src/test/test-placement-backtest.js
// FINAL BACKTEST — Placement Engine v2 (speed-first, max L9, early stop 3x)
// Run: node src/test/test-placement-backtest.js
// No DB / server needed — pure engine tests.

const engine = require('../services/placementEngine');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Simulate a full 25-question run from a per-level script:
// { [level]: { n, accuracy, avgTimeMs, timeout? } }
// Produces answers in natural order L1→L11.
function simulate(script, rngSeed = 42) {
  const qs = engine.buildQuestionSet(makeRng(rngSeed));
  const seen = {};
  const answers = [];
  for (const q of qs) {
    const cfg = script[q.level];
    if (!cfg) continue;
    seen[q.level] = (seen[q.level] || 0) + 1;
    const okIdx = Math.ceil(cfg.accuracy * cfg.n); // first N answers correct
    const ok = seen[q.level] <= okIdx;
    const slow = cfg.timeout === true;
    answers.push({
      probeId: q.probeId,
      level: q.level,
      answer: ok ? String(q.correctAnswer) : '-999',
      timeTakenMs: ok && !slow ? cfg.avgTimeMs : engine.TIME_LIMIT_MS,
      timeout: slow || undefined
    });
  }
  return { qs, answers };
}

function lb(result, level) {
  return result.level_breakdown.find((b) => b.level === level);
}

console.log('\n===== PLACEMENT ENGINE V2 — FINAL BACKTEST =====\n');

// ---------- T1: Structure ----------
console.log('[T1] Struktur set soal');
{
  const qs = engine.buildQuestionSet(makeRng(7));
  check('total = 25', qs.length === 25, `got ${qs.length}`);
  const counts = {};
  for (const q of qs) counts[q.level] = (counts[q.level] || 0) + 1;
  let distOk = true;
  for (const [lv, n] of Object.entries(engine.LEVEL_PLAN)) {
    if ((counts[lv] || 0) !== n) distOk = false;
  }
  check('distribusi L1-4@2 L5-9@3 L10-11@1', distOk, JSON.stringify(counts));
  check('levels berurutan 1..11', qs.every((q, i) => i === 0 || qs[i - 1].level <= q.level));
  check('probeId unik', new Set(qs.map(q => q.probeId)).size === 25);
  const leak = engine.toClientQuestions(qs).some(c => 'correctAnswer' in c);
  check('toClientQuestions tanpa correctAnswer', !leak);
  check('konstanta: LIMIT=8000, MAX=9, PASS=0.8, STOP=3',
    engine.TIME_LIMIT_MS === 8000 && engine.MAX_LEVEL === 9 &&
    engine.PASS_ACCURACY === 0.8 && engine.EARLY_STOP_FAILS === 3);
}

// ---------- T2: Perfect student ----------
console.log('[T2] Siswa sempurna (semua benar, cepat) → placed 9');
{
  const script = { 1:{n:2,accuracy:1,avgTimeMs:3000}, 2:{n:2,accuracy:1,avgTimeMs:3500},
    3:{n:2,accuracy:1,avgTimeMs:4000}, 4:{n:2,accuracy:1,avgTimeMs:4500},
    5:{n:3,accuracy:1,avgTimeMs:5000}, 6:{n:3,accuracy:1,avgTimeMs:5500},
    7:{n:3,accuracy:1,avgTimeMs:6000}, 8:{n:3,accuracy:1,avgTimeMs:6500},
    9:{n:3,accuracy:1,avgTimeMs:7000}, 10:{n:1,accuracy:1,avgTimeMs:7500},
    11:{n:1,accuracy:1,avgTimeMs:7900} };
  const { qs, answers } = simulate(script);
  const r = engine.calculatePlacementV2(engine.evaluateAnswers(qs, answers));
  check('placed_level = 9 (MAX)', r.placed_level === 9, `got ${r.placed_level}`);
  check('early_stop_reason = max_level_reached', r.early_stop_reason === 'max_level_reached');
  check('early_stopped = false', r.early_stopped === false);
  check('semua level 1-9 lulus', r.level_breakdown.filter(b => b.level <= 9).every(b => b.passed));
  check('ceiling probe L10/11 ditandai', lb(r,10).is_ceiling_probe && lb(r,11).is_ceiling_probe);
  check('stats.answered = 25', r.stats.answered === 25);
}

// ---------- T3: Accuracy fail ----------
console.log('[T3] Gagal akurasi di L5 → placed 5');
{
  const script = { 1:{n:2,accuracy:1,avgTimeMs:3000}, 2:{n:2,accuracy:1,avgTimeMs:3000},
    3:{n:2,accuracy:1,avgTimeMs:3000}, 4:{n:2,accuracy:1,avgTimeMs:3000},
    5:{n:3,accuracy:2/3,avgTimeMs:4000}, 6:{n:3,accuracy:1,avgTimeMs:4000},
    7:{n:3,accuracy:1,avgTimeMs:4000}, 8:{n:3,accuracy:1,avgTimeMs:4000},
    9:{n:3,accuracy:1,avgTimeMs:4000}, 10:{n:1,accuracy:1,avgTimeMs:4000},
    11:{n:1,accuracy:1,avgTimeMs:4000} };
  const { qs, answers } = simulate(script);
  const r = engine.calculatePlacementV2(engine.evaluateAnswers(qs, answers));
  check('placed_level = 5', r.placed_level === 5, `got ${r.placed_level}`);
  check('L5 reason = accuracy_below_threshold', lb(r,5).reason === 'accuracy_below_threshold');
  check('L1-4 lulus', [1,2,3,4].every(l => lb(r,l).passed));
}

// ---------- T4: Speed fail (correct but slow — realistic raw time) ----------
console.log('[T4] Benar tapi lambat di L7 (avg 9s) → placed 7, speed wall');
{
  const script = { 1:{n:2,accuracy:1,avgTimeMs:3000}, 2:{n:2,accuracy:1,avgTimeMs:3000},
    3:{n:2,accuracy:1,avgTimeMs:3000}, 4:{n:2,accuracy:1,avgTimeMs:3000},
    5:{n:3,accuracy:1,avgTimeMs:4000}, 6:{n:3,accuracy:1,avgTimeMs:4000},
    7:{n:3,accuracy:1,avgTimeMs:9000}, 8:{n:3,accuracy:1,avgTimeMs:4000},
    9:{n:3,accuracy:1,avgTimeMs:4000}, 10:{n:1,accuracy:1,avgTimeMs:4000},
    11:{n:1,accuracy:1,avgTimeMs:4000} };
  const { qs, answers } = simulate(script);
  const r = engine.calculatePlacementV2(engine.evaluateAnswers(qs, answers));
  // 3 soal L7: (8000-cap + 8000-cap + 9000-cap=8000)... simulate kirim avg 9000 per soal
  // → frontend nyata akan kirim timeout=true; di sini raw 9000 > limit → withinTime=false → gagal
  check('L7 lulus = false (raw > 8000)', lb(r,7).passed === false, `passed=${lb(r,7).passed}`);
  check('placed_level = 7', r.placed_level === 7, `got ${r.placed_level}`);
  check('L7 reason = avg_time_above_limit (nilai benar semua)', lb(r,7).reason === 'avg_time_above_limit', lb(r,7).reason);
  check('speed_emphasis = high', r.speed_emphasis === 'high', r.speed_emphasis);
}

// ---------- T5: Timeout path (frontend hard cutoff) ----------
console.log('[T5] Timeout >8s (jalur frontend) → gagal meski nilai benar');
{
  const script = { 1:{n:2,accuracy:1,avgTimeMs:3000}, 2:{n:2,accuracy:1,avgTimeMs:3000},
    3:{n:2,accuracy:1,avgTimeMs:3000}, 4:{n:2,accuracy:1,avgTimeMs:3000},
    5:{n:3,accuracy:1,avgTimeMs:4000}, 6:{n:3,accuracy:1,avgTimeMs:4000},
    7:{n:3,accuracy:1,avgTimeMs:8000,timeout:true}, 8:{n:3,accuracy:1,avgTimeMs:4000},
    9:{n:3,accuracy:1,avgTimeMs:4000}, 10:{n:1,accuracy:1,avgTimeMs:4000},
    11:{n:1,accuracy:1,avgTimeMs:4000} };
  const { qs, answers } = simulate(script);
  const r = engine.calculatePlacementV2(engine.evaluateAnswers(qs, answers));
  check('placed_level = 7 (timeout= gagal)', r.placed_level === 7, `got ${r.placed_level}`);
  check('L7 reason = avg_time_above_limit (speed wall)', lb(r,7).reason === 'avg_time_above_limit', lb(r,7).reason);
  check('L7 correct = 0 (timeout walau benar)', lb(r,7).correct === 0);
  check('speed_emphasis = high', r.speed_emphasis === 'high');
  // 3 soal L7 semuanya timeout berurutan → itu 3 gagal berturut → early stop SAH
  check('early stop terpicu (3 timeout berurutan = 3 gagal)', r.early_stopped === true);
  check('reason = early_stop_3_consecutive_fails',
    r.early_stop_reason === 'early_stop_3_consecutive_fails', r.early_stop_reason);
  check('placed tetap 7 meski early stop (level gagal pertama)', r.placed_level === 7);
  check('stopped_at_question = 17 (14 lulus + 3 timeout)',
    r.stats.stopped_at_question === 17, `got ${r.stats.stopped_at_question}`);
}

// ---------- T6: Early stop ----------
console.log('[T6] Early stop: 3 gagal berturut di awal L3');
{
  // L1, L2 lulus semua; L3: 2 soal gagal + L4 soal pertama gagal → 3 berturut → stop
  const qs = engine.buildQuestionSet(makeRng(21));
  const answers = [];
  let wrongStreak = 0;
  for (const q of qs) {
    let ok = true;
    if (q.level === 3) ok = false;
    if (q.level === 4 && !answers.some(a => a.level === 4) && wrongStreak >= 2) ok = false;
    if (ok) wrongStreak = 0; else wrongStreak++;
    answers.push({ probeId: q.probeId, level: q.level,
      answer: ok ? String(q.correctAnswer) : '-999', timeTakenMs: 3000 });
    if (wrongStreak >= 3) break; // siswa berhenti di sini
  }
  const evaluated = engine.evaluateAnswers(qs, answers);
  const r = engine.calculatePlacementV2(evaluated);
  check('early_stopped = true', r.early_stopped === true);
  check('reason = early_stop_3_consecutive_fails',
    r.early_stop_reason === 'early_stop_3_consecutive_fails', r.early_stop_reason);
  check('placed_level = 3 (level gagal pertama)', r.placed_level === 3, `got ${r.placed_level}`);
  check('stats.stopped_at_question = 7 (2+2+2+1)', r.stats.stopped_at_question === 7,
    `got ${r.stats.stopped_at_question}`);
  check('prerequisite_signals berisi skill L3', Object.keys(r.prerequisite_signals).length > 0);
}

// ---------- T7: 2 gagal lalu sukses → TIDAK early stop ----------
console.log('[T7] 2 gagal lalu berhasil → lanjut, tidak early stop');
{
  const qs = engine.buildQuestionSet(makeRng(31));
  const answers = [];
  const seenL5 = {};
  for (const q of qs) {
    seenL5[q.level] = (seenL5[q.level] || 0) + 1;
    // hanya 2 soal pertama L5 yang gagal; soal ke-3 benar → streak reset
    const ok = !(q.level === 5 && seenL5[q.level] <= 2);
    answers.push({ probeId: q.probeId, level: q.level,
      answer: ok ? String(q.correctAnswer) : '-999', timeTakenMs: 3000 });
  }
  const r = engine.calculatePlacementV2(engine.evaluateAnswers(qs, answers));
  check('early_stopped = false', r.early_stopped === false);
  check('placed_level = 5', r.placed_level === 5, `got ${r.placed_level}`);
}

// ---------- T8: Edge cases ----------
console.log('[T8] Edge cases');
{
  const empty = engine.calculatePlacementV2([]);
  check('jawaban kosong → placed 1', empty.placed_level === 1);
  check('jawaban kosong → reason no_answers', empty.early_stop_reason === 'no_answers');

  const qs = engine.buildQuestionSet(makeRng(41));
  const answers = qs.map(q => ({ probeId: q.probeId, level: q.level,
    answer: '-999' })); // salah semua, tanpa timeTakenMs
  const r = engine.calculatePlacementV2(engine.evaluateAnswers(qs, answers));
  check('salah + waktu undefined → early stop → placed 1', r.placed_level === 1,
    `got ${r.placed_level}`);
  check('early_stopped = true', r.early_stopped === true);

  const r2 = engine.calculatePlacementV2(engine.evaluateAnswers(qs,
    [{ probeId: 'XXX', level: 99, answer: '1', timeTakenMs: 100 }]));
  check('probeId asing → di-skip (placed 1)', r2.placed_level === 1);
}




console.log('\n===== HASIL: ' + pass + ' lulus, ' + fail + ' gagal =====');
if (fail > 0) process.exit(1);

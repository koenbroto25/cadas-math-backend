/**
 * Placement Engine v2 — speed-first placement
 *
 * Rules (Placement_Test_System.md §5):
 *   - 25 questions: L1-4 @2 each, L5-9 @3 each, L10-11 @1 each (10/11 = ceiling probe)
 *   - Hard time limit 8000 ms per question (timeout = fail, question auto-skipped by frontend)
 *   - An answer counts as PASSED only if the value is correct AND submitted within the time limit
 *     (correct-but-slow = FAIL — speed is the primary benchmark)
 *   - A level is PASSED iff accuracy >= 80% AND avg_time <= 8000 ms
 *   - placed_level = FIRST failed level (student must master speed+accuracy there), clamped 1..9
 *   - If every tested level passes → placed_level = 9 (MAX; championship gate at L9)
 *   - Early stop after 3 consecutive fails (wrong OR timeout) — placement ends immediately
 *   - Levels 10-11 probes never raise placement above 9
 */

const fs = require('fs');
const path = require('path');

const TIME_LIMIT_MS = 8000;          // hard cutoff per question (speed priority)
const MAX_LEVEL = 9;                 // placement ceiling (boss battle gate at L9)
const PASS_ACCURACY = 0.8;           // level pass threshold
const EARLY_STOP_FAILS = 3;          // consecutive fails → stop test

// Question distribution across levels (total = 25)
const LEVEL_PLAN = { 1: 2, 2: 2, 3: 2, 4: 2, 5: 3, 6: 3, 7: 3, 8: 3, 9: 3, 10: 1, 11: 1 };
const TOTAL_QUESTIONS = Object.values(LEVEL_PLAN).reduce((a, b) => a + b, 0); // 25

// Probe catalog (self-contained JSON, no DB dependency)
const CATALOG_DIR = path.join(__dirname, '..', '..', '..', 'speed-math-master', 'data', 'placement_catalog');
const CATALOG_MIN_LEVEL = 1;
const CATALOG_MAX_LEVEL = 11;

let catalogCache = null;

function loadCatalog() {
  if (catalogCache) return catalogCache;
  const catalog = {};
  for (let lv = CATALOG_MIN_LEVEL; lv <= CATALOG_MAX_LEVEL; lv++) {
    const file = path.join(CATALOG_DIR, `probes_l${lv}.json`);
    if (!fs.existsSync(file)) {
      throw new Error(`Placement probe catalog missing: ${file}`);
    }
    const probes = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(probes) || probes.length === 0) {
      throw new Error(`Placement probe catalog empty for level ${lv}`);
    }
    catalog[lv] = probes;
  }
  catalogCache = catalog;
  return catalog;
}

function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Build a 25-question set from the catalog.
 * Distribution follows LEVEL_PLAN; for levels with >= 2 questions the first
 * pick is forced to a 'core' probe when available (fair sampling).
 * Returns ordered questions INCLUDING correctAnswer (server-side only —
 * never send to client; use toClientQuestions()).
 */
function buildQuestionSet(rng = Math.random) {
  const catalog = loadCatalog();
  const set = [];
  const levels = Object.keys(LEVEL_PLAN).map(Number).sort((a, b) => a - b);
  for (const lv of levels) {
    const count = LEVEL_PLAN[lv];
    let pool = shuffle(catalog[lv], rng);
    if (count >= 2 && pool.length > count) {
      const coreIdx = pool.findIndex((p) => p.probe_type === 'core');
      if (coreIdx >= count) {
        const [core] = pool.splice(coreIdx, 1);
        pool.unshift(core);
      }
    }
    const picked = pool.slice(0, Math.min(count, pool.length));
    for (const p of picked) {
      set.push({
        probeId: p.placement_id,
        level: lv,
        probeType: p.probe_type || 'core',
        skillArea: p.skill_area || 'general',
        problemText: p.problem_text,
        correctAnswer: p.correct_answer,
        order: set.length + 1
      });
    }
  }
  if (set.length !== TOTAL_QUESTIONS) {
    throw new Error(`Question set incomplete: ${set.length}/${TOTAL_QUESTIONS}`);
  }
  return set;
}

/** Strip correctAnswer — safe payload for the client. */
function toClientQuestions(questionSet) {
  return (questionSet || []).map((q) => ({
    probeId: q.probeId,
    level: q.level,
    probeType: q.probeType,
    skillArea: q.skillArea,
    problemText: q.problemText,
    order: q.order
  }));
}

/**
 * Evaluate raw client answers against the stored question set.
 * 'correct' on the result means PASSED = right value AND within time.
 * Timeout answers (or missing time) count as fail with time capped at limit.
 */
function evaluateAnswers(questionSet, answers) {
  const byId = {};
  for (const q of questionSet) byId[q.probeId] = q;

  const evaluated = [];
  for (const a of (answers || [])) {
    const probeId = a.probeId || a.exerciseId;
    const q = byId[probeId];
    if (!q) continue; // unknown probe — defensive skip

    const timedOut = a.timeout === true;
    const timeRaw = Number(a.timeTakenMs);
    const effectiveTime = Number.isFinite(timeRaw) && timeRaw >= 0
      ? timeRaw
      : TIME_LIMIT_MS; // missing/invalid time treated as at-limit
    const withinTime = !timedOut && effectiveTime <= TIME_LIMIT_MS;

    const answerValue = a.answer;
    const isCorrectValue =
      answerValue !== null && answerValue !== undefined && answerValue !== '' &&
      Math.abs(parseFloat(answerValue) - parseFloat(q.correctAnswer)) < 0.01;

    evaluated.push({
      probeId: q.probeId,
      level: q.level,
      probeType: q.probeType,
      skillArea: q.skillArea,
      correct: withinTime && isCorrectValue, // speed + accuracy
      answeredCorrectly: isCorrectValue,
      timedOut,
      timeTakenMs: Math.min(Math.round(effectiveTime), TIME_LIMIT_MS),
      userAnswer: answerValue === undefined ? null : answerValue,
      correctAnswer: q.correctAnswer
    });
  }
  return evaluated;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Core placement calculation (v2).
 *
 * @param {Array} answers - evaluated answers in SUBMISSION order
 *   (see evaluateAnswers). Order matters for the early-stop rule.
 */
function calculatePlacementV2(answers) {
  if (!answers || answers.length === 0) {
    return {
      placed_level: 1,
      level_breakdown: [],
      early_stopped: false,
      early_stop_reason: 'no_answers',
      prerequisite_signals: {},
      speed_emphasis: 'low',
      accuracy_by_level: {},
      speed_by_level: {},
      stats: { total_questions: TOTAL_QUESTIONS, answered: 0, correct: 0, stopped_at_question: null }
    };
  }

  // ---- 1. Early-stop scan (submission order) -------------------------------
  let consecutive = 0;
  let earlyStopped = false;
  let stoppedAtQuestion = null;
  for (let idx = 0; idx < answers.length; idx++) {
    if (earlyStopped) break;
    if (!answers[idx].correct) {
      consecutive += 1;
      if (consecutive >= EARLY_STOP_FAILS) {
        earlyStopped = true;
        stoppedAtQuestion = idx + 1;
      }
    } else {
      consecutive = 0;
    }
  }

  // ---- 2. Per-level stats (tested levels only) -----------------------------
  const byLevel = {};
  for (const a of answers) {
    (byLevel[a.level] = byLevel[a.level] || []).push(a);
  }
  const tested = [];
  for (const lv of Object.keys(byLevel).map(Number).sort((x, y) => x - y)) {
    const items = byLevel[lv];
    const correct = items.filter((i) => i.correct).length;
    const accuracy = correct / items.length;
    const avgTime = Math.round(
      items.reduce((s, i) => s + (Number.isFinite(i.timeTakenMs) ? i.timeTakenMs : TIME_LIMIT_MS), 0) / items.length
    );
    const passed = accuracy >= PASS_ACCURACY && avgTime <= TIME_LIMIT_MS;
    // Alasan kegagalan: jika nilai jawaban sebenarnya sudah mencapai ambang
    // (tapi gagal karena waktu/timeout) → speed wall. Jika nilainya memang
    // di bawah ambang → masalah akurasi. Sisanya (input mentah/legacy) → waktu.
    let reason = null;
    if (!passed) {
      const valueAccuracy = items.filter((i) => i.answeredCorrectly).length / items.length;
      if (valueAccuracy >= PASS_ACCURACY) reason = 'avg_time_above_limit';
      else if (accuracy < PASS_ACCURACY) reason = 'accuracy_below_threshold';
      else reason = 'avg_time_above_limit';
    }
    tested.push({
      level: lv,
      questions_given: items.length,
      correct,
      accuracy: round2(accuracy),
      avg_time_ms: avgTime,
      passed,
      reason,
      is_ceiling_probe: lv > MAX_LEVEL
    });
  }

  // ---- 3. Full breakdown 1..9 (+ ceiling probes), untested flagged ---------
  const testedMap = {};
  for (const lb of tested) testedMap[lb.level] = lb;
  const levelBreakdown = [];
  for (let lv = 1; lv <= MAX_LEVEL; lv++) {
    levelBreakdown.push(
      testedMap[lv] || {
        level: lv,
        questions_given: 0,
        correct: 0,
        accuracy: 0,
        avg_time_ms: 0,
        passed: false,
        reason: 'not_tested',
        is_ceiling_probe: false
      }
    );
  }
  for (const lb of tested) {
    if (lb.level > MAX_LEVEL) levelBreakdown.push(lb);
  }

  // ---- 4. placed_level = first failed tested level, clamped 1..MAX ---------
  const firstFailed = levelBreakdown.find(
    (lb) => !lb.passed && lb.reason !== 'not_tested' && lb.level <= MAX_LEVEL
  );
  let placedLevel = firstFailed ? firstFailed.level : MAX_LEVEL;
  placedLevel = Math.min(MAX_LEVEL, Math.max(1, placedLevel));

  // ---- 5. early stop reason ------------------------------------------------
  let earlyStopReason;
  if (earlyStopped) {
    earlyStopReason = 'early_stop_3_consecutive_fails';
  } else if (!firstFailed || firstFailed.level > MAX_LEVEL) {
    earlyStopReason = 'max_level_reached';
  } else {
    earlyStopReason = 'completed_all_questions';
  }

  // ---- 6. prerequisite signals (skills to remediate) -----------------------
  const prerequisiteSignals = {};
  for (const lb of levelBreakdown) {
    if (lb.passed || lb.reason === 'not_tested' || lb.level > placedLevel) continue;
    const items = byLevel[lb.level];
    const skillFails = {};
    for (const item of items) {
      if (item.correct) continue;
      const skill = item.skillArea || 'general';
      skillFails[skill] = (skillFails[skill] || 0) + 1;
    }
    for (const [skill, count] of Object.entries(skillFails)) {
      prerequisiteSignals[skill] = round2(count / items.length);
    }
  }

  // ---- 7. speed emphasis from the first failed level -----------------------
  // 'high' jika waktu jelas masalahnya (rata-rata mendekati/melewati limit),
  // 'medium' jika cukup lambat, selainnya 'low'.
  let speedEmphasis = 'low';
  if (firstFailed) {
    if (firstFailed.avg_time_ms >= TIME_LIMIT_MS * 0.95) speedEmphasis = 'high';
    else if (firstFailed.avg_time_ms >= TIME_LIMIT_MS * 0.75) speedEmphasis = 'medium';
  }

  // ---- 8. backward-compatible maps -----------------------------------------
  const accuracyByLevel = {};
  const speedByLevel = {};
  for (const lb of tested) {
    accuracyByLevel[lb.level] = lb.accuracy;
    speedByLevel[lb.level] = round2(lb.avg_time_ms / TIME_LIMIT_MS);
  }

  return {
    placed_level: placedLevel,
    level_breakdown: levelBreakdown,
    early_stopped: earlyStopped,
    early_stop_reason: earlyStopReason,
    prerequisite_signals: prerequisiteSignals,
    speed_emphasis: speedEmphasis,
    accuracy_by_level: accuracyByLevel,
    speed_by_level: speedByLevel,
    stats: {
      total_questions: TOTAL_QUESTIONS,
      answered: answers.length,
      correct: answers.filter((a) => a.correct).length,
      stopped_at_question: stoppedAtQuestion
    }
  };
}

module.exports = {
  TIME_LIMIT_MS,
  MAX_LEVEL,
  PASS_ACCURACY,
  EARLY_STOP_FAILS,
  LEVEL_PLAN,
  TOTAL_QUESTIONS,
  loadCatalog,
  buildQuestionSet,
  toClientQuestions,
  evaluateAnswers,
  calculatePlacementV2
};

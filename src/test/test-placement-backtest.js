/**
 * Placement Test Backtest
 * 
 * Simulates different student scenarios to verify placement algorithm.
 * Run with: node src/test/test-placement-backtest.js
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'cadas_app_dev'
});

// Target times from SPEED_TARGETS_QUICK_REFERENCE (ms)
const TARGET_TIMES = {
  1: 15000, 2: 12000, 3: 10000, 4: 9000, 5: 8000,
  6: 9000, 7: 9000, 8: 8000, 9: 6000, 10: 13500,
  11: 17500, 12: 17500, 13: 25000, 14: 25000, 15: 10000
};

/**
 * Calculate placement result (same logic as API)
 */
function calculatePlacement(answers) {
  if (!answers || answers.length === 0) {
    return { placed_level: 1, prerequisite_signals: {}, speed_emphasis: 'low' };
  }

  const byLevel = {};
  for (const a of answers) {
    if (!byLevel[a.level]) byLevel[a.level] = [];
    byLevel[a.level].push(a);
  }

  const accuracyByLevel = {};
  for (const [level, items] of Object.entries(byLevel)) {
    const correct = items.filter(a => a.correct).length;
    accuracyByLevel[parseInt(level)] = correct / items.length;
  }

  const speedByLevel = {};
  for (const [level, items] of Object.entries(byLevel)) {
    const times = items.filter(a => a.timeTakenMs).map(a => a.timeTakenMs);
    if (times.length > 0) {
      const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
      const target = TARGET_TIMES[parseInt(level)] || 10000;
      speedByLevel[parseInt(level)] = Math.round((avgTime / target) * 100) / 100;
    }
  }

  let placedLevel = 1;
  const sortedLevels = Object.keys(accuracyByLevel).map(Number).sort((a, b) => b - a);
  for (const level of sortedLevels) {
    if (accuracyByLevel[level] >= 0.8) {
      placedLevel = level;
      break;
    }
  }

  const prerequisiteSignals = {};
  for (const [level, items] of Object.entries(byLevel)) {
    const l = parseInt(level);
    const correct = items.filter(a => a.correct).length;
    const accuracy = correct / items.length;

    if (accuracy < 0.8 && l <= placedLevel) {
      const skillAreas = {};
      for (const item of items) {
        if (!item.correct) {
          const skill = item.skillArea || 'general';
          skillAreas[skill] = (skillAreas[skill] || 0) + 1;
        }
      }
      for (const [skill, count] of Object.entries(skillAreas)) {
        prerequisiteSignals[skill] = Math.round((1 - count / items.length) * 100) / 100;
      }
    }
  }

  let speedEmphasis = 'low';
  const placedSpeed = speedByLevel[placedLevel];
  if (placedSpeed !== undefined) {
    if (placedSpeed > 1.5) speedEmphasis = 'high';
    else if (placedSpeed > 1.2) speedEmphasis = 'medium';
  }

  return {
    placed_level: placedLevel,
    prerequisite_signals: prerequisiteSignals,
    speed_emphasis: speedEmphasis,
    accuracy_by_level: accuracyByLevel,
    speed_by_level: speedByLevel
  };
}

/**
 * Test Scenarios
 */
const scenarios = [
  {
    name: 'SD Kelas 1 - Pemula (Visual Only)',
    description: 'Anak baru mulai, hanya bisa soal visual level 1-2',
    answers: [
      { level: 1, skillArea: 'addition_facts', correct: true, timeTakenMs: 12000 },
      { level: 1, skillArea: 'addition_facts', correct: true, timeTakenMs: 14000 },
      { level: 3, skillArea: 'addition_facts', correct: true, timeTakenMs: 15000 },
      { level: 3, skillArea: 'addition_facts', correct: false, timeTakenMs: 20000 },
      { level: 3, skillArea: 'addition_facts', correct: true, timeTakenMs: 18000 },
      { level: 3, skillArea: 'addition_facts', correct: false, timeTakenMs: 25000 },
      { level: 5, skillArea: 'addition_facts', correct: false, timeTakenMs: 30000 },
      { level: 5, skillArea: 'addition_facts', correct: false, timeTakenMs: 35000 },
    ],
    expectedLevel: 1,
    expectedSpeedEmphasis: 'low'
  },
  {
    name: 'SD Kelas 2 - Lancar Visual',
    description: 'Anak bisa soal visual level 3-4 dengan cepat',
    answers: [
      { level: 1, skillArea: 'addition_facts', correct: true, timeTakenMs: 8000 },
      { level: 1, skillArea: 'addition_facts', correct: true, timeTakenMs: 9000 },
      { level: 3, skillArea: 'addition_facts', correct: true, timeTakenMs: 7000 },
      { level: 3, skillArea: 'addition_facts', correct: true, timeTakenMs: 8000 },
      { level: 3, skillArea: 'addition_facts', correct: true, timeTakenMs: 7500 },
      { level: 3, skillArea: 'addition_facts', correct: true, timeTakenMs: 8500 },
      { level: 5, skillArea: 'addition_facts', correct: true, timeTakenMs: 12000 },
      { level: 5, skillArea: 'addition_facts', correct: false, timeTakenMs: 18000 },
    ],
    expectedLevel: 3,
    expectedSpeedEmphasis: 'low'
  },
  {
    name: 'SD Kelas 3 - Menengah',
    description: 'Anak accuracy 75% di Level 5 (below 80%), placed di Level 3',
    answers: [
      { level: 3, skillArea: 'addition_facts', correct: true, timeTakenMs: 6000 },
      { level: 3, skillArea: 'subtraction_facts', correct: true, timeTakenMs: 7000 },
      { level: 5, skillArea: 'addition_facts', correct: true, timeTakenMs: 7000 },
      { level: 5, skillArea: 'addition_facts', correct: true, timeTakenMs: 7500 },
      { level: 5, skillArea: 'subtraction_facts', correct: true, timeTakenMs: 8000 },
      { level: 5, skillArea: 'subtraction_facts', correct: false, timeTakenMs: 12000 },
      { level: 7, skillArea: 'subtraction_facts', correct: false, timeTakenMs: 15000 },
      { level: 7, skillArea: 'subtraction_facts', correct: true, timeTakenMs: 20000 },
    ],
    expectedLevel: 3,
    expectedSpeedEmphasis: 'low'
  },
  {
    name: 'SD Kelas 3 - Menengah (v2)',
    description: 'Anak accuracy 83% di Level 5, placed di Level 5',
    answers: [
      { level: 3, skillArea: 'addition_facts', correct: true, timeTakenMs: 6000 },
      { level: 3, skillArea: 'subtraction_facts', correct: true, timeTakenMs: 7000 },
      { level: 5, skillArea: 'addition_facts', correct: true, timeTakenMs: 7000 },
      { level: 5, skillArea: 'addition_facts', correct: true, timeTakenMs: 7500 },
      { level: 5, skillArea: 'subtraction_facts', correct: true, timeTakenMs: 8000 },
      { level: 5, skillArea: 'subtraction_facts', correct: true, timeTakenMs: 8500 },
      { level: 7, skillArea: 'subtraction_facts', correct: false, timeTakenMs: 15000 },
      { level: 7, skillArea: 'subtraction_facts', correct: false, timeTakenMs: 20000 },
    ],
    expectedLevel: 5,
    expectedSpeedEmphasis: 'low'
  }
];

module.exports = { calculatePlacement, TARGET_TIMES, scenarios };
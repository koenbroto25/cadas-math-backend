/**
 * Placement Test Backtest - Part 2 (Main Function)
 * 
 * Run with: node src/test/test-placement-backtest-2.js
 */

const { calculatePlacement } = require('./test-placement-backtest');

const scenarios = [
  {
    name: 'SD Kelas 4 - Mahir Perkalian',
    description: 'Anak lancar multiplication tables level 9',
    answers: [
      { level: 7, skillArea: 'subtraction_facts', correct: true, timeTakenMs: 5000 },
      { level: 7, skillArea: 'subtraction_facts', correct: true, timeTakenMs: 6000 },
      { level: 9, skillArea: 'multiplication_tables', correct: true, timeTakenMs: 4500 },
      { level: 9, skillArea: 'multiplication_tables', correct: true, timeTakenMs: 5000 },
      { level: 9, skillArea: 'multiplication_tables', correct: true, timeTakenMs: 5500 },
      { level: 9, skillArea: 'multiplication_tables', correct: true, timeTakenMs: 4800 },
      { level: 11, skillArea: 'multiplication_tables', correct: false, timeTakenMs: 20000 },
      { level: 11, skillArea: 'multiplication_tables', correct: true, timeTakenMs: 25000 },
    ],
    expectedLevel: 9,
    expectedSpeedEmphasis: 'low'
  },
  {
    name: 'SD Kelas 5 - Cepat tapi Tidak Akurat',
    description: 'Anak menjawab cepat tapi accuracy Level 8 hanya 75% (below 80%)',
    answers: [
      { level: 5, skillArea: 'addition_facts', correct: true, timeTakenMs: 3000 },
      { level: 5, skillArea: 'subtraction_facts', correct: true, timeTakenMs: 3500 },
      { level: 8, skillArea: 'subtraction_facts', correct: true, timeTakenMs: 15000 },
      { level: 8, skillArea: 'subtraction_facts', correct: true, timeTakenMs: 18000 },
      { level: 8, skillArea: 'subtraction_facts', correct: false, timeTakenMs: 20000 },
      { level: 8, skillArea: 'subtraction_facts', correct: true, timeTakenMs: 16000 },
      { level: 10, skillArea: 'multiplication_tables', correct: false, timeTakenMs: 25000 },
      { level: 10, skillArea: 'multiplication_tables', correct: false, timeTakenMs: 30000 },
    ],
    expectedLevel: 5,
    expectedSpeedEmphasis: 'low'
  },
  {
    name: 'SD Kelas 5 - Cepat tapi Tidak Akurat (v2)',
    description: 'Anak accuracy 80% di Level 8 tapi speed lambat (speed emphasis: high)',
    answers: [
      { level: 5, skillArea: 'addition_facts', correct: true, timeTakenMs: 3000 },
      { level: 5, skillArea: 'subtraction_facts', correct: true, timeTakenMs: 3500 },
      { level: 8, skillArea: 'subtraction_facts', correct: true, timeTakenMs: 15000 },
      { level: 8, skillArea: 'subtraction_facts', correct: true, timeTakenMs: 18000 },
      { level: 8, skillArea: 'subtraction_facts', correct: false, timeTakenMs: 20000 },
      { level: 8, skillArea: 'subtraction_facts', correct: true, timeTakenMs: 16000 },
      { level: 8, skillArea: 'subtraction_facts', correct: true, timeTakenMs: 14000 },
      { level: 10, skillArea: 'multiplication_tables', correct: false, timeTakenMs: 25000 },
    ],
    expectedLevel: 8,
    expectedSpeedEmphasis: 'high'
  },
  {
    name: 'SD Kelas 6 - UTBK Ready',
    description: 'Anak accuracy 75% di Level 13 (below 80%), placed di Level 11',
    answers: [
      { level: 11, skillArea: 'multiplication_tables', correct: true, timeTakenMs: 10000 },
      { level: 11, skillArea: 'division_basics', correct: true, timeTakenMs: 12000 },
      { level: 13, skillArea: 'fractions', correct: true, timeTakenMs: 18000 },
      { level: 13, skillArea: 'fractions', correct: true, timeTakenMs: 20000 },
      { level: 13, skillArea: 'fractions', correct: true, timeTakenMs: 22000 },
      { level: 13, skillArea: 'fractions', correct: false, timeTakenMs: 30000 },
      { level: 15, skillArea: 'mixed_operations', correct: true, timeTakenMs: 12000 },
      { level: 15, skillArea: 'mixed_operations', correct: false, timeTakenMs: 20000 },
    ],
    expectedLevel: 11,
    expectedSpeedEmphasis: 'low'
  },
  {
    name: 'SD Kelas 6 - UTBK Ready (v2)',
    description: 'Anak accuracy 100% di Level 15, placed di Level 15 (ceiling)',
    answers: [
      { level: 11, skillArea: 'multiplication_tables', correct: true, timeTakenMs: 10000 },
      { level: 11, skillArea: 'division_basics', correct: true, timeTakenMs: 12000 },
      { level: 13, skillArea: 'fractions', correct: true, timeTakenMs: 18000 },
      { level: 13, skillArea: 'fractions', correct: true, timeTakenMs: 20000 },
      { level: 13, skillArea: 'fractions', correct: true, timeTakenMs: 22000 },
      { level: 13, skillArea: 'fractions', correct: true, timeTakenMs: 19000 },
      { level: 13, skillArea: 'fractions', correct: false, timeTakenMs: 30000 },
      { level: 15, skillArea: 'mixed_operations', correct: true, timeTakenMs: 12000 },
    ],
    expectedLevel: 15,
    expectedSpeedEmphasis: 'low'
  }
];

async function runBacktest() {
  console.log('=== Placement Test Backtest ===\n');
  console.log(`Total scenarios: ${scenarios.length}\n`);

  let passed = 0;
  let failed = 0;

  for (const scenario of scenarios) {
    console.log(`\n--- ${scenario.name} ---`);
    console.log(`Description: ${scenario.description}`);
    
    const result = calculatePlacement(scenario.answers);
    
    const levelMatch = result.placed_level === scenario.expectedLevel;
    const speedMatch = result.speed_emphasis === scenario.expectedSpeedEmphasis;
    const success = levelMatch && speedMatch;
    
    if (success) {
      passed++;
      console.log(`✅ PASSED`);
    } else {
      failed++;
      console.log(`❌ FAILED`);
    }
    
    console.log(`  Expected: Level ${scenario.expectedLevel}, Speed ${scenario.expectedSpeedEmphasis}`);
    console.log(`  Got:      Level ${result.placed_level}, Speed ${result.speed_emphasis}`);
    console.log(`  Accuracy by level: ${JSON.stringify(result.accuracy_by_level)}`);
    console.log(`  Speed by level: ${JSON.stringify(result.speed_by_level)}`);
    
    if (Object.keys(result.prerequisite_signals).length > 0) {
      console.log(`  Prerequisite signals: ${JSON.stringify(result.prerequisite_signals)}`);
    }
  }

  console.log(`\n=== Backtest Complete ===`);
  console.log(`Passed: ${passed}/${scenarios.length}`);
  console.log(`Failed: ${failed}/${scenarios.length}`);
  
  if (failed === 0) {
    console.log(`\n✅ All scenarios passed! Placement algorithm is working correctly.`);
  } else {
    console.log(`\n⚠️ Some scenarios failed. Review the algorithm.`);
  }
}

runBacktest().catch(console.error);
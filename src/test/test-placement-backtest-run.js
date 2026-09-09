/**
 * Placement Test Backtest - Run All Scenarios
 * 
 * Run with: node src/test/test-placement-backtest-run.js
 */

const { calculatePlacement, scenarios: scenarios1 } = require('./test-placement-backtest');

const scenarios2 = [
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
    name: 'SD Kelas 5 - Accuracy 75% di Level 8',
    description: 'Anak accuracy Level 8 hanya 75% (below 80%), placed di Level 5',
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
  }
];

const allScenarios = [...scenarios1, ...scenarios2];

async function runBacktest() {
  console.log('=== Placement Test Backtest (All Scenarios) ===\n');
  console.log(`Total scenarios: ${allScenarios.length}\n`);

  let passed = 0;
  let failed = 0;

  for (const scenario of allScenarios) {
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
  console.log(`Passed: ${passed}/${allScenarios.length}`);
  console.log(`Failed: ${failed}/${allScenarios.length}`);
  
  if (failed === 0) {
    console.log(`\n✅ All scenarios passed! Placement algorithm is working correctly.`);
  } else {
    console.log(`\n⚠️ Some scenarios failed. Review the algorithm.`);
  }
}

runBacktest().catch(console.error);
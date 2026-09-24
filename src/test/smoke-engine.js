// Smoke test: engine loads + integration file still in sync with engine API
const engine = require('../services/placementEngine');
const assert = require('assert');

assert(engine && typeof engine.buildQuestionSet === 'function', 'engine load');
assert(typeof engine.evaluateAnswers === 'function');
assert(typeof engine.calculatePlacementV2 === 'function');

const qs = engine.buildQuestionSet();
assert(qs.length === 25, '25 soal');
console.log('ENGINE-LOAD-OK: engine + API surface OK,', qs.length, 'soal');

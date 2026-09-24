/**
 * Compatibility export for the marketing core fee engine.
 * The v2 engine remains the single source of truth.
 */
const engine = require('./fee-matrix-v2');
module.exports = engine;

/**
 * AskKak LLM Quota Rules
 * Reference: [ADD] §3.2
 * Estimate: ~40 LLM calls per level
 */

const QUOTA_CONFIG = {
  llmCallsPerLevel: 40,
  quotaResetMode: 'cumulative',
  
  pricing: {
    singleLevelIdr: 40000,
    basicBundleIdr: 100000,
    premiumBundleIdr: 165000,
  },

  description: {
    llmCallsPerLevel: 'Total LLM calls available per purchased level',
    quotaResetMode: 'cumulative = one-time; monthly = resets each month',
    estimateBasis: '150 questions/level * 25% LLM * 75% cache hit'
  }
};

module.exports = QUOTA_CONFIG;

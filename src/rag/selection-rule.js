/**
 * Selection Rule — generic engine for choosing explanation variant.
 * Implements FASE 8.3b of final_plan_v1.1.md
 *
 * Priority order:
 * 1. Real performance data (student_explanation_effectiveness)
 * 2. Placement bias (student_variant_bias with source='placement')
 * 3. Default rule (2 failures → check speed → offer Quick or Visual)
 */

const db = require('../database/db');

/**
 * Select the best explanation variant for a student at a given concept.
 * @param {string} studentId - UUID
 * @param {number} level - level number
 * @param {string} conceptId - UUID (optional)
 * @param {object} options - { attemptNumber, accuracy, avgTimeMs, targetTimeMs }
 * @returns {Promise<{variantId:string, source:string, offerFromAttempt:number}>}
 */
async function selectExplanationVariant(studentId, level, conceptId, options = {}) {
  // Step 1: Check real performance data
  const perfData = await db.query(
    `SELECT variant_used, times_shown, times_helpful,
            CASE WHEN times_shown > 0 THEN times_helpful::float / times_shown ELSE 0 END AS effectiveness
     FROM student_explanation_effectiveness
     WHERE student_id = $1 AND concept_id = $2
     ORDER BY effectiveness DESC, times_shown DESC
     LIMIT 1`,
    [studentId, conceptId]
  );

  if (perfData.rows.length > 0 && perfData.rows[0].times_shown > 0) {
    return {
      variantId: perfData.rows[0].variant_used,
      source: 'performance',
      offerFromAttempt: 2,
      effectiveness: perfData.rows[0].effectiveness,
    };
  }

  // Step 2: Check placement bias
  const bias = await db.query(
    `SELECT variant_id, offer_from_attempt
     FROM student_variant_bias
     WHERE student_id = $1 AND level = $2 AND source = 'placement'
     ORDER BY offer_from_attempt ASC
     LIMIT 1`,
    [studentId, level]
  );

  if (bias.rows.length > 0) {
    return {
      variantId: bias.rows[0].variant_id,
      source: 'placement',
      offerFromAttempt: bias.rows[0].offer_from_attempt,
    };
  }

  // Step 3: Default rule
  const attemptNumber = options.attemptNumber || 1;

  // First attempt: always Main Explanation (standard)
  if (attemptNumber <= 1) {
    return {
      variantId: 'main',
      source: 'default',
      offerFromAttempt: 1,
    };
  }

  // After 2 failures: check speed data
  if (attemptNumber >= 2) {
    const accuracy = options.accuracy;
    const avgTimeMs = options.avgTimeMs;
    const targetTimeMs = options.targetTimeMs;

    if (accuracy !== undefined && avgTimeMs !== undefined && targetTimeMs !== undefined) {
      const isAccurate = accuracy >= 0.8;
      const isFast = avgTimeMs <= targetTimeMs;

      if (isAccurate && !isFast) {
        // Accurate but slow → offer Quick Method
        return {
          variantId: 'quick',
          source: 'default_speed_rule',
          offerFromAttempt: 2,
          reason: 'accurate_but_slow',
        };
      } else if (!isAccurate && !isFast) {
        // Slow AND inaccurate → offer visual variant (don't push quick tricks)
        return {
          variantId: 'visual',
          source: 'default_speed_rule',
          offerFromAttempt: 2,
          reason: 'slow_and_inaccurate',
        };
      }
    }
  }

  // Fallback: standard variant
  return {
    variantId: 'main',
    source: 'default',
    offerFromAttempt: attemptNumber,
  };
}

/**
 * Record that a variant was shown to a student.
 */
async function recordVariantShown(studentId, conceptId, level, variantId) {
  await db.query(
    `INSERT INTO student_explanation_effectiveness (student_id, concept_id, level, variant_used, times_shown, last_shown_at)
     VALUES ($1, $2, $3, $4, 1, NOW())
     ON CONFLICT (student_id, concept_id, variant_used)
     DO UPDATE SET times_shown = student_explanation_effectiveness.times_shown + 1, last_shown_at = NOW()`,
    [studentId, conceptId, level, variantId]
  );
}

/**
 * Record that a variant was helpful (student answered correctly after seeing it).
 */
async function recordVariantHelpful(studentId, conceptId, variantId) {
  await db.query(
    `UPDATE student_explanation_effectiveness
     SET times_helpful = times_helpful + 1
     WHERE student_id = $1 AND concept_id = $2 AND variant_used = $3`,
    [studentId, conceptId, variantId]
  );
}

/**
 * Get all variants available for a concept.
 */
async function getAvailableVariants(conceptId, level) {
  const variants = await db.query(
    `SELECT DISTINCT variant FROM exercises WHERE concept_id = $1 AND level_id = $2
     UNION
     SELECT DISTINCT variant FROM explanations WHERE concept_id = $1 AND level_id = $2`,
    [conceptId, level]
  );
  return variants.rows.map(r => r.variant);
}

module.exports = {
  selectExplanationVariant,
  recordVariantShown,
  recordVariantHelpful,
  getAvailableVariants,
};

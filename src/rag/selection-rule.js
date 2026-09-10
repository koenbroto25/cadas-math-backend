/**
 * Selection Rule — generic engine for choosing explanation variant.
 * Implements FASE 8.3b of final_plan_v1.1.md
 *
 * SKEMA AKTUAL (dikonfirmasi via information_schema, Sprint B):
 * - student_explanation_effectiveness: student_id, exercise_id, explanation_index,
 *   is_helpful, next_attempt_correct, feedback_text
 * - student_variant_bias: student_id, placement_id, variant_type (=concept code),
 *   correct_count, total_attempts, accuracy_percent
 *
 * Priority order:
 * 1. Real performance data (student_explanation_effectiveness, agregat per concept)
 * 2. Placement bias (student_variant_bias, join concepts via code)
 * 3. Default rule (2 failures → check speed → offer Quick or Visual)
 */

const db = require('../database/db');

// explanation_index → variant style (urutan sama dengan VARIANTS di AskKakScreen)
const INDEX_TO_VARIANT = ['gasing', 'pmri', 'quick'];
const VARIANT_TO_INDEX = { gasing: 0, pmri: 1, quick: 2 };

/**
 * Select the best explanation variant for a student at a given concept.
 * @param {string} studentId - UUID
 * @param {number} level - level number
 * @param {string} conceptId - UUID (optional)
 * @param {object} options - { attemptNumber, accuracy, avgTimeMs, targetTimeMs }
 * @returns {Promise<{variantId:string, source:string, offerFromAttempt:number}>}
 */
async function selectExplanationVariant(studentId, level, conceptId, options = {}) {
  // Step 1: Real performance data — agregat helpfulness per explanation_index
  // untuk exercises yang berasal dari concept ini.
  if (conceptId) {
    try {
      const perf = await db.query(
        `SELECT ee.explanation_index,
                COUNT(*)::int AS times_shown,
                COUNT(*) FILTER (WHERE ee.is_helpful)::int AS times_helpful
         FROM student_explanation_effectiveness ee
         JOIN exercises e ON e.id::text = ee.exercise_id
         WHERE ee.student_id = $1 AND e.concept_id = $2
         GROUP BY ee.explanation_index
         HAVING COUNT(*) FILTER (WHERE ee.is_helpful) > 0
         ORDER BY times_helpful DESC, times_shown DESC
         LIMIT 1`,
        [studentId, conceptId]
      );

      if (perf.rows.length > 0) {
        const idx = perf.rows[0].explanation_index;
        return {
          variantId: INDEX_TO_VARIANT[idx] || 'gasing',
          source: 'performance',
          offerFromAttempt: 2,
          effectiveness: perf.rows[0].times_helpful / perf.rows[0].times_shown,
        };
      }
    } catch (err) {
      console.error('[SELECTION] performance check error:', err.message);
    }
  }

  // Step 2: Placement bias — student_variant_bias.variant_type adalah concept code.
  // Match bila concept yang diminta sama dengan concept yang lemah di placement,
  // ATAU concept lain pada level yang sama. Accuracy < 80% = sinyal kuat
  // → tawarkan Quick Method sejak percobaan pertama (plan v1.1 §0.5).
  try {
    const bias = await db.query(
      `SELECT b.variant_type, b.accuracy_percent
       FROM student_variant_bias b
       JOIN concepts c ON c.code = b.variant_type
       WHERE b.student_id = $1 AND (c.id = $2 OR c.level_id = $3)
       ORDER BY b.accuracy_percent ASC
       LIMIT 1`,
      [studentId, conceptId, level]
    );

    if (bias.rows.length > 0 && bias.rows[0].accuracy_percent < 80) {
      return {
        variantId: 'quick',
        source: 'placement',
        offerFromAttempt: 1,
        biasedConcept: bias.rows[0].variant_type,
        accuracyPercent: bias.rows[0].accuracy_percent,
      };
    }
  } catch (err) {
    console.error('[SELECTION] bias check error:', err.message);
  }

  // Step 3: Default rule
  const attemptNumber = options.attemptNumber || 1;

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
 * Resolve satu exercise representatif dari concept (exercise_id NOT NULL
 * di skema aktual student_explanation_effectiveness).
 */
async function resolveExerciseForConcept(conceptId) {
  if (!conceptId) return null;
  const ex = await db.query(
    'SELECT id FROM exercises WHERE concept_id = $1 ORDER BY source_id LIMIT 1',
    [conceptId]
  );
  return ex.rows.length > 0 ? ex.rows[0].id : null;
}

/**
 * Record that a variant was shown to a student.
 * Skema aktual: (student_id, exercise_id, explanation_index) UNIQUE.
 * Shown ditandai dengan baris is_helpful=false; perulangan show di-dedup.
 */
async function recordVariantShown(studentId, conceptId, level, variantId) {
  const exerciseId = await resolveExerciseForConcept(conceptId);
  if (!exerciseId) {
    console.warn('[SELECTION] recordVariantShown: no exercise for concept', conceptId);
    return;
  }
  const explanationIndex = VARIANT_TO_INDEX[variantId] ?? 0;
  await db.query(
    `INSERT INTO student_explanation_effectiveness (student_id, exercise_id, explanation_index, is_helpful, created_at)
     VALUES ($1, $2, $3, false, NOW())
     ON CONFLICT (student_id, exercise_id, explanation_index) DO NOTHING`,
    [studentId, exerciseId, explanationIndex]
  );
}

/**
 * Record that a variant was helpful (student answered correctly after seeing it).
 */
async function recordVariantHelpful(studentId, conceptId, variantId) {
  const exerciseId = await resolveExerciseForConcept(conceptId);
  if (!exerciseId) {
    console.warn('[SELECTION] recordVariantHelpful: no exercise for concept', conceptId);
    return;
  }
  const explanationIndex = VARIANT_TO_INDEX[variantId] ?? 0;
  await db.query(
    `UPDATE student_explanation_effectiveness
     SET is_helpful = true, next_attempt_correct = true
     WHERE student_id = $1 AND exercise_id = $2 AND explanation_index = $3`,
    [studentId, exerciseId, explanationIndex]
  );
}

/**
 * Get all variants available for a concept.
 * Skema aktual: explanations.variants adalah JSON array berisi
 * { content, approach_name, explanation_style }.
 */
async function getAvailableVariants(conceptId, level) {
  const r = await db.query(
    `SELECT DISTINCT v->>'explanation_style' AS variant
     FROM explanations e, jsonb_array_elements(e.variants::jsonb) v
     WHERE e.concept_id = $1 AND e.level_id = $2 AND e.variants IS NOT NULL`,
    [conceptId, level]
  );
  return r.rows.map(x => x.variant).filter(Boolean);
}

module.exports = {
  selectExplanationVariant,
  recordVariantShown,
  recordVariantHelpful,
  getAvailableVariants,
};

/**
 * Migrate Placement Test Templates from material_generator_dev → cadas_app_dev
 * 
 * Copies 7 placement test sets (for candidate levels 3/5/6/8/10/11/13)
 * along with their referenced exercises so cadas-app placement endpoint works.
 */

const { Pool } = require('pg');

const sourcePool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: 'material_generator_dev'
});

const targetPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: 'cadas_app_dev'
});

async function migrate() {
  console.log('=== Placement Template Migration ===\n');
  try {
    // 1. Copy placement_tests (template sets with status='completed')
    const srcCount = await sourcePool.query(
      "SELECT count(*) FROM placement_tests WHERE status='completed' AND student_id='system-generated'"
    );
    console.log(`Source template placement_tests: ${srcCount.rows[0].count}`);

    const srcTests = await sourcePool.query(
      "SELECT id, student_id, start_level, current_level, probes, results, placed_level, prerequisite_signals, student_variant_bias, status, started_at, completed_at FROM placement_tests WHERE status='completed' AND student_id='system-generated'"
    );

    let migratedTests = 0;
    for (const t of srcTests.rows) {
      await targetPool.query(`
        INSERT INTO placement_tests (id, student_id, start_level, current_level, probes, results, placed_level, prerequisite_signals, student_variant_bias, status, started_at, completed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (id) DO UPDATE SET
          probes = EXCLUDED.probes,
          results = EXCLUDED.results,
          placed_level = EXCLUDED.placed_level
      `, [
        t.id, t.student_id, t.start_level, t.current_level,
                (typeof t.probes === 'string'
          ? (t.probes.trim().startsWith('[') ? t.probes : JSON.stringify(t.probes.split(',').map(p => p.trim()).filter(Boolean)))
          : JSON.stringify(t.probes)),
        (typeof t.results === 'string' ? t.results : JSON.stringify(t.results)),
        t.placed_level,
        (typeof t.prerequisite_signals === 'string' ? t.prerequisite_signals : JSON.stringify(t.prerequisite_signals)),
        (typeof t.student_variant_bias === 'string' ? t.student_variant_bias : JSON.stringify(t.student_variant_bias)),
        t.status, t.started_at, t.completed_at
      ]);
      migratedTests++;
    }
    console.log(`Migrated ${migratedTests} placement_tests`);

    // 2. Copy referenced exercises
    const exerciseIds = await sourcePool.query(`
      SELECT DISTINCT (jsonb_each_text(probes))->>1 as ex_id
      FROM (
        SELECT jsonb_array_elements(probes::jsonb) as elem FROM placement_tests WHERE status='completed' AND student_id='system-generated'
      ) sub
      CROSS JOIN LATERAL jsonb_populate_subset(elem::jsonb) 
    `).catch(() => ({ rows: [] }));

    // Simpler approach: fetch probes and extract exercise IDs
    const probeData = await sourcePool.query(
      "SELECT probes FROM placement_tests WHERE status='completed' AND student_id='system-generated'"
    );
    const allExIds = new Set();
    for (const row of probeData.rows) {
      let probes = row.probes;
      if (typeof probes === 'string') probes = JSON.parse(probes);
      if (Array.isArray(probes)) {
        for (const p of probes) {
          // probes contain exercise_id directly, or nested
          const exId = p.exercise_id || p.id || p;
          if (typeof exId === 'string' && exId) allExIds.add(exId);
        }
      }
    }

    const exIdList = Array.from(allExIds);
    let migratedExercises = 0;
    if (exIdList.length > 0) {
      const placeholders = exIdList.map((_, i) => `$${i + 1}`).join(',');
            const exRes = await sourcePool.query(
        `SELECT id, level, num1, num2, operation, correct_answer,
                problem_text, hint, quick_trick, visualization_type
         FROM exercises WHERE id IN (${placeholders})`,
        exIdList
      );
            for (const ex of exRes.rows) {
        await targetPool.query(`
          DELETE FROM exercises WHERE source_id = $1
        `, [ex.id]);
        await targetPool.query(`
          INSERT INTO exercises (source_id, level_id, question_text, answer_value,
            hint_text, quick_trick, num1, num2, operation, correct_answer,
            visualization_type, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
        `, [
          ex.id, ex.level, ex.problem_text, ex.correct_answer,
          ex.hint, ex.quick_trick, ex.num1, ex.num2, ex.operation,
          ex.correct_answer, ex.visualization_type
        ]);
        migratedExercises++;
      }
      console.log(`Migrated ${migratedExercises} exercises`);
    }

    const tgtCount = await targetPool.query(
      "SELECT count(*) FROM placement_tests WHERE status='completed' AND student_id='system-generated'"
    );
    console.log(`\nTarget placement_tests after migration: ${tgtCount.rows[0].count}`);
    console.log('=== Done ===');

  } catch (err) {
    console.error('Migration error:', err.message);
  } finally {
    await sourcePool.end();
    await targetPool.end();
  }
}

migrate();

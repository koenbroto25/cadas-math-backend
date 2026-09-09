/**
 * ETL konten: material_generator_dev -> cadas_app_dev
 * "Copy dengan transformasi" — kedua DB di instance Postgres yang sama
 * (container material_generator_db), jadi murni copy lokal.
 *
 * Mapping:
 *   levels        <- DISTINCT level dari explanations (nama = concept_name)
 *   concepts      <- 1 konsep per level (dari explanations)
 *   explanations  <- main_explanation + steps + variants + speech (per level)
 *   exercises     <- 5.446 soal (source_id dipertahankan utk mapping audio)
 *   level_audio_segments <- manifest-v2.json + visemes JSON dari disk
 *
 * Idempotent: upsert per source_id / (level_id, segment).
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const SRC = new Pool({ user: 'postgres', password: 'postgres', database: 'material_generator_dev' });
const DST = new Pool({ user: 'postgres', password: 'postgres', database: 'cadas_app_dev' });

const GEMINI_DIR = path.join('D:', 'local-rag-voice-bot', 'speed-math-master', 'audio', 'speech', 'gemini');
const BATCH = 500;

async function migrateLevelsAndExplanations() {
  // explanations aman dihapus (hanya explanations_embedding yang mereferensi,
  // dan itu ON DELETE CASCADE). concepts di-UPSERT, bukan delete — karena
  // exercises menunjuk concepts via FK.
  await DST.query('DELETE FROM explanations');

  const src = await SRC.query('SELECT * FROM explanations ORDER BY level');

  for (const row of src.rows) {
    // level
    await DST.query(
      `INSERT INTO levels (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [row.level, row.concept_name || `Level ${row.level}`]
    );

    // concept (1 per level) — upsert via uq_concepts_level_code
    const c = await DST.query(
      `INSERT INTO concepts (level_id, code, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (level_id, code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [row.level, row.concept_id, row.concept_name || `Level ${row.level}`]
    );
    const conceptId = c.rows[0].id;

    // explanation
    await DST.query(
      `INSERT INTO explanations
         (concept_id, level_id, content, source_id, steps, variants,
          quick_method, speech_friendly_text, speech_variants)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO UPDATE SET
         content = EXCLUDED.content,
         steps = EXCLUDED.steps,
         variants = EXCLUDED.variants,
         quick_method = EXCLUDED.quick_method,
         speech_friendly_text = EXCLUDED.speech_friendly_text,
         speech_variants = EXCLUDED.speech_variants`,
      [
        conceptId,
        row.level,
        row.main_explanation,
        row.source_id || row.concept_id,
        row.step_by_step ? JSON.stringify(row.step_by_step) : null,
        row.explanation_variants ? JSON.stringify(row.explanation_variants) : null,
        row.quick_method,
        row.speech_friendly_text,
        row.speech_variants ? JSON.stringify(row.speech_variants) : null,
      ]
    );
  }
  console.log(`levels+concepts+explanations: ${src.rowCount} level ter-upsert`);
  return src.rows.length;
}


async function migrateExercises() {
  // map: level -> concept uuid
  const cmap = await DST.query('SELECT id, level_id FROM concepts');
  const byLevel = new Map(cmap.rows.map((r) => [r.level_id, r.id]));

  const src = await SRC.query('SELECT * FROM exercises ORDER BY level, id');
  let inserted = 0;

  for (let i = 0; i < src.rows.length; i += BATCH) {
    const batch = src.rows.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let p = 0;

    for (const r of batch) {
      const conceptId = byLevel.get(r.level);
      if (!conceptId) throw new Error(`Tidak ada concept untuk level ${r.level} (exercise ${r.id})`);
      values.push(
        `($${++p},$${++p},$${++p},$${++p},$${++p},$${++p},$${++p},$${++p},$${++p},` +
        `$${++p},$${++p},$${++p},$${++p},$${++p},$${++p},$${++p})`
      );
      params.push(
        conceptId, r.level, r.problem_text, r.correct_answer, r.hint,
        null /* variant: milik penjelasan, bukan soal */, false,
        r.id, r.concept_id, r.speech_text, r.quick_trick,
        r.operation, r.num1, r.num2, r.correct_answer, r.visualization_type
      );
    }

    await DST.query(
      `INSERT INTO exercises
         (concept_id, level_id, question_text, answer_value, hint_text, variant,
          is_fast_track, source_id, source_concept_id, speech_text, quick_trick,
          operation, num1, num2, correct_answer, visualization_type)
       VALUES ${values.join(',')}
       ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO NOTHING`,
      params
    );
    inserted += batch.length;
    process.stdout.write(`\rexercises: ${inserted}/${src.rowCount}`);
  }
  console.log('');
  return inserted;
}

async function migrateLevelAudio() {
  const manifest = JSON.parse(fs.readFileSync(path.join(GEMINI_DIR, 'manifest-v2.json'), 'utf8'));
  let n = 0;

  for (const seg of manifest.segments) {
    const m = /^L(\d+)_(.+)$/.exec(seg.id);
    if (!m) {
      console.warn(`! segmen tidak sesuai pola: ${seg.id}`);
      continue;
    }
    const level = parseInt(m[1], 10);
    const visemePath = path.join(GEMINI_DIR, 'visemes', `${seg.id}.json`);
    const visemeJson = fs.existsSync(visemePath)
      ? JSON.stringify(JSON.parse(fs.readFileSync(visemePath, 'utf8')))
      : null;

    await DST.query(
      `INSERT INTO level_audio_segments
         (level_id, segment, spoken_text, audio_url, viseme_url, viseme_json)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (level_id, segment) DO UPDATE SET
         spoken_text = EXCLUDED.spoken_text,
         audio_url = EXCLUDED.audio_url,
         viseme_url = EXCLUDED.viseme_url,
         viseme_json = EXCLUDED.viseme_json`,
      [
        level,
        m[2],
        seg.text,
        `/audio/speech/gemini/wav/${seg.id}.wav`,
        fs.existsSync(visemePath) ? `/audio/speech/gemini/visemes/${seg.id}.json` : null,
        visemeJson,
      ]
    );
    n++;
  }
  console.log(`level_audio_segments: ${n} segmen dari manifest`);
  return n;
}

async function main() {
  const t0 = Date.now();
  const lv = await migrateLevelsAndExplanations();
  const ex = await migrateExercises();
  const au = await migrateLevelAudio();

  // Catat rilis konten (tabel content_release_log, migration 005)
  await DST.query(
    `INSERT INTO content_release_log
       (exercises_count, explanations_count, audio_segments_count, notes)
     VALUES ($1, $2, $3, 'ETL copy-with-transform')`,
    [ex, lv, au]
  );

  console.log(`\nSelesai dalam ${((Date.now() - t0) / 1000).toFixed(1)}s — ` +
    `${lv} level, ${ex} exercises, ${au} segmen audio level. Release log tercatat.`);
}

main()
  .then(async () => { await SRC.end(); await DST.end(); })
  .catch(async (e) => { console.error('\nETL GAGAL:', e.message); await SRC.end(); await DST.end(); process.exit(1); });


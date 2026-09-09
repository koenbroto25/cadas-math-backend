/**
 * Backtest FASE 2.3 — validasi hasil ETL + voice yang ada.
 * Bandingkan cadas_app_dev vs material_generator_dev + file di disk.
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const SRC = new Pool({ user: 'postgres', password: 'postgres', database: 'material_generator_dev' });
const DST = new Pool({ user: 'postgres', password: 'postgres', database: 'cadas_app_dev' });

const SM = path.join('D:', 'local-rag-voice-bot', 'speed-math-master', 'audio', 'speech');
let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  ✅ ${label} ${detail || ''}`); }
  else { fail++; console.log(`  ❌ ${label} ${detail || ''}`); }
}

async function main() {
  console.log('=== BACKTEST FASE 2.3 — konten & voice ===\n');

  // 1. Jumlah soal per level: sumber vs target
  const s = await SRC.query('SELECT level, COUNT(*)::int AS n FROM exercises GROUP BY level ORDER BY level');
  const t = await DST.query('SELECT level_id, COUNT(*)::int AS n FROM exercises GROUP BY level_id ORDER BY level_id');
  const srcMap = new Map(s.rows.map((r) => [r.level, r.n]));
  const tgtMap = new Map(t.rows.map((r) => [r.level_id, r.n]));
  let allMatch = true;
  for (const [lv, n] of srcMap) {
    if (tgtMap.get(lv) !== n) { allMatch = false; console.log(`    level ${lv}: sumber=${n} target=${tgtMap.get(lv)}`); }
  }
  check('Jumlah soal per level identik (15 level)', allMatch, `(${[...srcMap.values()].reduce((a, b) => a + b, 0)} soal)`);

  // 2. Tidak ada soal hilang / duplikat
  const dup = await DST.query(
    'SELECT source_id, COUNT(*)::int AS c FROM exercises WHERE source_id IS NOT NULL GROUP BY source_id HAVING COUNT(*) > 1'
  );
  check('Tidak ada source_id duplikat', dup.rowCount === 0);

  // 3. Konten wajib terisi
  const gap = await DST.query(
    `SELECT COUNT(*)::int AS n FROM exercises
     WHERE question_text IS NULL OR question_text = ''
        OR answer_value IS NULL OR hint_text IS NULL OR speech_text IS NULL`
  );
  check('Semua soal punya question+answer+hint+speech_text', gap.rows[0].n === 0, `(kosong: ${gap.rows[0].n})`);

  // 4. Explanations & steps & variants
  const e = await DST.query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE steps IS NOT NULL)::int AS with_steps,
            COUNT(*) FILTER (WHERE variants IS NOT NULL)::int AS with_variants
     FROM explanations`
  );
  check('15 explanations termigrasi', e.rows[0].n === 15, `(steps: ${e.rows[0].with_steps}, variants: ${e.rows[0].with_variants})`);

  // 5. Segmen audio level: 100% ada di disk + viseme JSON valid
  const segs = await DST.query('SELECT level_id, segment, audio_url, viseme_url, viseme_json FROM level_audio_segments');
  let missingWav = 0, missingVis = 0, badVis = 0;
  for (const r of segs.rows) {
    const wav = path.join(SM, r.audio_url.replace('/audio/speech/', ''));
    if (!fs.existsSync(wav)) missingWav++;
    if (r.viseme_url) {
      const vp = path.join(SM, r.viseme_url.replace('/audio/speech/', ''));
      if (!fs.existsSync(vp)) missingVis++;
      else {
        try { JSON.parse(fs.readFileSync(vp, 'utf8')); } catch { badVis++; }
      }
    }
  }
  check('Semua WAV segmen level ada di disk', missingWav === 0, `(${segs.rowCount} segmen, hilang: ${missingWav})`);
  check('Semua viseme level ada & JSON valid', missingVis === 0 && badVis === 0, `(hilang: ${missingVis}, rusak: ${badVis})`);

  // 6. Viseme masuk DB (untuk avatar)
  const withVis = await DST.query('SELECT COUNT(*)::int AS n FROM level_audio_segments WHERE viseme_json IS NOT NULL');
  check('viseme_json tersimpan di DB', withVis.rows[0].n === segs.rowCount, `(${withVis.rows[0].n}/${segs.rowCount})`);

  // 7. Exercise audio (voice bertahap — cakupan apa adanya)
  const ea = await DST.query(
    `SELECT kind, COUNT(*)::int AS n FROM exercise_audio WHERE file_exists GROUP BY kind`
  );
  const hintN = ea.rows.find((r) => r.kind === 'hint')?.n || 0;
  const trickN = ea.rows.find((r) => r.kind === 'trick')?.n || 0;
  console.log(`  ℹ️  Cache per-soal (bertahap): hint=${hintN}, trick=${trickN} — akan bertambah saat precache lanjut`);

  // 8. Join audio → soal valid (tidak ada audio untuk source_id tak dikenal)
  const orphan = await DST.query(
    `SELECT COUNT(*)::int AS n FROM exercise_audio ea
     LEFT JOIN exercises e ON e.source_id = ea.exercise_source_id
     WHERE e.id IS NULL`
  );
  check('Tidak ada exercise_audio tanpa soal (orphan)', orphan.rows[0].n === 0, `(orphan: ${orphan.rows[0].n})`);

  // 9. Pembandingan PENUH: setiap soal di target vs sumber, field-per-field
  const srcAll = await SRC.query(
    'SELECT id, problem_text, hint, speech_text, correct_answer FROM exercises ORDER BY id'
  );
  const tgtAll = await DST.query(
    `SELECT source_id, question_text, hint_text, speech_text, answer_value
     FROM exercises WHERE source_id IS NOT NULL ORDER BY source_id`
  );
  const srcMapFull = new Map(srcAll.rows.map((r) => [r.id, r]));
  let mismatched = 0, missing = 0, extra = 0;

  for (const r of tgtAll.rows) {
    const s = srcMapFull.get(r.source_id);
    if (!s) { extra++; continue; }
    if (
      s.problem_text !== r.question_text ||
      s.hint !== r.hint_text ||
      s.speech_text !== r.speech_text ||
      Number(s.correct_answer) !== Number(r.answer_value)
    ) mismatched++;
  }
  for (const s of srcAll.rows) {
    if (!tgtAll.rows.some((t) => t.source_id === s.id)) missing++;
  }
  check(
    `Pembandingan penuh ${srcAll.rowCount} soal: konten identik dengan sumber`,
    mismatched === 0 && missing === 0 && extra === 0,
    `(beda: ${mismatched}, hilang: ${missing}, tak dikenal: ${extra})`
  );

  console.log(`\n=== HASIL: ${pass} lulus, ${fail} gagal ===`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main()
  .then(async () => { await SRC.end(); await DST.end(); })
  .catch((e) => { console.error('Backtest error:', e.message); process.exit(1); });

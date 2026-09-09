// Verifikasi integritas SUMBER (material_generator_dev) pasca-ETL (read-only).
// Membandingkan dengan angka audit pra-ETL (8 Sep 2026).
const { Pool } = require('pg');
const mg = new Pool({ user: 'postgres', password: 'postgres', database: 'material_generator_dev' });

const BASELINE = { exercises: 5446, explanations: 15 };

async function main() {
  let fail = 0;
  const chk = (label, ok, detail) => {
    console.log(`  ${ok ? '✅' : '❌'} ${label} ${detail || ''}`);
    if (!ok) fail++;
  };

  const ex = await mg.query('SELECT COUNT(*)::int AS n FROM exercises');
  chk('Jumlah exercises = baseline', ex.rows[0].n === BASELINE.exercises, `(${ex.rows[0].n}/${BASELINE.exercises})`);

  const exp = await mg.query('SELECT COUNT(*)::int AS n FROM explanations');
  chk('Jumlah explanations = baseline', exp.rows[0].n === BASELINE.explanations, `(${exp.rows[0].n}/${BASELINE.explanations})`);

  // Distribusi per level = baseline
  const dist = await mg.query('SELECT level, COUNT(*)::int AS n FROM exercises GROUP BY level ORDER BY level');
  const expected = { 1:300, 2:250, 3:300, 4:450, 5:450, 6:340, 7:340, 8:350, 9:550, 10:340, 11:340, 12:331, 13:330, 14:326, 15:449 };
  let distOk = true;
  for (const r of dist.rows) {
    if (expected[r.level] !== r.n) { distOk = false; console.log(`    level ${r.level}: ${r.n} (harusnya ${expected[r.level]})`); }
  }
  chk('Distribusi per level = baseline pra-ETL', distOk && dist.rowCount === 15);

  // Kolom konten tetap terisi penuh
  const filled = await mg.query(
    `SELECT COUNT(*) FILTER (WHERE problem_text IS NOT NULL AND problem_text <> '')::int AS pt,
            COUNT(*) FILTER (WHERE speech_text IS NOT NULL AND speech_text <> '')::int AS st,
            COUNT(*) FILTER (WHERE hint IS NOT NULL)::int AS hint,
            COUNT(*) FILTER (WHERE quick_trick IS NOT NULL)::int AS qt
     FROM exercises`
  );
  const f = filled.rows[0];
  chk('problem_text penuh', f.pt === BASELINE.exercises, `(${f.pt})`);
  chk('speech_text penuh', f.st === BASELINE.exercises, `(${f.st})`);
  chk('hint penuh', f.hint === BASELINE.exercises, `(${f.hint})`);
  chk('quick_trick penuh', f.qt === BASELINE.exercises, `(${f.qt})`);

  // Tabel lain tak tersentuh (row count saja, sanity)
  for (const t of ['placement_tests', 'student_sessions', 'generation_jobs', 'schema_versions']) {
    try {
      const r = await mg.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
      console.log(`  ℹ️  ${t}: ${r.rows[0].n} rows`);
    } catch { /* tabel opsional */ }
  }

  console.log(fail === 0 ? '\nSUMBER UTUH — tidak ada perubahan vs baseline pra-ETL.' : `\nADA SELISIH: ${fail} check gagal!`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main()
  .then(() => mg.end())
  .catch((e) => { console.error(e.message); mg.end(); process.exit(1); });

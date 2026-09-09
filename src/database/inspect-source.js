// Inspeksi struktur sumber material_generator_dev (read-only). Skrip dev.
const { Pool } = require('pg');
const mg = new Pool({ user: 'postgres', password: 'postgres', database: 'material_generator_dev' });

async function main() {
  for (const t of ['exercises', 'explanations']) {
    const cols = await mg.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position",
      [t]
    );
    console.log(`\n=== ${t} ===`);
    console.log(cols.rows.map((c) => `${c.column_name} (${c.data_type})`).join('\n'));
    const n = await mg.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
    console.log('rows:', n.rows[0].n);
    const sample = await mg.query(`SELECT * FROM ${t} LIMIT 1`);
    console.log('sample:', JSON.stringify(sample.rows[0], null, 1).slice(0, 1200));
  }

  // Distribusi level & variant
  const lv = await mg.query("SELECT level, COUNT(*)::int AS n FROM exercises GROUP BY level ORDER BY level");
  console.log('\nlevel distribution:', JSON.stringify(lv.rows));

  // ID format
  const ids = await mg.query("SELECT id FROM exercises LIMIT 8");
  console.log('sample ids:', ids.rows.map((r) => r.id).join(', '));

  const seg = await mg.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='explanations' AND (column_name LIKE '%seg%' OR column_name LIKE '%var%' OR column_name LIKE '%variant%')"
  );
  console.log('explanations segment-ish cols:', seg.rows.map((r) => r.column_name).join(', '));
}

main()
  .then(() => mg.end())
  .catch((e) => { console.error(e.message); mg.end(); process.exit(1); });

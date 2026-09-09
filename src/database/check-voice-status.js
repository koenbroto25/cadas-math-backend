// Cek status voice/content di material_generator_dev (read-only). Skrip dev — hapus setelah dipakai.
const { Pool } = require('pg');

const mg = new Pool({ user: 'postgres', password: 'postgres', database: 'material_generator_dev' });

async function main() {
  const tables = await mg.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1"
  );
  console.log('MG tables:', tables.rows.map((r) => r.table_name).join(', '));

  const ex = await mg.query("SELECT COUNT(*)::int AS total FROM exercises");
  console.log('exercises total:', ex.rows[0].total);

  // Kolom terkait audio/speech yang ada di exercises
  const cols = await mg.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='exercises' AND (column_name LIKE '%speech%' OR column_name LIKE '%audio%' OR column_name LIKE '%text%')"
  );
  console.log('exercises audio/text cols:', cols.rows.map((r) => r.column_name).join(', '));

  for (const c of cols.rows) {
    const q = `SELECT COUNT(*)::int AS filled FROM exercises WHERE ${c.column_name} IS NOT NULL AND ${c.column_name} <> ''`;
    const r = await mg.query(q);
    console.log(`  filled ${c.column_name}: ${r.rows[0].filled}/${ex.rows[0].total}`);
  }

  // Tabel speech/tts bila ada
  const speechTables = tables.rows.map((r) => r.table_name).filter((t) => /speech|tts|audio|voice/i.test(t));
  for (const t of speechTables) {
    const r = await mg.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
    console.log(`table ${t}: ${r.rows[0].n} rows`);
  }
}

main()
  .then(() => mg.end())
  .catch((e) => { console.error(e.message); mg.end(); process.exit(1); });

/* Temporary DB verification for placement v2 migration (delete after use) */
const db = require('../database/db');

async function main() {
  const cols = await db.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'placement_tests' ORDER BY ordinal_position"
  );
  console.log('COLUMNS:', cols.rows.map((x) => `${x.column_name}:${x.data_type}`).join(' | '));

  const idx = await db.query(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'placement_tests'"
  );
  console.log('INDEXES:', idx.rows.map((x) => x.indexname).join(' | '));
  process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });

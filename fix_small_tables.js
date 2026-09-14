const { Client } = require('pg');
const localConn = { host: 'localhost', port: 5432, user: 'postgres', password: 'postgres', database: 'cadas_app_dev' };
const neonConn = { connectionString: 'postgresql://neondb_owner:npg_eviqLZ9Vy3ED@ep-morning-morning-b3vib52t-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require', ssl: { rejectUnauthorized: false } };

async function syncTable(local, neon, table) {
  const localData = await local.query(`SELECT * FROM ${table}`);
  await neon.query(`TRUNCATE ${table} CASCADE`);
  if (localData.rows.length === 0) { console.log(`  ${table}: 0 rows`); return; }
  const columns = Object.keys(localData.rows[0]);
  const colList = columns.join(', ');
  let inserted = 0;
  const batchSize = 100;
  for (let i = 0; i < localData.rows.length; i += batchSize) {
    const batch = localData.rows.slice(i, i + batchSize);
    const valuesList = [];
    const allValues = [];
    let paramIdx = 1;
    for (const row of batch) {
      const placeholders = columns.map(() => `$${paramIdx++}`).join(', ');
      valuesList.push(`(${placeholders})`);
      for (const c of columns) allValues.push(row[c]);
    }
    await neon.query(`INSERT INTO ${table} (${colList}) VALUES ${valuesList.join(', ')}`, allValues);
    inserted += batch.length;
  }
  console.log(`  ${table}: ${inserted} rows synced`);
}

async function main() {
  const local = new Client(localConn);
  const neon = new Client(neonConn);
  await local.connect(); await neon.connect();
  console.log('Connected');

  // Fix student_variant_bias
  console.log('\nFixing student_variant_bias...');
  await syncTable(local, neon, 'student_variant_bias');

  // Fix llm_usage_log
  console.log('\nFixing llm_usage_log...');
  await syncTable(local, neon, 'llm_usage_log');

  // Fix student_questions
  console.log('\nFixing student_questions...');
  await syncTable(local, neon, 'student_questions');

  // Verify
  console.log('\nVerification:');
  for (const t of ['student_variant_bias', 'llm_usage_log', 'student_questions']) {
    const l = await local.query(`SELECT COUNT(*) as cnt FROM ${t}`);
    const n = await neon.query(`SELECT COUNT(*) as cnt FROM ${t}`);
    console.log(`  ${t}: local=${l.rows[0].cnt}, neon=${n.rows[0].cnt} ${l.rows[0].cnt == n.rows[0].cnt ? 'OK' : 'XX'}`);
  }

  await local.end(); await neon.end();
  console.log('Done!');
}
main().catch(e => { console.error(e); process.exit(1); });

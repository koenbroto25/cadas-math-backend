const { Client } = require('pg');
const localConn = { host: 'localhost', port: 5432, user: 'postgres', password: 'postgres', database: 'cadas_app_dev' };
const neonConn = { connectionString: 'postgresql://neondb_owner:npg_eviqLZ9Vy3ED@ep-morning-morning-b3vib52t-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require', ssl: { rejectUnauthorized: false } };

async function main() {
  const local = new Client(localConn);
  const neon = new Client(neonConn);
  await local.connect();
  await neon.connect();
  console.log('Connected');

  // Get all local data
  console.log('Reading explanations_embedding from local...');
  const res = await local.query('SELECT * FROM explanations_embedding ORDER BY id');
  console.log(`Local rows: ${res.rows.length}`);

  if (res.rows.length === 0) { console.log('No data!'); return; }

  const columns = Object.keys(res.rows[0]);
  console.log(`Columns: ${columns.join(', ')}`);

  // Truncate and reinsert
  console.log('Truncating Neon table...');
  await neon.query('TRUNCATE explanations_embedding CASCADE');

  console.log('Inserting into Neon...');
  const colList = columns.join(', ');
  let inserted = 0;
  const batchSize = 100;

  for (let i = 0; i < res.rows.length; i += batchSize) {
    const batch = res.rows.slice(i, i + batchSize);
    const valuesList = [];
    const allValues = [];
    let paramIdx = 1;

    for (const row of batch) {
      const placeholders = columns.map(() => `$${paramIdx++}`).join(', ');
      valuesList.push(`(${placeholders})`);
      for (const c of columns) allValues.push(row[c]);
    }

    await neon.query(
      `INSERT INTO explanations_embedding (${colList}) VALUES ${valuesList.join(', ')}`,
      allValues
    );
    inserted += batch.length;
    if (inserted % 1000 === 0) console.log(`  Progress: ${inserted}/${res.rows.length}`);
  }

  console.log(`Inserted: ${inserted}`);

  // Verify
  const v = await neon.query('SELECT COUNT(*) as cnt FROM explanations_embedding');
  console.log(`Neon count: ${v.rows[0].cnt}`);

  await local.end();
  await neon.end();
  console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });

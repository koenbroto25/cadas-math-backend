const { Client } = require('pg');
const localConn = { host: 'localhost', port: 5432, user: 'postgres', password: 'postgres', database: 'cadas_app_dev' };
const neonConn = { connectionString: 'postgresql://neondb_owner:npg_eviqLZ9Vy3ED@ep-morning-morning-b3vib52t-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require', ssl: { rejectUnauthorized: false } };

async function main() {
  const local = new Client(localConn);
  const neon = new Client(neonConn);
  await local.connect();
  console.log('Connected to local');
  await neon.connect();
  console.log('Connected to Neon');

  // Get count
  const cnt = await local.query('SELECT COUNT(*) as cnt FROM explanations_embedding');
  console.log(`Local count: ${cnt.rows[0].cnt}`);

  // Get sample row to check columns
  const sample = await local.query('SELECT * FROM explanations_embedding LIMIT 1');
  if (sample.rows.length === 0) { console.log('No data!'); return; }
  const columns = Object.keys(sample.rows[0]);
  console.log(`Columns: ${columns.length}`);

  // Check embedding type
  const embSample = sample.rows[0].embedding;
  console.log(`Embedding type: ${typeof embSample}, isArray: ${Array.isArray(embSample)}, length: ${embSample?.length}`);

  // Truncate Neon
  console.log('Truncating Neon...');
  await neon.query('TRUNCATE explanations_embedding CASCADE');
  console.log('Truncated');

  // Copy in small batches
  const batchSize = 50;
  let offset = 0;
  let totalInserted = 0;

  while (offset < cnt.rows[0].cnt) {
    const batch = await local.query(`SELECT * FROM explanations_embedding ORDER BY id LIMIT ${batchSize} OFFSET ${offset}`);
    if (batch.rows.length === 0) break;

    const colList = columns.map(c => `"${c}"`).join(', ');
    const valuesList = [];
    const allValues = [];
    let paramIdx = 1;

    for (const row of batch.rows) {
      const placeholders = columns.map(() => `$${paramIdx++}`).join(', ');
      valuesList.push(`(${placeholders})`);
      for (const c of columns) {
        let val = row[c];
        // Convert vector array to string format for pgvector
        if (c === 'embedding' && Array.isArray(val)) {
          val = `[${val.join(',')}]`;
        }
        allValues.push(val);
      }
    }

    try {
      await neon.query(
        `INSERT INTO explanations_embedding (${colList}) VALUES ${valuesList.join(', ')}`,
        allValues
      );
      totalInserted += batch.rows.length;
    } catch (e) {
      console.error(`Batch at offset ${offset} failed: ${e.message}`);
      // Try inserting one by one
      for (const row of batch.rows) {
        try {
          const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
          const values = columns.map(c => {
            let val = row[c];
            if (c === 'embedding' && Array.isArray(val)) {
              return `[${val.join(',')}]`;
            }
            return val;
          });
          await neon.query(`INSERT INTO explanations_embedding (${colList}) VALUES (${placeholders})`, values);
          totalInserted++;
        } catch (e2) {
          console.error(`  Row ${row.id} failed: ${e2.message}`);
        }
      }
    }

    offset += batchSize;
    if (offset % 500 === 0) console.log(`Progress: ${totalInserted}/${cnt.rows[0].cnt}`);
  }

  console.log(`Total inserted: ${totalInserted}`);

  // Verify
  const v = await neon.query('SELECT COUNT(*) as cnt FROM explanations_embedding');
  console.log(`Neon count: ${v.rows[0].cnt}`);

  await local.end();
  await neon.end();
  console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });

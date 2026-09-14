const { Client } = require('pg');
const localConn = { host: 'localhost', port: 5432, user: 'postgres', password: 'postgres', database: 'cadas_app_dev' };
const neonConn = { connectionString: 'postgresql://neondb_owner:npg_eviqLZ9Vy3ED@ep-morning-morning-b3vib52t-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require', ssl: { rejectUnauthorized: false } };

async function main() {
  const local = new Client(localConn);
  const neon = new Client(neonConn);
  await local.connect(); await neon.connect();
  console.log('Connected');

  // Fix explanations_embedding - copy missing rows
  console.log('\nFixing explanations_embedding...');
  const lr = await local.query('SELECT COUNT(*) as cnt FROM explanations_embedding');
  const nr = await neon.query('SELECT COUNT(*) as cnt FROM explanations_embedding');
  console.log(`  Local: ${lr.rows[0].cnt}, Neon: ${nr.rows[0].cnt}`);
  
  if (parseInt(nr.rows[0].cnt) < parseInt(lr.rows[0].cnt)) {
    // Get existing IDs in Neon to avoid duplicates
    const existing = await neon.query('SELECT id FROM explanations_embedding');
    const existingIds = new Set(existing.rows.map(r => r.id));
    console.log(`  Existing in Neon: ${existingIds.size}`);
    
    // Get all local rows
    const allLocal = await local.query('SELECT * FROM explanations_embedding');
    console.log(`  Local rows: ${allLocal.rows.length}`);
    
    // Filter missing
    const missing = allLocal.rows.filter(r => !existingIds.has(r.id));
    console.log(`  Missing: ${missing.length}`);
    
    if (missing.length > 0) {
      const columns = Object.keys(missing[0]);
      const colList = columns.join(', ');
      let inserted = 0;
      const batchSize = 50;
      
      for (let i = 0; i < missing.length; i += batchSize) {
        const batch = missing.slice(i, i + batchSize);
        const valuesList = [];
        const allValues = [];
        let paramIdx = 1;
        
        for (const row of batch) {
          const placeholders = columns.map(() => `$${paramIdx++}`).join(', ');
          valuesList.push(`(${placeholders})`);
          allValues.push(...columns.map(c => row[c]));
        }
        
        await neon.query(
          `INSERT INTO explanations_embedding (${colList}) VALUES ${valuesList.join(', ')} ON CONFLICT DO NOTHING`,
          allValues
        );
        inserted += batch.length;
        if (inserted % 500 === 0) console.log(`  Inserted ${inserted}/${missing.length}...`);
      }
      console.log(`  Done! Inserted ${inserted} rows`);
    }
  }

  // Fix student_variant_bias
  console.log('\nFixing student_variant_bias...');
  const svLocal = await local.query('SELECT * FROM student_variant_bias');
  if (svLocal.rows.length > 0) {
    await neon.query('TRUNCATE student_variant_bias CASCADE');
    const columns = Object.keys(svLocal.rows[0]);
    const colList = columns.join(', ');
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    for (const row of svLocal.rows) {
      await neon.query(`INSERT INTO student_variant_bias (${colList}) VALUES (${placeholders})`, columns.map(c => row[c]));
    }
    console.log(`  Inserted ${svLocal.rows.length} rows`);
  }

  // Fix llm_usage_log (Neon has more, delete extra)
  console.log('\nFixing llm_usage_log...');
  const llLocal = await local.query('SELECT id FROM llm_usage_log ORDER BY id');
  const llNeon = await neon.query('SELECT id FROM llm_usage_log ORDER BY id');
  const localIds = new Set(llLocal.rows.map(r => r.id));
  const extraIds = llNeon.rows.filter(r => !localIds.has(r.id)).map(r => r.id);
  if (extraIds.length > 0) {
    await neon.query(`DELETE FROM llm_usage_log WHERE id = ANY($1)`, [extraIds]);
    console.log(`  Deleted ${extraIds.length} extra rows`);
  }

  // Fix student_questions (Neon has more, delete extra)
  console.log('\nFixing student_questions...');
  const sqLocal = await local.query('SELECT id FROM student_questions ORDER BY id');
  const sqNeon = await neon.query('SELECT id FROM student_questions ORDER BY id');
  const sqLocalIds = new Set(sqLocal.rows.map(r => r.id));
  const sqExtraIds = sqNeon.rows.filter(r => !sqLocalIds.has(r.id)).map(r => r.id);
  if (sqExtraIds.length > 0) {
    await neon.query(`DELETE FROM student_questions WHERE id = ANY($1)`, [sqExtraIds]);
    console.log(`  Deleted ${sqExtraIds.length} extra rows`);
  }

  // Final check
  console.log('\nFinal check:');
  const tables = ['explanations_embedding', 'student_variant_bias', 'llm_usage_log', 'student_questions'];
  for (const t of tables) {
    const l = await local.query(`SELECT COUNT(*) as cnt FROM ${t}`);
    const n = await neon.query(`SELECT COUNT(*) as cnt FROM ${t}`);
    console.log(`  ${t}: Local=${l.rows[0].cnt}, Neon=${n.rows[0].cnt} ${l.rows[0].cnt == n.rows[0].cnt ? 'OK' : 'XX'}`);
  }

  await local.end(); await neon.end();
  console.log('\nDone!');
}
main().catch(console.error);

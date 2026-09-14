const { Client } = require('pg');

const localConn = {
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'postgres',
  database: 'cadas_app_dev'
};

const neonConn = {
  connectionString: 'postgresql://neondb_owner:npg_eviqLZ9Vy3ED@ep-morning-morning-b3vib52t-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
  ssl: { rejectUnauthorized: false }
};

// Priority tables for trial (smaller, important)
const priorityTables = [
  'levels', 'concepts', 'students', 'parents', 'teachers',
  'student_sessions', 'student_questions', 'student_level_quota',
  'student_variant_bias', 'student_explanation_effectiveness',
  'teacher_students', 'parent_children', 'referrers', 'referral_settings',
  '_migrations'
];

async function main() {
  const local = new Client(localConn);
  const neon = new Client(neonConn);
  
  await local.connect();
  await neon.connect();
  await neon.query('SET search_path TO public, pg_catalog');
  
  console.log('Connected to both databases');
  
  for (const table of priorityTables) {
    try {
      // Get data from local
      const res = await local.query(`SELECT * FROM ${table}`);
      if (res.rows.length === 0) {
        console.log(`  ${table}: 0 rows (skipped)`);
        continue;
      }
      
      // Clear existing data in Neon
      await neon.query(`TRUNCATE ${table} CASCADE`);
      
      // Insert into Neon using batch insert
      const columns = Object.keys(res.rows[0]);
      const colList = columns.join(', ');
      
      // Batch insert 100 rows at a time
      const batchSize = 100;
      let inserted = 0;
      
      for (let i = 0; i < res.rows.length; i += batchSize) {
        const batch = res.rows.slice(i, i + batchSize);
        const valuesList = [];
        const allValues = [];
        let paramIdx = 1;
        
        for (const row of batch) {
          const placeholders = columns.map(() => `$${paramIdx++}`).join(', ');
          valuesList.push(`(${placeholders})`);
          allValues.push(...columns.map(c => row[c]));
        }
        
        await neon.query(
          `INSERT INTO ${table} (${colList}) VALUES ${valuesList.join(', ')}`,
          allValues
        );
        inserted += batch.length;
      }
      
      console.log(`  ${table}: ${inserted} rows copied`);
    } catch (e) {
      console.error(`  ${table}: ERROR - ${e.message}`);
    }
  }
  
  await local.end();
  await neon.end();
  console.log('\nDone!');
}

main().catch(console.error);

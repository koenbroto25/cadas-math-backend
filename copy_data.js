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


const tables = [
  'levels', 'concepts', 'exercises', 'explanations', 'explanations_embedding',
  'exercise_audio', 'level_audio_segments', 'students', 'parents', 'teachers',
  'student_sessions', 'student_questions', 'student_level_quota', 'student_trial_usage',
  'student_variant_bias', 'student_explanation_effectiveness', 'teacher_students',
  'parent_children', 'referrers', 'referral_settings', 'referrer_earnings',
  'payment_records', 'midtrans_invoices', 'download_clicks', 'content_release_log',
  'placement_tests', 'placement_probe_results', 'upgrade_tests', 'technique_taught_and_passed',
  'school_marketing_links', 'llm_usage_log', 'admin_rag_miss', '_migrations'
];

async function main() {
  const local = new Client(localConn);
  const neon = new Client(neonConn);
  
  await local.connect();
  await neon.connect();
  await neon.query('SET search_path TO public, pg_catalog');
  
  console.log('Connected to both databases');
  
  // First ensure schema exists in Neon
  const schemaCheck = await neon.query("SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema='public'");
  if (parseInt(schemaCheck.rows[0].cnt) < 30) {
    console.log('Schema not found in Neon. Please restore schema first.');
    await local.end();
    await neon.end();
    return;
  }
  
  for (const table of tables) {
    try {
      // Get data from local
      const res = await local.query(`SELECT * FROM ${table}`);
      if (res.rows.length === 0) {
        console.log(`  ${table}: 0 rows (skipped)`);
        continue;
      }
      
      // Clear existing data in Neon
      await neon.query(`TRUNCATE ${table} CASCADE`);
      
      // Insert into Neon
      const columns = Object.keys(res.rows[0]);
      const colList = columns.join(', ');
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      
      let inserted = 0;
      for (const row of res.rows) {
        const values = columns.map(c => row[c]);
        await neon.query(
          `INSERT INTO ${table} (${colList}) VALUES (${placeholders})`,
          values
        );
        inserted++;
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

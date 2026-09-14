const { Client } = require('pg');

const localConn = { host: 'localhost', port: 5432, user: 'postgres', password: 'postgres', database: 'cadas_app_dev' };
const neonConn = { connectionString: 'postgresql://neondb_owner:npg_eviqLZ9Vy3ED@ep-morning-morning-b3vib52t-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require', ssl: { rejectUnauthorized: false } };

// Only small tables (under 100 rows)
const tables = ['student_sessions', 'student_questions', 'student_level_quota', 'student_variant_bias', 'student_explanation_effectiveness', 'teacher_students', 'parent_children', 'referrers', 'referral_settings', 'content_release_log', 'download_clicks', 'admin_rag_miss', 'llm_usage_log', 'placement_tests', 'placement_probe_results', 'upgrade_tests', 'technique_taught_and_passed', 'school_marketing_links', 'payment_records', 'midtrans_invoices'];

async function main() {
  const local = new Client(localConn);
  const neon = new Client(neonConn);
  await local.connect();
  await neon.connect();
  await neon.query('SET search_path TO public');
  console.log('Connected');

  for (const table of tables) {
    try {
      const res = await local.query(`SELECT * FROM ${table}`);
      if (res.rows.length === 0) { console.log(`  ${table}: 0 rows (skip)`); continue; }
      await neon.query(`TRUNCATE ${table} CASCADE`);
      const columns = Object.keys(res.rows[0]);
      const colList = columns.join(', ');
      let inserted = 0;
      for (let i = 0; i < res.rows.length; i += 50) {
        const batch = res.rows.slice(i, i + 50);
        const valuesList = [];
        const allValues = [];
        let paramIdx = 1;
        for (const row of batch) {
          const placeholders = columns.map(() => `$${paramIdx++}`).join(', ');
          valuesList.push(`(${placeholders})`);
          allValues.push(...columns.map(c => row[c]));
        }
        await neon.query(`INSERT INTO ${table} (${colList}) VALUES ${valuesList.join(', ')}`, allValues);
        inserted += batch.length;
      }
      console.log(`  ${table}: ${inserted} rows`);
    } catch (e) {
      console.error(`  ${table}: ${e.message}`);
    }
  }
  await local.end();
  await neon.end();
  console.log('Done');
}

main().catch(console.error);

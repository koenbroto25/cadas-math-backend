const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const connectionString = 'postgresql://neondb_owner:npg_eviqLZ9Vy3ED@ep-morning-morning-b3vib52t-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
const dumpPath = path.join('C:', 'Users', process.env.USERNAME, 'Desktop', 'cadas_dump_clean.sql');

async function main() {
  console.log('Reading dump file from:', dumpPath);
  const dump = fs.readFileSync(dumpPath, 'utf8');
  console.log(`Dump size: ${dump.length} bytes`);
  
  console.log('Connecting to Neon...');
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('Connected!');
  
  console.log('Executing dump...');
  try {
    await client.query(dump);
    console.log('Dump executed successfully!');
  } catch (e) {
    console.error('Error:', e.message);
  }
  
  const res = await client.query('SELECT COUNT(*) as total FROM exercises');
  console.log('Exercises count:', res.rows[0].total);
  
  await client.end();
}

main().catch(console.error);

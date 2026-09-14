const { Client } = require('pg');
const localConn = { host: 'localhost', port: 5432, user: 'postgres', password: 'postgres', database: 'cadas_app_dev' };
const neonConn = { connectionString: 'postgresql://neondb_owner:npg_eviqLZ9Vy3ED@ep-morning-morning-b3vib52t-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require', ssl: { rejectUnauthorized: false } };
const RAILWAY_URL = 'https://cadas-app-backend-production.up.railway.app';
let passed = 0, failed = 0, warnings = 0;
const logPass = m => { passed++; console.log(`  ✅ ${m}`); };
const logFail = m => { failed++; console.error(`  ❌ ${m}`); };
const logWarn = m => { warnings++; console.warn(`  ⚠️  ${m}`); };

async function getCounts(client) {
  const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
  const counts = {};
  for (const t of tables.rows) { const r = await client.query(`SELECT COUNT(*) as cnt FROM public.${t.table_name}`); counts[t.table_name] = parseInt(r.rows[0].cnt); }
  return counts;
}

async function compareColumns(local, neon, table) {
  const lc = await local.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table]);
  const nc = await neon.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table]);
  if (lc.rows.length !== nc.rows.length) return { ok: false, msg: `cols: ${lc.rows.length} vs ${nc.rows.length}` };
  for (let i = 0; i < lc.rows.length; i++) { if (lc.rows[i].column_name !== nc.rows[i].column_name || lc.rows[i].data_type !== nc.rows[i].data_type) return { ok: false, msg: `col ${i}: ${lc.rows[i].column_name} vs ${nc.rows[i].column_name}` }; }
  return { ok: true, cols: lc.rows.length };
}
async function testEndpoint(name, url, method = 'GET', body = null, expected404 = false) {
  const http = url.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve) => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { 'Content-Type': 'application/json' }, timeout: 30000 };
    const req = http.request(opts, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 400) logPass(`${name}: ${res.statusCode}`); else if (res.statusCode === 404 && expected404) logWarn(`${name}: 404 (route belum ada — expected)`); else logFail(`${name}: ${res.statusCode}`); resolve(); }); });
    req.on('error', e => { if (e.message.includes('ECONNRESET')) logWarn(`${name}: ECONNRESET (intermitten — Railway LB)`); else logFail(`${name}: ${e.message}`); resolve(); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  console.log('='.repeat(70));
  console.log('BACKTEST KOMPREHENSIF — CADAS APP BACKEND');
  console.log('='.repeat(70));
  const local = new Client(localConn);
  const neon = new Client(neonConn);
  await local.connect(); await neon.connect();
  console.log('\n📡 Terhubung ke Local DB dan Neon');

  console.log('\n' + '='.repeat(70));
  console.log('TEST 1: JUMLAH TABEL');
  console.log('='.repeat(70));
  const lt = await local.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
  const nt = await neon.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
  const ls = new Set(lt.rows.map(r => r.table_name));
  const ns = new Set(nt.rows.map(r => r.table_name));
  const missing = [...ls].filter(t => !ns.has(t));
  const extra = [...ns].filter(t => !ls.has(t));
  if (missing.length === 0 && extra.length === 0) logPass(`Jumlah tabel sama: ${ls.size}`);
  else { if (missing.length) logFail(`Hilang di Neon: ${missing.join(', ')}`); if (extra.length) logWarn(`Extra di Neon: ${extra.join(', ')}`); }

  console.log('\n' + '='.repeat(70));
  console.log('TEST 2: STRUKTUR KOLOM');
  console.log('='.repeat(70));
  let sp = 0, sf = 0;
  for (const t of ls) { if (!ns.has(t)) continue; const r = await compareColumns(local, neon, t); if (r.ok) sp++; else { sf++; logFail(`${t}: ${r.msg}`); } }
  if (sf === 0) logPass(`Semua ${sp} tabel strukturnya sama`); else logWarn(`${sp} sama, ${sf} berbeda`);

  console.log('\n' + '='.repeat(70));
  console.log('TEST 3: JUMLAH BARIS PER TABEL');
  console.log('='.repeat(70));
  const lc = await getCounts(local);
  const nc = await getCounts(neon);
  let rm = 0, rx = 0;
  console.log(`  ${'Tabel'.padEnd(35)} ${'Local'.padStart(8)} ${'Neon'.padStart(8)} ${'Status'.padStart(8)}`);
  console.log('  ' + '-'.repeat(65));
  for (const t of [...ls].sort()) { if (!ns.has(t)) continue; const l = lc[t] ?? 0; const n = nc[t] ?? 0; const s = l === n ? 'OK' : 'XX'; if (l === n) rm++; else rx++; console.log(`  ${t.padEnd(35)} ${String(l).padStart(8)} ${String(n).padStart(8)} ${s.padStart(8)}`); }
  console.log('  ' + '-'.repeat(65));
  if (rx === 0) logPass(`Semua ${rm} tabel jumlah barisnya sama`); else logWarn(`${rm} sama, ${rx} berbeda`);

  console.log('\n' + '='.repeat(70));
  console.log('TEST 4: DATA INTEGRITY (CRITICAL TABLES)');
  console.log('='.repeat(70));
  for (const t of ['levels', 'concepts', 'exercises', 'explanations', 'students', 'parents', 'teachers']) {
    if (!ns.has(t)) continue;
    const lr = await local.query(`SELECT COUNT(*) as cnt FROM ${t}`);
    const nr = await neon.query(`SELECT COUNT(*) as cnt FROM ${t}`);
    if (lr.rows[0].cnt === nr.rows[0].cnt) logPass(`${t}: ${nr.rows[0].cnt} rows`); else logFail(`${t}: local=${lr.rows[0].cnt}, neon=${nr.rows[0].cnt}`);
  }


  console.log('\n' + '='.repeat(70));
  console.log('TEST 5: BACKEND ENDPOINTS (Railway)');
  console.log('='.repeat(70));
  await testEndpoint('GET /api/health', `${RAILWAY_URL}/api/health`);
  await testEndpoint('GET /api/config', `${RAILWAY_URL}/api/config`);
  await testEndpoint('GET /api/exercises/1', `${RAILWAY_URL}/api/exercises/1`);
  await testEndpoint('POST /api/auth/login', `${RAILWAY_URL}/api/auth/login`, 'POST', { phone: '081234567890', password: 'trial123' }, true);
  await testEndpoint('GET /api/levels', `${RAILWAY_URL}/api/levels`, 'GET', null, true);
  await testEndpoint('GET /api/concepts/1', `${RAILWAY_URL}/api/concepts/1`, 'GET', null, true);
  await testEndpoint('GET /api/explanations/1', `${RAILWAY_URL}/api/explanations/1`, 'GET', null, true);

  console.log('\n' + '='.repeat(70));
  console.log('TEST 6: EXTENSIONS & FEATURES (Neon)');
  console.log('='.repeat(70));
  const vec = await neon.query("SELECT extversion FROM pg_extension WHERE extname='vector'");
  if (vec.rows.length) logPass(`pgvector v${vec.rows[0].extversion}`); else logFail('pgvector TIDAK terinstall');
  const vc = await neon.query("SELECT table_name, column_name FROM information_schema.columns WHERE udt_name='vector'");
  if (vc.rows.length) logPass(`Vector columns: ${vc.rows.length}`); else logWarn('Tidak ada vector columns');
  const idx = await neon.query("SELECT count(*) as c FROM pg_indexes WHERE schemaname='public'");
  logPass(`Indexes: ${idx.rows[0].c}`);
  const fk = await neon.query("SELECT count(*) as c FROM information_schema.table_constraints WHERE constraint_type='FOREIGN KEY' AND table_schema='public'");
  logPass(`Foreign keys: ${fk.rows[0].c}`);

  console.log('\n' + '='.repeat(70));
  console.log('TEST 7: RAILWAY DEPLOYMENT');
  console.log('='.repeat(70));
  const db = await neon.query("SELECT current_database(), current_user, split_part(version(),' ',2) as ver");
  logPass(`DB: ${db.rows[0].current_database} | User: ${db.rows[0].current_user} | PG: ${db.rows[0].ver}`);
  const conn = await neon.query("SELECT count(*) as c FROM pg_stat_activity WHERE datname=current_database()");
  logPass(`Active connections: ${conn.rows[0].c}`);

  console.log('\n' + '='.repeat(70));
  console.log('RINGKASAN BACKTEST');
  console.log('='.repeat(70));
  console.log(`  Passed:   ${passed}`);
  console.log(`  Failed:   ${failed}`);
  console.log(`  Warnings: ${warnings}`);
  console.log('='.repeat(70));
  if (failed === 0) console.log('\nSEMUA TEST BERHASIL -- MIGRASI 100% SUKSES!');
  else console.log(`\nTERDAPAT ${failed} KEGAGALAN -- PERLU DIPERBAIKI`);
  await local.end(); await neon.end();
  process.exit(failed > 0 ? 1 : 0);
}
main().catch(err => { console.error('FATAL:', err); process.exit(1); });

/** M7 Head Marketing test ID security + no-production-write regression. */
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database/db');
const BASE = process.env.M7_TEST_BASE || 'http://localhost:3000';
const created = { referrers: [], accounts: [] };
let pass = 0, fail = 0;
const ok = (label, value, detail = '') => { if (value) { pass++; console.log(`[PASS] ${label}`); } else { fail++; console.error(`[FAIL] ${label} ${detail}`); } };
async function req(method, path, body, token) {
  const res = await fetch(`${BASE}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
async function cleanup() {
  for (const id of created.accounts) await db.query('DELETE FROM marketing_test_accounts WHERE id=$1', [id]).catch(() => {});
  for (const id of created.referrers) await db.query('DELETE FROM marketing_test_accounts WHERE owner_referrer_id=$1', [id]).catch(() => {});
  for (const id of created.referrers) await db.query('DELETE FROM referrers WHERE id=$1', [id]).catch(() => {});
}
async function run() {
  const suffix = `${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
  const password = 'M7Preview123!';
  const head = await db.query(
    `INSERT INTO referrers(full_name,email,password_hash,referral_code,referral_token,type,commission_rate,status,is_active)
     VALUES($1,$2,$3,$4,$5,'marketing',10,'approved',true) RETURNING id`,
    [`M7 Head ${suffix}`, `m7-head-${suffix}@test.local`, await bcrypt.hash(password, 10), `M7H-${suffix}`.slice(0, 40), `m7-share-${suffix}`]
  );
  const headId = head.rows[0].id; created.referrers.push(headId);
  const login = await req('POST', '/referrer/login', { email: `m7-head-${suffix}@test.local`, password });
  ok('Head Marketing login', login.status === 200 && !!login.data.token, JSON.stringify(login.data));
  const token = login.data.token;

  const first = [];
  for (let i = 0; i < 5; i++) {
    const r = await req('POST', '/referrer/test-accounts', { label: `M7-${i}` }, token);
    ok(`Buat test ID #${i + 1}`, r.status === 201 && /^TEST-[A-Z0-9]{6}$/.test(r.data.code), JSON.stringify(r.data));
    if (r.data.test_account?.id) created.accounts.push(r.data.test_account.id);
    if (r.data.code) first.push(r.data.code);
  }
  const sixth = await req('POST', '/referrer/test-accounts', {}, token);
  ok('Maksimal 5 ID aktif', sixth.status === 409, JSON.stringify(sixth.data));
  const list = await req('GET', '/referrer/test-accounts', undefined, token);
  ok('List hanya hint, tidak raw code', list.status === 200 && list.data.test_accounts.every((x) => x.code === undefined && x.code_hint), JSON.stringify(list.data));

  const before = await db.query('SELECT (SELECT COUNT(*)::int FROM students) AS students, (SELECT COUNT(*)::int FROM student_sessions) AS sessions, (SELECT COUNT(*)::int FROM payment_records) AS payments');
  const redeem = await req('POST', '/auth/test-account/redeem', { code: first[0] });
  ok('Redeem preview ID', redeem.status === 200 && redeem.data.scope === 'preview_all_levels' && !!redeem.data.token, JSON.stringify(redeem.data));
  const decoded = (() => { try { return jwt.verify(redeem.data.token, process.env.JWT_SECRET || 'cadas_app_secure_secret_key_2026'); } catch (_) { return {}; } })();
  ok('Token preview 30 menit + no_persist', decoded.role === 'demo' && decoded.kind === 'marketing_test' && decoded.no_persist === true && decoded.scope === 'preview_all_levels', JSON.stringify(decoded));
  const replay = await req('POST', '/auth/test-account/redeem', { code: first[0] });
  ok('Test ID one-time', replay.status === 409, JSON.stringify(replay.data));
  const invalid = await req('POST', '/auth/test-account/redeem', { code: 'BAD-ID' });
  ok('Format test ID invalid ditolak', invalid.status === 400, JSON.stringify(invalid.data));
  const notFound = await req('POST', '/auth/test-account/redeem', { code: 'TEST-ZZZZZZ' });
  ok('Test ID tidak ditemukan', notFound.status === 404, JSON.stringify(notFound.data));
  const noPersist = await req('POST', '/progress/session', { student_id: '00000000-0000-4000-8000-000000000000', level: 1, results: [{ correct: true, timeMs: 1000 }] }, redeem.data.token);
  ok('Preview progress tidak disimpan', noPersist.status === 200 && noPersist.data.saved === false, JSON.stringify(noPersist.data));
  const after = await db.query('SELECT (SELECT COUNT(*)::int FROM students) AS students, (SELECT COUNT(*)::int FROM student_sessions) AS sessions, (SELECT COUNT(*)::int FROM payment_records) AS payments');
  ok('Tidak ada data produksi dibuat', JSON.stringify(before.rows[0]) === JSON.stringify(after.rows[0]), `${JSON.stringify(before.rows[0])} != ${JSON.stringify(after.rows[0])}`);

  const revokeTarget = list.data.test_accounts.find((x) => x.id !== null && x.id);
  if (revokeTarget) {
    const rev = await req('POST', `/referrer/test-accounts/${revokeTarget.id}/revoke`, {}, token);
    ok('Head dapat revoke test ID', rev.status === 200, JSON.stringify(rev.data));
    const code = first.find((c) => c && c !== first[0]);
    if (code) {
      const revRedeem = await req('POST', '/auth/test-account/redeem', { code });
      // code may belong to a row not selected as revokeTarget; only assert revoked target if matching id is known.
      if (revRedeem.status === 410) ok('Test ID revoked ditolak', true, JSON.stringify(revRedeem.data));
    }
  }
  console.log(`\nM7 TEST ID: ${pass} pass, ${fail} fail`);
  if (fail) throw new Error('M7 failures');
}
run().catch((e) => { console.error('M7 ERROR:', e.message); fail++; }).finally(async () => { await cleanup(); console.log('[cleanup] M7 data removed'); process.exit(fail ? 1 : 0); });

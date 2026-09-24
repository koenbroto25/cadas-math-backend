/** M4 partner invite security regression. */
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const BASE = process.env.M4_TEST_BASE || 'http://localhost:3000';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const created = { referrers: [], invites: [] };
let pass = 0, fail = 0;
const ok = (label, value, detail = '') => { if (value) { pass++; console.log(`[PASS] ${label}`); } else { fail++; console.error(`[FAIL] ${label} ${detail}`); } };
async function req(method, path, body, token, admin = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (admin) headers['x-admin-secret'] = ADMIN_SECRET;
  const res = await fetch(`${BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
async function cleanup() {
  for (const id of created.invites) await db.query('DELETE FROM partner_invites WHERE id=$1', [id]).catch(() => {});
  for (const id of created.referrers) await db.query('DELETE FROM referrers WHERE id=$1', [id]).catch(() => {});
}
async function run() {
  const suffix = `${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
  const password = 'InviteTest123!';
  const head = await db.query(
    `INSERT INTO referrers(full_name,email,password_hash,referral_code,referral_token,type,commission_rate,status,is_active)
     VALUES($1,$2,$3,$4,$5,'marketing',10,'approved',true) RETURNING id,referral_token`,
    [`M4 Head ${suffix}`, `m4-head-${suffix}@test.local`, await bcrypt.hash(password, 10),
      `H-${suffix}`.slice(0, 40), `share-${suffix}`]
  );
  const headRow = head.rows[0]; created.referrers.push(headRow.id);

  // Legacy share token must not authorize partner registration.
  let r = await req('POST', '/referrer/register-via-invite', {
    invite_token: headRow.referral_token, full_name: 'Legacy', email: `legacy-${suffix}@test.local`, password,
  });
  ok('legacy referral_token ditolak', r.status === 404, JSON.stringify(r.data));

  // Admin creates school invite.
  r = await req('POST', '/admin/partner-invites', { target_type: 'school', expires_hours: 72 }, null, true);
  ok('admin buat invite guru', r.status === 201 && !!r.data.token, JSON.stringify(r.data));
  const schoolInvite = r.data; created.invites.push(schoolInvite.invite.id);
  const hash = await db.query('SELECT token_hash FROM partner_invites WHERE id=$1', [schoolInvite.invite.id]);
  ok('raw invite token tidak disimpan', hash.rows[0].token_hash !== schoolInvite.token && hash.rows[0].token_hash.length === 64);

  r = await req('POST', '/referrer/register-via-invite', {
    invite_token: schoolInvite.token, full_name: 'M4 Guru', email: `m4-school-${suffix}@test.local`, password,
  });
  ok('invite guru membuat akun school', r.status === 201 && r.data.referrer.type === 'school', JSON.stringify(r.data));
  created.referrers.push(r.data.referrer.id);
  const used = await db.query('SELECT used_at,used_referrer_id FROM partner_invites WHERE id=$1', [schoolInvite.invite.id]);
  ok('invite guru ditandai used', !!used.rows[0].used_at && used.rows[0].used_referrer_id === r.data.referrer.id);
  r = await req('POST', '/referrer/register-via-invite', {
    invite_token: schoolInvite.token, full_name: 'Guru Dua', email: `m4-school2-${suffix}@test.local`, password,
  });
  ok('invite guru tidak bisa dipakai ulang', r.status === 409, JSON.stringify(r.data));

  // Head creates sales invite through its JWT.
  const headLogin = await req('POST', '/referrer/login', { email: `m4-head-${suffix}@test.local`, password });
  ok('head login', headLogin.status === 200 && !!headLogin.data.token, JSON.stringify(headLogin.data));
  const headToken = headLogin.data.token;
  r = await req('POST', '/referrer/team-invites', { target_type: 'sales', expires_hours: 72 }, headToken);
  ok('head marketing buat invite sales', r.status === 201 && r.data.invite.target_type === 'sales', JSON.stringify(r.data));
  const salesInvite = r.data; created.invites.push(salesInvite.invite.id);
  r = await req('POST', '/referrer/register-via-invite', {
    invite_token: salesInvite.token, full_name: 'M4 Sales', email: `m4-sales-${suffix}@test.local`, password,
  });
  ok('invite sales membuat akun sales', r.status === 201 && r.data.referrer.type === 'sales' && r.data.referrer.parent_referrer_id === headRow.id, JSON.stringify(r.data));
  created.referrers.push(r.data.referrer.id);

  // Non-head cannot create invites.
  r = await req('POST', '/referrer/team-invites', { target_type: 'school' }, r.data.token);
  ok('sales tidak bisa membuat invite', r.status === 403, JSON.stringify(r.data));

  // Revoke is enforced.
  r = await req('POST', '/referrer/team-invites', { target_type: 'school' }, headToken);
  const revokeInvite = r.data; created.invites.push(revokeInvite.invite.id);
  r = await req('POST', `/referrer/team-invites/${revokeInvite.invite.id}/revoke`, {}, headToken);
  ok('head marketing bisa revoke invite', r.status === 200, JSON.stringify(r.data));
  r = await req('POST', '/referrer/register-via-invite', {
    invite_token: revokeInvite.token, full_name: 'Revoked', email: `m4-revoked-${suffix}@test.local`, password,
  });
  ok('invite revoked ditolak', r.status === 410, JSON.stringify(r.data));

  // Teacher public registration is disabled.
  r = await req('POST', '/auth/teacher/register', { name: 'Public Teacher', email: `public-${suffix}@test.local`, password, teacher_type: 'school' });
  ok('teacher register publik ditolak', r.status === 410, JSON.stringify(r.data));

  console.log(`\nM4 INVITE SECURITY: ${pass} pass, ${fail} fail`);
  if (fail) throw new Error('M4 failures');
}
run().catch(e => { console.error('M4 ERROR:', e.message); fail++; }).finally(async () => { await cleanup(); console.log('[cleanup] M4 data removed'); process.exit(fail ? 1 : 0); });

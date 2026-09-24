/** M5 marketing dashboard API regression. Data is removed in finally. */
process.env.NODE_ENV = 'test';
require('dotenv').config();
const jwt = require('jsonwebtoken');
const db = require('../database/db');
const dashboard = require('../services/marketingDashboardService');
const SECRET = process.env.JWT_SECRET || 'cadas_app_secure_secret_key_2026';
let pass = 0, fail = 0; const ids = { referrers: [], students: [], earnings: [] };
const check = (label, ok, detail = '') => { if (ok) { pass++; console.log(`[PASS] ${label}${detail ? ` — ${detail}` : ''}`); } else { fail++; console.error(`[FAIL] ${label}${detail ? ` — ${detail}` : ''}`); } };
async function partner(type, parent = null) {
  const n = `m5_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  const r = await db.query(`INSERT INTO referrers(full_name,email,password_hash,referral_code,referral_token,type,commission_rate,parent_referrer_id,status,is_active)
    VALUES($1,$2,'x',$3,$4,$5,10,$6,'approved',true) RETURNING id,type,full_name`, [`M5 ${type}`, `${n}@test.local`, n.toUpperCase(), `tok-${n}`, type, parent]);
  ids.referrers.push(r.rows[0].id); return r.rows[0];
}
async function paidStudents(p, count) {
  const seed = `m5s_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const r = await db.query(`INSERT INTO students(name,display_name,display_id,referred_by)
    SELECT $1||'_'||g,$1||'_'||g,substr(md5($1||'_'||g),1,5),$2 FROM generate_series(1,$3::int) g RETURNING id`, [seed,p.id,count]);
  ids.students.push(...r.rows.map(x => x.id));
  await db.query(`INSERT INTO payment_records(student_id,product_type,level_from,level_to,amount_idr,payment_method,is_confirmed,confirmed_by_admin_at)
    SELECT id,'basic_single',1,1,40000,'qris_midtrans',TRUE,NOW() FROM students WHERE id=ANY($1::uuid[])`, [r.rows.map(x => x.id)]);
  return r.rows;
}
async function cleanup() {
  if (ids.referrers.length) await db.query('DELETE FROM referrer_earnings WHERE referrer_id=ANY($1::uuid[])', [ids.referrers]).catch(() => {});
  if (ids.students.length) await db.query('DELETE FROM payment_records WHERE student_id=ANY($1::uuid[])', [ids.students]).catch(() => {});
  if (ids.students.length) await db.query('DELETE FROM students WHERE id=ANY($1::uuid[])', [ids.students]).catch(() => {});
  if (ids.referrers.length) await db.query('DELETE FROM referrer_windows WHERE referrer_id=ANY($1::uuid[])', [ids.referrers]).catch(() => {});
  if (ids.referrers.length) await db.query('DELETE FROM school_marketing_links WHERE school_id=ANY($1::uuid[]) OR marketing_id=ANY($1::uuid[])', [ids.referrers]).catch(() => {});
  if (ids.referrers.length) await db.query('DELETE FROM referrers WHERE id=ANY($1::uuid[])', [ids.referrers]).catch(() => {});
}
async function run() {
  const teacher = await partner('school'); await paidStudents(teacher, 1);
  const td = await dashboard.getPartnerDashboard(teacher.id);
  check('teacher tier 1 = 5%', td.tier.type === 'school' && td.tier.paid === 1 && td.tier.rate === 5, JSON.stringify(td.tier));
  const ref = await partner('sales'); await paidStudents(ref, 10);
  const rd = await dashboard.getPartnerDashboard(ref.id);
  check('referrer tier 10 = 5%', rd.tier.type === 'referrer' && rd.tier.paid === 10 && rd.tier.rate === 5, JSON.stringify(rd.tier));
  check('referrer window shown', !!rd.tier.window, JSON.stringify(rd.tier.window));
  const expired = await partner('sales');
  const old = await paidStudents(expired, 1);
  await db.query("UPDATE payment_records SET confirmed_by_admin_at=NOW()-INTERVAL '100 days' WHERE student_id=ANY($1::uuid[])", [old.map(x => x.id)]);
  const expiredData = await dashboard.getPartnerDashboard(expired.id);
  check('expired referrer window = 0', expiredData.tier.paid === 0 && expiredData.tier.rate === 0, JSON.stringify(expiredData.tier));
  const mixed = await partner('sales');
  const oldMixed = await paidStudents(mixed, 1);
  await db.query("UPDATE payment_records SET confirmed_by_admin_at=NOW()-INTERVAL '100 days' WHERE student_id=ANY($1::uuid[])", [oldMixed.map(x => x.id)]);
  await paidStudents(mixed, 9);
  const mixedData = await dashboard.getPartnerDashboard(mixed.id);
  check('derived window counts only active payment', mixedData.tier.paid === 9 && mixedData.tier.rate === 0, JSON.stringify(mixedData.tier));
  const head = await partner('marketing'); const child = await partner('sales', head.id); await paidStudents(child, 2);
  const hd = await dashboard.getPartnerDashboard(head.id);
  check('head core rate 10%', hd.tier.type === 'marketing' && hd.tier.rate === 10, JSON.stringify(hd.tier));
  check('head network visible', hd.network && hd.network.partners.length === 1 && hd.network.paid_students === 2, JSON.stringify(hd.network));
  const forbidden = await fetch(`${process.env.DASHBOARD_TEST_BASE || 'http://localhost:3000'}/api/referrer/network`, { headers: { Authorization: `Bearer ${jwt.sign({sub:teacher.id, role:'referrer'}, SECRET)}` } });
  check('non-marketing network forbidden', forbidden.status === 403, String(forbidden.status));
  console.log(`\nM5 DASHBOARD BACKTEST: ${pass} pass, ${fail} fail`); if (fail) throw new Error('dashboard failures');
}
run().catch(e => { console.error('M5 DASHBOARD ERROR:', e.message); fail++; }).finally(async () => { await cleanup(); console.log('[cleanup] dashboard data removed'); process.exit(fail ? 1 : 0); });

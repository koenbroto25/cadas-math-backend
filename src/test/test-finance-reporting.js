/** M8 finance live integration. */
process.env.NODE_ENV = 'test';
require('dotenv').config();
const crypto = require('crypto');
const db = require('../database/db');
const { signToken } = require('../middleware/auth');
const BASE = process.env.FINANCE_TEST_BASE || 'http://localhost:3000';
const token = signToken({ sub: 'admin', role: 'admin' }, '15m');
const stamp = Date.now();
let pass = 0, fail = 0;
const ids = { students: [], referrers: [], invoices: [], records: [], earnings: [], batches: [], reconciliations: [], windows: [], schedulerRuns: [] };
function check(name, ok, detail = '') { if (ok) { pass++; console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`); } else { fail++; console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); } }
async function req(method, path, body, auth = token) {
  const res = await fetch(`${BASE}/api/admin/finance${path}`, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; } return { status: res.status, data, headers: res.headers };
}
const day = new Date().toISOString().slice(0, 10);
async function seed() {
  const suffix = `${stamp}${crypto.randomBytes(2).toString('hex')}`;
  const code = `FIN${suffix}`.slice(0, 32);
  const ref = await db.query(`INSERT INTO referrers(full_name,email,password_hash,referral_code,referral_token,type,commission_rate,status,is_active,bank_name,bank_account_number,bank_account_name) VALUES($1,$2,'x',$3,$4,'school',5,'approved',true,'Bank Test','1234567890','Finance Test') RETURNING id`, [`Finance Partner ${suffix}`, `finance-${suffix}@test.local`, code, `fintok${suffix}`]);
  const refId = ref.rows[0].id; ids.referrers.push(refId);
  const win = await db.query(`INSERT INTO referrer_windows(referrer_id,started_at,expires_at,status) VALUES($1,NOW()-INTERVAL '100 days',NOW()-INTERVAL '10 days','open') RETURNING id`,[refId]);
  ids.windows.push(win.rows[0].id);
  for (let i = 1; i <= 2; i++) {
    const s = await db.query(`INSERT INTO students(display_id,display_name,grade_level,name,kelas,referred_by) VALUES($1,$2,4,$2,4,$3) RETURNING id`, [`F${String(stamp).slice(-3)}${i}`, `Finance Student ${i} ${suffix}`, refId]);
    const sid = s.rows[0].id; ids.students.push(sid);
    const inv = await db.query(`INSERT INTO midtrans_invoices(student_id,midtrans_order_id,midtrans_payment_url,product_type,level_from,level_to,amount_idr,referrer_code,status,payment_type,paid_at) VALUES($1,$2,'','basic_single',$3,$3,40000,$4,'paid','qris',NOW()) RETURNING id`, [sid, `fin-${suffix}-${i}`, i, code]);
    ids.invoices.push(inv.rows[0].id);
    const pr = await db.query(`INSERT INTO payment_records(student_id,product_type,level_from,level_to,amount_idr,payment_method,referrer_code,commission_amount_idr,is_confirmed,confirmed_by_admin_at) VALUES($1,'basic_single',$2,$2,40000,'qris_midtrans',$3,2000,true,NOW()) RETURNING id`, [sid, i, code]);
    ids.records.push(pr.rows[0].id);
    const e = await db.query(`INSERT INTO referrer_earnings(referrer_id,payment_record_id,midtrans_invoice_id,student_id,amount_idr,commission_rate,commission_idr,status,earning_type,referrer_type,idempotency_key,eligible_at) VALUES($1,$2,$3,$4,40000,5,2000,'ready','transaction','school',$5,NOW()) RETURNING id`, [refId, pr.rows[0].id, inv.rows[0].id, sid, `fin-test-${suffix}-${i}`]);
    ids.earnings.push(e.rows[0].id);
  }
  return refId;
}
async function cleanup() {
  if (ids.batches.length) { const p = ids.batches.map((_, i) => `$${i + 1}`).join(','); await db.query(`DELETE FROM finance_cash_ledger WHERE source_type='payout_batch' AND source_id IN (${p})`, ids.batches).catch(() => {}); await db.query(`DELETE FROM payout_batch_items WHERE payout_batch_id IN (${p})`, ids.batches).catch(() => {}); await db.query(`DELETE FROM payout_batches WHERE id IN (${p})`, ids.batches).catch(() => {}); }
  if (ids.reconciliations.length) { const p = ids.reconciliations.map((_, i) => `$${i + 1}`).join(','); await db.query(`DELETE FROM finance_reconciliations WHERE id IN (${p})`, ids.reconciliations).catch(() => {}); }
  if (ids.schedulerRuns.length) { const p = ids.schedulerRuns.map((_, i) => `$${i + 1}`).join(','); await db.query(`DELETE FROM finance_scheduler_runs WHERE id IN (${p})`, ids.schedulerRuns).catch(() => {}); }
  if (ids.windows.length) { const p = ids.windows.map((_, i) => `$${i + 1}`).join(','); await db.query(`DELETE FROM referrer_windows WHERE id IN (${p})`, ids.windows).catch(() => {}); }
  if (ids.earnings.length) { const p = ids.earnings.map((_, i) => `$${i + 1}`).join(','); await db.query(`DELETE FROM referrer_earnings WHERE id IN (${p})`, ids.earnings).catch(() => {}); }
  if (ids.invoices.length) { const p = ids.invoices.map((_, i) => `$${i + 1}`).join(','); await db.query(`DELETE FROM finance_cash_ledger WHERE source_type='midtrans_invoice' AND source_id IN (${p}) AND external_id LIKE 'fin-%'`, ids.invoices).catch(() => {}); await db.query(`DELETE FROM midtrans_invoices WHERE id IN (${p})`, ids.invoices).catch(() => {}); }
  if (ids.records.length) { const p = ids.records.map((_, i) => `$${i + 1}`).join(','); await db.query(`DELETE FROM payment_records WHERE id IN (${p})`, ids.records).catch(() => {}); }
  if (ids.students.length) { const p = ids.students.map((_, i) => `$${i + 1}`).join(','); await db.query(`DELETE FROM students WHERE id IN (${p})`, ids.students).catch(() => {}); }
  if (ids.referrers.length) { const p = ids.referrers.map((_, i) => `$${i + 1}`).join(','); await db.query(`DELETE FROM referrers WHERE id IN (${p})`, ids.referrers).catch(() => {}); }
  await db.query(`DELETE FROM finance_audit_logs
    WHERE notes LIKE 'M8-FINANCE-TEST%'
       OR (action='referrer_window_expired' AND entity_id=ANY($1::uuid[]))`,
    [ids.windows]
  ).catch(() => {});
}
async function run() {
  const refId = await seed();
  const windowDay = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
  const filteredWindows = await req('GET', `/windows?partner_id=${refId}&from=${windowDay}&to=${day}`);
  check('windows date+partner filter', filteredWindows.status === 200 && filteredWindows.data.windows.some((w) => w.id === ids.windows[0]), `${filteredWindows.status}/${filteredWindows.data.windows?.length}`);
  const invalidScope = await req('POST', '/scheduler/run', { window_ids: ['not-a-uuid'] });
  check('scheduler rejects invalid scope', invalidScope.status === 400, JSON.stringify(invalidScope.data));
  const maintenance = await req('POST', '/scheduler/run', { window_ids: ids.windows });
  check('scheduler scoped expiry', maintenance.status === 201 && maintenance.data.status === 'success' && maintenance.data.affected_count === 1, JSON.stringify(maintenance.data));
  ids.schedulerRuns.push(maintenance.data.id);
  const expiredWindow = await req('GET', `/windows?partner_id=${refId}`);
  check('window status expired', expiredWindow.status === 200 && expiredWindow.data.windows.find((w) => w.id === ids.windows[0])?.status === 'expired', JSON.stringify(expiredWindow.data.windows?.find((w) => w.id === ids.windows[0])));
  const maintenanceAgain = await req('POST', '/scheduler/run', { window_ids: ids.windows });
  check('scheduler idempotent', maintenanceAgain.status === 201 && maintenanceAgain.data.affected_count === 0, JSON.stringify(maintenanceAgain.data));
  ids.schedulerRuns.push(maintenanceAgain.data.id);
  const expiryAudit = await req('GET', '/audit');
  check('window expiry audit', expiryAudit.status === 200 && expiryAudit.data.audit.some((a) => a.action === 'referrer_window_expired' && a.entity_id === ids.windows[0]), String(expiryAudit.data.audit?.length));
  const runs = await req('GET', '/scheduler-runs?limit=10');
  check('scheduler runs report', runs.status === 200 && runs.data.runs.some((r) => r.id === maintenance.data.id), `${runs.status}/${runs.data.runs?.length}`);
  const unauthorized = await req('GET', '/summary', undefined, null);
  check('finance admin-only', unauthorized.status === 401, String(unauthorized.status));
  const backfill = await req('POST', '/cash-ledger/backfill', {});
  check('settlement backfill', backfill.status === 200, JSON.stringify(backfill.data));
  const summary = await req('GET', `/summary?partner_id=${refId}&from=${day}&to=${day}`);
  check('summary filter', summary.status === 200 && summary.data.fees.earned_idr >= 4000 && summary.data.fees.payable_liability_idr >= 4000, JSON.stringify(summary.data));
  check('cash holds fee liability', summary.data.cash.available_balance_idr < summary.data.cash.signed_delta_idr, JSON.stringify(summary.data.cash));
  const payments = await req('GET', `/payments?from=${day}&to=${day}&package=basic_single`);
  const earnings = await req('GET', `/earnings?from=${day}&to=${day}&partner_id=${refId}&earning_status=ready&earning_type=transaction`);
  check('payments/earnings filters', payments.status === 200 && earnings.status === 200 && earnings.data.earnings.length >= 2, `${payments.data.payments?.length}/${earnings.data.earnings?.length}`);
  const [first, second] = ids.earnings;
  const batch = await req('POST', '/payout-batches', { earning_ids: [first], notes: 'M8-FINANCE-TEST payout' });
  check('create payout batch', batch.status === 201 && batch.data.status === 'scheduled', JSON.stringify(batch.data)); ids.batches.push(batch.data.id);
  const transferred = await req('POST', `/payout-batches/${batch.data.id}/transferred`, { bank_reference: 'BANK-M8-TEST', notes: 'M8-FINANCE-TEST transfer' });
  check('mark batch transferred', transferred.status === 200 && transferred.data.status === 'transferred', JSON.stringify(transferred.data));
  const cancel = await req('POST', `/earnings/${second}/cancel`, { reason: 'M8-FINANCE-TEST cancellation' });
  check('cancel unscheduled fee', cancel.status === 200 && cancel.data.status === 'cancelled', JSON.stringify(cancel.data));
  const cancellations = await req('GET', `/cancellations?partner_id=${refId}`);
  check('cancellations report', cancellations.status === 200 && cancellations.data.cancellations.some(x => x.id === second), JSON.stringify(cancellations.data));
  const payouts = await req('GET', '/payouts');
  check('payouts report', payouts.status === 200 && payouts.data.batches.some(x => x.id === batch.data.id), JSON.stringify(payouts.data.payouts));
  const recon = await req('POST', '/reconciliation', { account_name: `M8 Finance ${stamp}`, account_date: day, actual_balance_idr: 0, notes: 'M8-FINANCE-TEST recon' });
  if (recon.status === 201) ids.reconciliations.push(recon.data.id);
  check('bank reconciliation', recon.status === 201, JSON.stringify(recon.data));
  const reconciliation = await req('GET', `/reconciliation?from=${day}&to=${day}`);
  check('reconciliation report', reconciliation.status === 200, JSON.stringify(reconciliation.data));
  const csv = await req('GET', `/export/payments?from=${day}&to=${day}`);
  const json = await req('GET', `/export/earnings?format=json&partner_id=${refId}`);
  const windowsCsv = await req('GET', `/export/windows?partner_id=${refId}`);
  const schedulerJson = await req('GET', `/export/scheduler-runs?format=json&limit=10`);
  check('CSV/JSON exports', csv.status === 200 && typeof csv.data === 'string' && json.status === 200 && Array.isArray(json.data.rows), `${csv.status}/${json.status}`);
  check('Windows/scheduler exports', windowsCsv.status === 200 && typeof windowsCsv.data === 'string' && schedulerJson.status === 200 && Array.isArray(schedulerJson.data.rows), `${windowsCsv.status}/${schedulerJson.status}`);
  const audit = await req('GET', `/audit?from=${day}&to=${day}`);
  check('audit trail', audit.status === 200 && audit.data.audit.length >= 3, String(audit.data.audit?.length));
  const final = await req('GET', `/summary?partner_id=${refId}&from=${day}&to=${day}`);
  check('liability after payout/cancel', final.status === 200 && final.data.fees.earned_idr === 2000 && final.data.fees.normal_idr === 2000 && final.data.fees.transferred_idr === 2000 && final.data.fees.cancelled_idr === 2000 && final.data.fees.balance_ok, JSON.stringify(final.data.fees));
  console.log(`\nM8 FINANCE LIVE: ${pass} pass, ${fail} fail`);
  if (fail) throw new Error('finance failures');
}
run().catch(e => { console.error('M8 FINANCE ERROR:', e.message); fail++; }).finally(async () => { await cleanup(); console.log('[cleanup] finance test data removed'); process.exit(fail ? 1 : 0); });

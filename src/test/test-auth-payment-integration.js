/**
 * Integration test: Auth & Payment (Placement_Test_System.md §13.5 — Pintu 1).
 *
 * Flow yang diuji:
 *   [1] Ortu register                      POST /api/auth/parent/register
 *   [2] Ortu beli paket level_3 (SEBELUM placement) → pending
 *   [3] Ortu buat kode undangan (student_id NULL)
 *   [4] Anak register                      POST /api/auth/student/register
 *   [5] Redeem kode → link + transfer kredit pending ke anak (pending_levels=3)
 *   [6] Status akses: anchor=null, scope=null, pending=3 (belum aktif)
 *   [7] Placement selesai (semua salah → placed 1) → aktivasi OTOMATIS
 *   [8] Scope aktif [1..3], pending=0, paid_basic_up_to_level=3
 *   [9] Top-up level_1 SETELAH placement → aktif langsung [4..4], tanpa overlap
 *   [10] Edge cases: 400/404/409
 *   [cleanup] semua baris test dihapus
 *
 * Requires the backend server running on PORT (default 3000).
 */
const crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const BASE = process.env.AUTH_PAYMENT_BASE || `http://localhost:${PORT}/api`;

const db = require('../database/db');

let studentId = null;
let parentId = null;
let placementId = null;
const uniq = Date.now();

async function post(path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  // [1] Ortu register (phone unik per run — parents.phone UNIQUE)
  const email = `ortu${uniq}@test.local`;
  const phone = `0811${String(uniq).slice(-9)}`;
  const parentReg = await post('/auth/parent/register', {
    name: 'ORTU TEST PAYMENT',
    email,
    password: 'secret123',
    phone,
  });
  expect(parentReg.status === 200 || parentReg.status === 201, `parent register gagal: ${parentReg.status} ${JSON.stringify(parentReg.data)}`);
  const pRow = await db.query('SELECT id FROM parents WHERE email = $1', [email]);
  parentId = pRow.rows[0].id;
  const parentToken = parentReg.data.token;
  expect(parentToken, 'parent token tidak ditemukan di respons register');
  console.log('[1] parent registered:', parentId);

  // [2] Parent-first QRIS paket 3 level (settlement disimulasikan via signed webhook).
  const buy1 = await post('/payments/qris', { package: 'basic_bundle_3' }, parentToken);
  expect(buy1.status === 201 && buy1.data.order_id, `QRIS parent-first gagal: ${buy1.status} ${JSON.stringify(buy1.data)}`);
  const sign = (orderId, statusCode, gross) => crypto.createHash('sha512')
    .update(`${orderId}${statusCode}${gross}${process.env.MIDTRANS_SERVER_KEY || ''}`).digest('hex');
  const settle1 = await post('/midtrans/webhook', {
    order_id: buy1.data.order_id, status_code: '200', gross_amount: '100000.00',
    signature_key: sign(buy1.data.order_id, '200', '100000.00'),
    transaction_status: 'settlement', fraud_status: 'accept', transaction_id: `auth-${uniq}-1`, payment_type: 'qris',
  });
  expect(settle1.status === 200 && settle1.data.activated, `settlement parent-first gagal: ${settle1.status} ${JSON.stringify(settle1.data)}`);
  const p1 = await db.query('SELECT package,level_count,amount_idr,status FROM purchases WHERE id=$1', [buy1.data.purchase_id]);
  expect(p1.rows[0].package === 'basic_bundle_3' && p1.rows[0].level_count === 3 && p1.rows[0].amount_idr === 100000 && p1.rows[0].status === 'pending', JSON.stringify(p1.rows[0]));
  console.log('[2] QRIS parent-first pending ok (amount 100000)');

  // [3] Kode undangan ortu-dahulu (student_id NULL)
  const invite = await post('/payments/invite', { parent_id: parentId }, parentToken);
  expect((invite.status === 200 || invite.status === 201) && invite.data.code, `invite gagal: ${invite.status}`);
  console.log('[3] invite code:', invite.data.code);

  // [4] Anak register
  const childReg = await post('/auth/student/register', {
    name: 'ANAK TEST PAYMENT',
    kelas: 4,
    parent_phone: phone,
  });
  expect(childReg.status === 200 || childReg.status === 201, `student register gagal: ${childReg.status} ${JSON.stringify(childReg.data)}`);
  studentId = childReg.data?.student?.id || childReg.data?.student?.student_id || childReg.data?.id;
  const studentToken = childReg.data.token;
  expect(studentId, `student id tidak ditemukan di respons: ${JSON.stringify(childReg.data).slice(0, 300)}`);
  expect(studentToken, 'student token tidak ditemukan di respons register');
  console.log('[4] student registered:', studentId);

  // [5] Parent-first invite: anak yang login menukar kode.
  const redeem = await post('/payments/invite/redeem', {
    code: invite.data.code,
  }, studentToken);
  expect(redeem.status === 200, `redeem gagal: ${redeem.status} ${JSON.stringify(redeem.data)}`);
  expect(redeem.data.linked === true, 'expect linked=true');
  expect(redeem.data.transferred_levels === 3, `expect transferred 3, got ${redeem.data.transferred_levels}`);
  expect(redeem.data.access.pending_levels === 3, `expect pending_levels 3, got ${redeem.data.access.pending_levels}`);
  expect(redeem.data.access.scope === null, 'scope harus null sebelum placement');
  console.log('[5] redeem ok: linked, 3 kredit pending pindah ke anak');

  // [6] Status sebelum placement — belum ada scope
  const st1 = await (await fetch(`${BASE}/payments/status/${studentId}`, {
    headers: { Authorization: `Bearer ${parentToken}` },
  })).json();
  expect(st1.placement_anchor === null, `anchor harus null, got ${st1.placement_anchor}`);
  expect(st1.scope === null, 'scope harus null sebelum placement');
  expect(st1.pending_levels === 3, `pending 3, got ${st1.pending_levels}`);
  console.log('[6] status pra-placement ok: anchor=null scope=null pending=3');

  // [7] Placement selesai → aktivasi otomatis kredit pending
  const startRes = await fetch(`${BASE}/placement/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId }),
  });
  expect(startRes.ok, `placement start gagal: ${startRes.status}`);
  const startData = await startRes.json();
  placementId = startData.placementId;
  // Semua jawaban salah → early stop di soal ke-3 → placed_level 1
  const answers = startData.exercises.slice(0, 3).map((q) => ({
    probeId: q.probeId, answer: 999999, timeTakenMs: 2000,
  }));
  const subRes = await fetch(`${BASE}/placement/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId, placementId, answers }),
  });
  if (!subRes.ok) {
    // Baca body hanya saat gagal (jangan dievaluasi saat OK — akan menghabiskan stream)
    const errText = await subRes.text().catch(() => '');
    expect(false, `placement submit gagal: ${subRes.status} ${errText}`);
  }
  const subData = await subRes.json();
  expect(subData.placedLevel === 1, `placedLevel expect 1, got ${subData.placedLevel}`);
  expect(subData.earlyStopped === true, 'earlyStopped harus true (3 gagal berturut)');
  console.log('[7] placement selesai: placedLevel=1, earlyStopped=true');

  // [8] Scope aktif otomatis [1..3], pending habis
  const st2 = await (await fetch(`${BASE}/payments/status/${studentId}`, {
    headers: { Authorization: `Bearer ${parentToken}` },
  })).json();
  expect(st2.placement_anchor === 1, `anchor expect 1, got ${st2.placement_anchor}`);
  expect(st2.scope && st2.scope.from === 1 && st2.scope.to === 3,
    `scope expect 1..3, got ${JSON.stringify(st2.scope)}`);
  expect(st2.pending_levels === 0, `pending expect 0, got ${st2.pending_levels}`);
  expect(st2.next_purchase_starts_at === 4, `next purchase expect 4, got ${st2.next_purchase_starts_at}`);
  const stu = await db.query('SELECT paid_basic_up_to_level FROM students WHERE id = $1', [studentId]);
  expect(stu.rows[0].paid_basic_up_to_level === 3,
    `paid_basic_up_to_level expect 3, got ${stu.rows[0].paid_basic_up_to_level}`);
  console.log('[8] aktivasi otomatis ok: scope [1..3], pending=0, paid_basic_up_to_level=3');

  // [9] Top-up QRIS level_1 SETELAH placement → aktif [4..4], tanpa overlap.
  const buy2 = await post('/payments/qris', { package: 'basic_single', student_id: studentId }, parentToken);
  expect(buy2.status === 201 && buy2.data.level_from === 4 && buy2.data.level_to === 4, `top-up QRIS gagal: ${buy2.status} ${JSON.stringify(buy2.data)}`);
  const settle2 = await post('/midtrans/webhook', {
    order_id: buy2.data.order_id, status_code: '200', gross_amount: '40000.00',
    signature_key: sign(buy2.data.order_id, '200', '40000.00'),
    transaction_status: 'settlement', fraud_status: 'accept', transaction_id: `auth-${uniq}-2`, payment_type: 'qris',
  });
  expect(settle2.status === 200 && settle2.data.activated, `settlement top-up gagal: ${settle2.status} ${JSON.stringify(settle2.data)}`);
  const p2 = await db.query('SELECT status,level_from,level_to,amount_idr FROM purchases WHERE id=$1', [buy2.data.purchase_id]);
  expect(p2.rows[0].status === 'active' && p2.rows[0].level_from === 4 && p2.rows[0].level_to === 4 && p2.rows[0].amount_idr === 40000, JSON.stringify(p2.rows[0]));
  const st3 = await (await fetch(`${BASE}/payments/status/${studentId}`, { headers: { Authorization: `Bearer ${parentToken}` } })).json();
  expect(st3.scope && st3.scope.to === 4, `scope end expect 4, got ${JSON.stringify(st3.scope)}`);
  console.log('[9] QRIS top-up ok: aktif [4..4] menyambung scope [1..3] → [1..4]');

  // [10] Edge cases
  const manualDisabled = await post('/payments/purchase', { package: 'basic_single', parent_id: parentId }, parentToken);
  expect(manualDisabled.status === 410, `manual purchase harus 410, got ${manualDisabled.status}`);
  const e1 = await post('/payments/qris', { package: 'level_99', parent_id: parentId }, parentToken);
  expect(e1.status === 400, `invalid package expect 400, got ${e1.status}`);
  const unauthPurchase = await post('/payments/qris', { package: 'basic_single' });
  expect(unauthPurchase.status === 401, `QRIS tanpa token expect 401, got ${unauthPurchase.status}`);
  const unauthInvite = await post('/payments/invite', { parent_id: parentId });
  expect(unauthInvite.status === 401, `invite tanpa token expect 401, got ${unauthInvite.status}`);
  const unauthRedeem = await post('/payments/invite/redeem', { code: 'CADAS-00000000' });
  expect(unauthRedeem.status === 401, `redeem tanpa token expect 401, got ${unauthRedeem.status}`);

  // Student-first: anak membuat invite, parent yang login menukarnya.
  const studentInvite = await post('/payments/invite', {}, studentToken);
  expect(studentInvite.status === 201 && studentInvite.data.code,
    `student invite gagal: ${studentInvite.status} ${JSON.stringify(studentInvite.data)}`);
  const parentRedeem = await post('/payments/invite/redeem', { code: studentInvite.data.code }, parentToken);
  expect(parentRedeem.status === 200, `parent redeem student invite gagal: ${parentRedeem.status} ${JSON.stringify(parentRedeem.data)}`);
  expect(parentRedeem.data.linked === true && parentRedeem.data.transferred_levels === 0,
    `student-first redeem hasil salah: ${JSON.stringify(parentRedeem.data)}`);
  console.log('[10] student-first invite → parent redeem OK');

  const e3 = await post('/payments/invite/redeem', { code: 'CADAS-00000000' }, parentToken);
  expect(e3.status === 404, `kode ngawur expect 404, got ${e3.status}`);
  const e4 = await post('/payments/invite/redeem', { code: invite.data.code }, parentToken);
  expect(e4.status === 409, `kode bekas expect 409, got ${e4.status}`);
  console.log('[11] edge cases ok: 401/401/401/404/409');

  console.log('\nALL AUTH-PAYMENT INTEGRATION CHECKS PASSED');
  process.exit(0);
}

main().catch(async (e) => {
  console.error('AUTH-PAYMENT INTEGRATION FAIL:', e.message);
  process.exitCode = 1;
}).finally(async () => {
  // Cleanup semua baris test
  try {
    if (parentId) {
      await db.query('DELETE FROM invite_links WHERE used_by_parent = $1 OR student_id = $2', [parentId, studentId]);
      await db.query('DELETE FROM payment_records WHERE parent_id = $1 OR student_id = $2', [parentId, studentId]);
      await db.query('DELETE FROM midtrans_invoices WHERE parent_id = $1 OR student_id = $2', [parentId, studentId]);
      await db.query('DELETE FROM purchases WHERE parent_id = $1 OR student_id = $2', [parentId, studentId]);
      await db.query('DELETE FROM parent_children WHERE parent_id = $1 OR student_id = $2', [parentId, studentId]);
      await db.query('DELETE FROM parents WHERE id = $1', [parentId]);
    }
    if (studentId) {
      await db.query('DELETE FROM student_variant_bias WHERE student_id = $1', [studentId]);
      await db.query('DELETE FROM placement_tests WHERE student_id = $1', [studentId]);
      await db.query('DELETE FROM students WHERE id = $1', [studentId]);
    }
    console.log('[cleanup] semua baris test dihapus');
  } catch (cleanupErr) {
    console.error('[cleanup] gagal:', cleanupErr.message);
  } finally {
    // Fallback: jika parent terlanjur dibuat tapi gagal sebelum parentId
    // tersimpan (mis. phone UNIQUE conflict) — hapus by email pattern run ini.
    try {
      await db.query('DELETE FROM parents WHERE email = $1', [`ortu${uniq}@test.local`]);
    } catch (e2) {
      console.error('[cleanup-fallback] gagal:', e2.message);
    }
  }
  if (process.exitCode !== 1) process.exit(0);
});

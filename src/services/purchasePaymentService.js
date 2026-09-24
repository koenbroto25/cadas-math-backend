/** Purchase + Midtrans QRIS service. */
const db = require('../database/db');
const access = require('./accessService');
const feeMatrix = require('../utils/fee-matrix');
const midtrans = require('./midtransService');

const PACKAGES = {
  basic_single: { tier: 'basic', level_count: 1, amount_idr: 40000 },
  basic_bundle_3: { tier: 'basic', level_count: 3, amount_idr: 100000 },
  premium_single: { tier: 'premium', level_count: 1, amount_idr: 65000 },
  premium_bundle_3: { tier: 'premium', level_count: 3, amount_idr: 165000 },
};
const pkgFor = (name) => {
  if (!PACKAGES[name]) throw Object.assign(new Error('Paket tidak dikenal'), { status: 400 });
  return PACKAGES[name];
};
const orderFor = (id) => `cadas_pkg_${id.replace(/-/g, '').slice(0, 20)}_${Date.now()}`;

async function linked(parentId, studentId) {
  const r = await db.query('SELECT 1 FROM parent_children WHERE parent_id=$1 AND student_id=$2', [parentId, studentId]);
  return r.rowCount > 0;
}
async function purchaseForInvoice(invoice) {
  if (!invoice?.purchase_id) return null;
  const r = await db.query('SELECT * FROM purchases WHERE id=$1', [invoice.purchase_id]);
  return r.rows[0] || null;
}

async function resolveReferrerCode(studentId, supplied, parentId = null) {
  const code = String(supplied || '').trim();
  if (code) {
    const ref = await db.query(
      "SELECT id FROM referrers WHERE referral_code=$1 AND status='approved' AND is_active=true",
      [code]
    );
    if (!ref.rowCount) throw Object.assign(new Error('Kode referral tidak valid'), { status: 400 });
    return code;
  }
  if (studentId) {
    const ref = await db.query(
      `SELECT r.referral_code FROM students s JOIN referrers r ON r.id=s.referred_by
       WHERE s.id=$1 AND r.status='approved' AND r.is_active=true`,
      [studentId]
    );
    return ref.rows[0]?.referral_code || null;
  }
  if (parentId) {
    const ref = await db.query(
      `SELECT r.referral_code FROM parents p JOIN referrers r ON r.id=p.referred_by
       WHERE p.id=$1 AND r.status='approved' AND r.is_active=true`,
      [parentId]
    );
    return ref.rows[0]?.referral_code || null;
  }
  return null;
}

async function quoteForPackage(studentId, pkg) {
  if (!studentId) return { level_from: null, level_to: null, pending_until_placement: true };
  const row = await db.query(
    `SELECT s.paid_basic_up_to_level, s.paid_premium_up_to_level,
            (SELECT placed_level FROM placement_tests p
             WHERE p.student_id=s.id::text AND p.status='completed'
             ORDER BY p.completed_at DESC NULLS LAST, p.started_at DESC LIMIT 1) AS anchor,
            (SELECT COALESCE(SUM(level_count),0)::int FROM purchases p
             WHERE p.student_id=s.id AND p.status='pending' AND p.is_confirmed=TRUE
               AND COALESCE(p.tier,'basic')=$2::text) AS pending_count
     FROM students s WHERE s.id=$1::uuid`,
    [studentId, String(pkg.tier)]
  );
  if (!row.rowCount) throw Object.assign(new Error('Siswa tidak ditemukan'), { status: 404 });
  const r = row.rows[0];
  if (r.anchor === null) return { level_from: null, level_to: null, pending_until_placement: true };
  const paid = pkg.tier === 'premium' ? r.paid_premium_up_to_level : r.paid_basic_up_to_level;
  const from = Math.max(paid ?? r.anchor - 1, r.anchor - 1) + (r.pending_count || 0) + 1;
  const to = from + pkg.level_count - 1;
  if (to > 15) throw Object.assign(new Error('Paket ini melewati level maksimum 15'), { status: 409 });
  return { level_from: from, level_to: to, pending_until_placement: false };
}

async function createQrisPurchase({ role, actorId, studentId = null, packageName, referrerCode = null }) {
  const pkg = pkgFor(packageName);
  const sid = role === 'student' ? actorId : (studentId || null);
  const parentId = role === 'parent' ? actorId : null;
  if (role === 'parent' && studentId && !(await linked(parentId, studentId))) {
    throw Object.assign(new Error('Anak belum tertaut ke akun ini'), { status: 403 });
  }
  if (role !== 'student' && role !== 'parent') {
    throw Object.assign(new Error('Role tidak dapat membeli paket'), { status: 403 });
  }
  const code = await resolveReferrerCode(sid, referrerCode, parentId);
  const quote = await quoteForPackage(sid, pkg);
  if (role === 'parent' && !sid) {
    const reserved = await db.query(
      `SELECT COALESCE(SUM(level_count),0)::int AS n FROM purchases
       WHERE parent_id=$1 AND student_id IS NULL AND status IN ('unpaid','pending')`,
      [parentId]
    );
    if ((reserved.rows[0]?.n || 0) + pkg.level_count > 3) {
      throw Object.assign(new Error('Total kredit parent-first maksimal 3 level'), { status: 409 });
    }
  }
  const existing = await db.query(
    `SELECT p.id, p.order_id, p.qr_expires_at, p.qr_code_url, p.status,
            p.package, p.level_count, p.amount_idr, p.qr_string, i.midtrans_order_id
     FROM purchases p JOIN midtrans_invoices i ON i.purchase_id=p.id
       WHERE p.status='unpaid' AND p.midtrans_status='pending'
         AND p.qr_expires_at > NOW() + INTERVAL '1 minute'
         AND p.package=$1 AND p.student_id IS NOT DISTINCT FROM $2 AND p.parent_id IS NOT DISTINCT FROM $3
      ORDER BY p.created_at DESC LIMIT 1`,
    [packageName, sid, parentId]
  );
  if (existing.rowCount) {
    const p = existing.rows[0];
    return { purchase_id: p.id, package: p.package, level_count: p.level_count,
      amount_idr: p.amount_idr, status: p.status, order_id: p.midtrans_order_id,
      qr_string: p.qr_string, qr_url: p.qr_code_url, expires_at: p.qr_expires_at, ...quote };
  }
  const created = await db.query(
    `INSERT INTO purchases
      (student_id,parent_id,package,level_count,amount_idr,status,tier,referrer_code,payment_method,is_confirmed)
     VALUES ($1,$2,$3,$4,$5,'unpaid',$6,$7,'qris_midtrans',FALSE) RETURNING *`,
    [sid, parentId, packageName, pkg.level_count, pkg.amount_idr, pkg.tier, code]
  );
  const purchase = created.rows[0];
  const orderId = orderFor(purchase.id);
  try {
    const qr = await midtrans.createQris({ orderId, grossAmount: pkg.amount_idr, itemName: `Cadas ${packageName}` });
    await db.query(
      `UPDATE purchases SET order_id=$2, qr_expires_at=$3, midtrans_status='pending',
       qr_code_url=$4, qr_string=$5 WHERE id=$1`,
      [purchase.id, orderId, qr.expiry_time || null, qr.qr_code_url || null, qr.qr_string || null]
    );
    await db.query(
      `INSERT INTO midtrans_invoices
       (student_id,parent_id,purchase_id,midtrans_order_id,midtrans_payment_url,
        product_type,level_from,level_to,amount_idr,referrer_code,status,payment_type)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,$7,$8,'pending','qris')`,
      [sid, parentId, purchase.id, orderId, qr.qr_code_url || '', packageName, pkg.amount_idr, code]
    );
    return { purchase_id: purchase.id, package: packageName, level_count: pkg.level_count,
      amount_idr: pkg.amount_idr, status: 'unpaid', order_id: orderId, qr_string: qr.qr_string,
      qr_url: qr.qr_code_url, expires_at: qr.expiry_time, ...quote,
      sandbox: String(process.env.MIDTRANS_SANDBOX || 'true').toLowerCase() !== 'false' };
  } catch (err) {
    await db.query("UPDATE purchases SET midtrans_status='failed' WHERE id=$1", [purchase.id]).catch(() => {});
    throw err;
  }
}


async function settleCommission(paymentRecordId, purchase, studentId) {
  if (!purchase.referrer_code) return;
  const settings = await feeMatrix.getSettings();
  const earnings = await feeMatrix.calcSplitFee(
    purchase.referrer_code, purchase.amount_idr, settings, { paymentRecordId, studentId }
  );
  const total = earnings.reduce((n, e) => n + e.amount, 0);
  await db.query('UPDATE payment_records SET commission_amount_idr=$2 WHERE id=$1', [paymentRecordId, total]);
  await feeMatrix.saveEarnings(earnings, {
    paymentRecordId, studentId, amountIdr: purchase.amount_idr, status: 'ready'
  });
}

async function reconcileStudentPurchase(db, purchaseId, studentId) {
  const found = await db.query(
    `SELECT * FROM purchases WHERE id=$1 AND status='pending' AND is_confirmed=TRUE FOR UPDATE`,
    [purchaseId]
  );
  if (!found.rowCount) return false;
  const purchase = found.rows[0];
  if (!purchase.student_id) {
    await db.query('UPDATE purchases SET student_id=$2 WHERE id=$1', [purchaseId, studentId]);
    await db.query('UPDATE midtrans_invoices SET student_id=$2 WHERE purchase_id=$1', [purchaseId, studentId]);
  }
  const anchor = await access.getPlacementAnchor(db, studentId);
  if (anchor !== null) {
    const activation = await access.activatePendingPurchases(db, studentId, anchor);
    const active = activation.activated.find(x => x.purchase_id === purchaseId);
    if (active) {
      await db.query(
        'UPDATE midtrans_invoices SET level_from=$2, level_to=$3 WHERE purchase_id=$1',
        [purchaseId, active.level_from, active.level_to]
      );
      await db.query(
        'UPDATE payment_records SET level_from=$2, level_to=$3 WHERE purchase_id=$1',
        [purchaseId, active.level_from, active.level_to]
      );
    }
  }
  const rec = await db.query(
    `UPDATE payment_records SET student_id=$2 WHERE purchase_id=$1 RETURNING id`,
    [purchaseId, studentId]
  );
  if (rec.rowCount) await settleCommission(rec.rows[0].id, purchase, studentId);
  return true;
}

async function settlePaidInvoice(invoice, payload) {
  const purchase = await purchaseForInvoice(invoice);
  if (!purchase) return { legacy: true };
  if (purchase.midtrans_status === 'paid' || purchase.status === 'active') return { already: true, purchase_id: purchase.id };
  const claimed = await db.query(
    `UPDATE purchases SET status='pending',midtrans_status='paid',is_confirmed=TRUE,confirmed_at=NOW()
     WHERE id=$1 AND (midtrans_status IS DISTINCT FROM 'paid' OR status <> 'active') RETURNING *`,
    [purchase.id]
  );
  if (!claimed.rowCount) return { already: true, purchase_id: purchase.id };
  const paidPurchase = claimed.rows[0];
  await db.query("UPDATE midtrans_invoices SET status='paid',paid_at=NOW(),midtrans_transaction_id=$2::text,payment_type=COALESCE($3::text,payment_type) WHERE id=$1::uuid", [invoice.id, payload.transaction_id || null, payload.payment_type || null]);
  const sid = paidPurchase.student_id || invoice.student_id || null;
  if (sid) {
    await db.query(
      `UPDATE students SET pending_levels = pending_levels + $2::int
       WHERE id = $1::uuid`,
      [sid, paidPurchase.level_count]
    );
  }
  const anchor = sid ? await access.getPlacementAnchor(db, sid) : null;
  const record = await db.query(
    `INSERT INTO payment_records
     (student_id,parent_id,purchase_id,product_type,level_from,level_to,amount_idr,
      payment_method,referrer_code,commission_amount_idr,is_confirmed,confirmed_by_admin_at)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4::text,NULL,NULL,$5::int,'qris_midtrans',$6::text,0,TRUE,NOW())
     ON CONFLICT (purchase_id) DO UPDATE SET student_id=COALESCE(payment_records.student_id,EXCLUDED.student_id),parent_id=COALESCE(payment_records.parent_id,EXCLUDED.parent_id) RETURNING id`,
    [sid, paidPurchase.parent_id, paidPurchase.id, paidPurchase.package, paidPurchase.amount_idr, paidPurchase.referrer_code || null]
  );
  if (sid && anchor !== null) {
    const activation = await access.activatePendingPurchases(db, sid, anchor);
    const active = activation.activated.find(x => x.purchase_id === paidPurchase.id);
    if (active) {
      await db.query(
        'UPDATE midtrans_invoices SET level_from=$2, level_to=$3 WHERE purchase_id=$1',
        [paidPurchase.id, active.level_from, active.level_to]
      );
      await db.query(
        'UPDATE payment_records SET level_from=$2, level_to=$3 WHERE purchase_id=$1',
        [paidPurchase.id, active.level_from, active.level_to]
      );
    }
  }
  if (sid) await settleCommission(record.rows[0].id, paidPurchase, sid);
  return { already: false, purchase_id: purchase.id, student_id: sid };
}

async function markInvoiceStatus(invoice, status, payload = {}) {
  const purchase = await purchaseForInvoice(invoice);
  await db.query("UPDATE midtrans_invoices SET status=$1,midtrans_transaction_id=COALESCE($2,midtrans_transaction_id),payment_type=COALESCE($3,payment_type) WHERE id=$4", [status, payload.transaction_id || null, payload.payment_type || null, invoice.id]);
  if (purchase) await db.query('UPDATE purchases SET midtrans_status=$1 WHERE id=$2', [status, purchase.id]);
}

module.exports = { PACKAGES, createQrisPurchase, settlePaidInvoice, markInvoiceStatus, settleCommission, reconcileStudentPurchase };

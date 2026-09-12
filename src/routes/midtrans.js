/**
 * routes/midtrans.js - Sprint D.2 (migrasi dari Xendit)
 * Midtrans Core API Integration
 *
 * POST /api/midtrans/create-transaction  - buat transaksi QRIS
 * POST /api/midtrans/webhook             - notifikasi Midtrans (SHA-512)
 * GET  /api/midtrans/status/:order_id    - cek status dari DB
 * GET  /api/midtrans/check-live/:order_id - cek langsung ke Midtrans API
 */
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');
const axios   = require('axios');
const http    = require('http');
const https   = require('https');
// Paksa IPv4 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â hindari ECONNRESET di jaringan dual-stack
const ipv4Agent = {
  httpAgent:  new http.Agent({ family: 4 }),
  httpsAgent: new https.Agent({ family: 4 }),
};
const crypto  = require('crypto');
const { verifyToken, requireRole } = require('../middleware/auth');

const MT_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY || '';
const MT_IS_SANDBOX = process.env.MIDTRANS_SANDBOX !== 'false';
const MT_BASE_URL   = MT_IS_SANDBOX
  ? 'https://api.sandbox.midtrans.com'
  : 'https://api.midtrans.com';
const MT_AUTH       = () => Buffer.from(`${MT_SERVER_KEY}:`).toString('base64');
const APP_BASE_URL  = process.env.APP_BASE_URL || 'https://cadas.app';

const PRICING = {
  basic_single: 40000, basic_bundle_3: 100000,
  premium_single: 65000, premium_bundle_3: 165000,
  upgrade_diff: 25000,
};

async function calcCommission(referrerCode, amountIdr) {
  if (!referrerCode) return { referrerId: null, commission: 0 };
  const r = await db.query(
    "SELECT id, commission_rate FROM referrers WHERE referral_code = $1 AND status = 'approved'",
    [referrerCode]
  );
  if (r.rowCount === 0) return { referrerId: null, commission: 0 };
  return {
    referrerId: r.rows[0].id,
    commission: Math.round(amountIdr * parseFloat(r.rows[0].commission_rate) / 100),
  };
}

function verifySignature(orderId, statusCode, grossAmount) {
  const raw = `${orderId}${statusCode}${grossAmount}${MT_SERVER_KEY}`;
  return crypto.createHash('sha512').update(raw).digest('hex');
}

async function activateAccess(invoice) {
  const col = invoice.product_type.startsWith('premium')
    ? 'paid_premium_up_to_level'
    : 'paid_basic_up_to_level';
  await db.query(
    `UPDATE students SET ${col} = GREATEST(COALESCE(${col}, 0), $1) WHERE id = $2`,
    [invoice.level_to, invoice.student_id]
  );
}

// POST /api/midtrans/create-transaction
router.post('/create-transaction', verifyToken, requireRole('parent', 'student'), async (req, res) => {
  const { student_id, product_type, level_from, level_to,
          payment_method = 'qris', referrer_code } = req.body || {};

  if (!student_id || !product_type || !level_from || !level_to)
    return res.status(400).json({ error: 'student_id, product_type, level_from, level_to wajib' });
  if (!PRICING[product_type])
    return res.status(400).json({ error: `product_type tidak valid: ${Object.keys(PRICING).join(', ')}` });
  if (!MT_SERVER_KEY)
    return res.status(503).json({ error: 'Midtrans belum dikonfigurasi (MIDTRANS_SERVER_KEY kosong)' });

  try {
    const amount_idr = PRICING[product_type];
    const order_id   = `cadas_${student_id.slice(0,8)}_${product_type}_${Date.now()}`;

    const s = await db.query('SELECT display_name FROM students WHERE id = $1', [student_id]);
    if (s.rowCount === 0) return res.status(404).json({ error: 'siswa tidak ditemukan' });
    const display_name = s.rows[0].display_name;

    const mtBody = {
      payment_type: payment_method,
      transaction_details: { order_id, gross_amount: amount_idr },
      item_details: [{
        id: product_type, price: amount_idr, quantity: 1,
        name: `Cadas ${product_type} Lv ${level_from}-${level_to}`,
      }],
      customer_details: { first_name: display_name },
    };

    // QRIS only
    mtBody.payment_type = 'qris';
    mtBody.qris = { acquirer: 'gopay' };

    const mtRes = await axios.post(`${MT_BASE_URL}/v2/charge`, mtBody, {
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${MT_AUTH()}` },
      ...ipv4Agent,
    });
    const mt = mtRes.data;

    let va_number = null, payment_url = null;
    if (mt.va_numbers?.length > 0)      va_number   = mt.va_numbers[0].va_number;
    else if (mt.payment_code)           va_number   = mt.payment_code;
    else if (mt.actions) {
      const a = mt.actions.find(x => x.name === 'generate-qr-code' || x.name === 'deeplink-redirect');
      if (a) payment_url = a.url;
    }

    await db.query(`
      INSERT INTO midtrans_invoices
        (student_id, midtrans_order_id, midtrans_payment_url,
         product_type, level_from, level_to, amount_idr,
         referrer_code, status, payment_type, va_number)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10)
    `, [student_id, order_id, payment_url || '', product_type,
        level_from, level_to, amount_idr, referrer_code || null,
        payment_method, va_number]);

    res.json({ ok: true, order_id, payment_type: payment_method,
               va_number, payment_url, amount_idr,
               expires_at: mt.expiry_time || null, sandbox: MT_IS_SANDBOX });
  } catch (err) {
    const d = err.response?.data;
    console.error('Midtrans create-transaction error:', d || err.message);
    res.status(500).json({ error: d?.error_messages?.[0] || err.message });
  }
});
// POST /api/midtrans/webhook
router.post('/webhook', async (req, res) => {
  const { order_id, status_code, gross_amount, signature_key,
          transaction_status, fraud_status, transaction_id, payment_type } = req.body || {};

  if (!order_id || !status_code || !gross_amount || !signature_key)
    return res.status(400).json({ error: 'payload webhook tidak lengkap' });

  // Verifikasi signature SHA-512
  const expected = verifySignature(order_id, status_code, gross_amount);
  if (expected !== signature_key) {
    console.warn('Midtrans webhook: signature tidak valid', { order_id });
    return res.status(401).json({ error: 'signature tidak valid' });
  }

  const isPaid    = transaction_status === 'settlement' ||
                    (transaction_status === 'capture' && fraud_status === 'accept');
  const isExpired = transaction_status === 'expire';
  const isFailed  = ['deny','cancel','failure'].includes(transaction_status);

  try {
    const inv = await db.query(
      'SELECT * FROM midtrans_invoices WHERE midtrans_order_id = $1', [order_id]);
    if (inv.rowCount === 0) {
      console.warn('Midtrans webhook: order tidak ditemukan', order_id);
      return res.status(404).json({ error: 'order tidak ditemukan' });
    }
    const invoice = inv.rows[0];

    if (!isPaid) {
      const newStatus = isExpired ? 'expired' : isFailed ? 'failed' : transaction_status;
      await db.query(
        'UPDATE midtrans_invoices SET status=$1, midtrans_transaction_id=$2, payment_type=$3 WHERE id=$4',
        [newStatus, transaction_id || null, payment_type || null, invoice.id]);
      console.log(`Midtrans webhook: ${order_id} -> ${newStatus}`);
      return res.json({ ok: true, status: newStatus });
    }

    // Idempotent check
    if (invoice.status === 'paid') return res.json({ ok: true, already: true });

    // Aktivasi akses siswa
    await activateAccess(invoice);

    // Update invoice
    await db.query(
      `UPDATE midtrans_invoices
       SET status='paid', paid_at=NOW(), midtrans_transaction_id=$1, payment_type=$2
       WHERE id=$3`,
      [transaction_id || null, payment_type || null, invoice.id]);

    // Simpan payment_record
    const { referrerId, commission } = await calcCommission(invoice.referrer_code, invoice.amount_idr);
    const pr = await db.query(`
      INSERT INTO payment_records
        (student_id, product_type, level_from, level_to, amount_idr,
         payment_method, referrer_code, commission_amount_idr, is_confirmed, confirmed_by_admin_at)
      VALUES ($1,$2,$3,$4,$5,'midtrans_core',$6,$7,true,NOW())
      RETURNING id
    `, [invoice.student_id, invoice.product_type, invoice.level_from,
        invoice.level_to, invoice.amount_idr, invoice.referrer_code, commission]);

    // Catat komisi referrer
    if (referrerId && commission > 0) {
      await db.query(`
        INSERT INTO referrer_earnings
          (referrer_id, payment_record_id, midtrans_invoice_id, student_id,
           amount_idr, commission_rate, commission_idr)
        VALUES ($1,$2,$3,$4,$5,(SELECT commission_rate FROM referrers WHERE id=$1),$6)
      `, [referrerId, pr.rows[0].id, invoice.id, invoice.student_id,
          invoice.amount_idr, commission]);
      await db.query(`
        UPDATE referrers SET
          total_conversions  = total_conversions + 1,
          total_earnings_idr = total_earnings_idr + $1
        WHERE id = $2
      `, [commission, referrerId]);
    }

    console.log(`Midtrans webhook: ${order_id} PAID -> siswa ${invoice.student_id} diaktifkan`);
    res.json({ ok: true, activated: true, student_id: invoice.student_id });

  } catch (err) {
    console.error('Midtrans webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/midtrans/status/:order_id ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â cek dari DB
router.get('/status/:order_id', verifyToken, async (req, res) => {
  try {
    const inv = await db.query(`
      SELECT status, paid_at, amount_idr, product_type, level_from, level_to,
             payment_type, va_number, midtrans_transaction_id, created_at
      FROM midtrans_invoices WHERE midtrans_order_id = $1
    `, [req.params.order_id]);
    if (inv.rowCount === 0) return res.status(404).json({ error: 'order tidak ditemukan' });
    res.json(inv.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/midtrans/check-live/:order_id ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â cek langsung ke Midtrans (polling fallback)
router.get('/check-live/:order_id', verifyToken, async (req, res) => {
  if (!MT_SERVER_KEY) return res.status(503).json({ error: 'Midtrans belum dikonfigurasi' });
  try {
    const mtRes = await axios.get(
      `${MT_BASE_URL}/v2/${req.params.order_id}/status`,
      { headers: { Authorization: `Basic ${MT_AUTH()}` }, ...ipv4Agent }
    );
    const mt = mtRes.data;
    res.json({
      order_id:           mt.order_id,
      transaction_status: mt.transaction_status,
      fraud_status:       mt.fraud_status,
      payment_type:       mt.payment_type,
      gross_amount:       mt.gross_amount,
      transaction_time:   mt.transaction_time,
      settlement_time:    mt.settlement_time,
    });
  } catch (err) {
    const d = err.response?.data;
    res.status(err.response?.status || 500).json({ error: d?.error_messages?.[0] || err.message });
  }
});

module.exports = router;
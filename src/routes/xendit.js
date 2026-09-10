/**
 * routes/xendit.js - Sprint D.2
 * Xendit Invoice Integration
 *
 * POST /api/xendit/create-invoice   - buat invoice Xendit
 * POST /api/xendit/webhook          - terima callback dari Xendit
 * GET  /api/xendit/status/:invoice_id - cek status invoice
 */
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');
const axios   = require('axios');
const { verifyToken, requireRole } = require('../middleware/auth');

const XENDIT_SECRET = process.env.XENDIT_SECRET_KEY || '';
const XENDIT_WEBHOOK_TOKEN = process.env.XENDIT_WEBHOOK_TOKEN || '';
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://cadas.app';

const PRICING = {
  basic_single: 40000, basic_bundle_3: 100000,
  premium_single: 65000, premium_bundle_3: 165000,
  upgrade_diff: 25000
};

async function calcCommission(referrerCode, amountIdr) {
  if (!referrerCode) return { referrerId: null, commission: 0 };
  const r = await db.query(
    "SELECT id, commission_rate FROM referrers WHERE referral_code = $1 AND status = 'approved'",
    [referrerCode]);
  if (r.rowCount === 0) return { referrerId: null, commission: 0 };
  return { referrerId: r.rows[0].id, commission: Math.round(amountIdr * parseFloat(r.rows[0].commission_rate) / 100) };
}

// POST /api/xendit/create-invoice
router.post('/create-invoice', verifyToken, requireRole('parent', 'student'), async (req, res) => {
  const { student_id, product_type, level_from, level_to, referrer_code } = req.body || {};
  if (!student_id || !product_type || !level_from || !level_to) {
    return res.status(400).json({ error: 'student_id, product_type, level_from, level_to wajib' });
  }
  if (!PRICING[product_type]) {
    return res.status(400).json({ error: `product_type tidak valid: ${Object.keys(PRICING).join(', ')}` });
  }
  if (!XENDIT_SECRET) {
    return res.status(503).json({ error: 'Xendit belum dikonfigurasi (XENDIT_SECRET_KEY kosong)' });
  }

  try {
    const amount_idr = PRICING[product_type];
    const external_id = `cadas_${student_id}_${product_type}_${Date.now()}`;

    // Ambil data siswa untuk description
    const s = await db.query('SELECT display_name FROM students WHERE id = $1', [student_id]);
    if (s.rowCount === 0) return res.status(404).json({ error: 'siswa tidak ditemukan' });

    // Buat invoice di Xendit
    const xenditRes = await axios.post('https://api.xendit.co/v2/invoices', {
      external_id,
      amount: amount_idr,
      currency: 'IDR',
      description: `Cadas Matematika - ${product_type} Level ${level_from}-${level_to} (${s.rows[0].display_name})`,
      success_redirect_url: `${APP_BASE_URL}/payment-success`,
      failure_redirect_url: `${APP_BASE_URL}/payment-failed`,
      customer: { given_names: s.rows[0].display_name },
      items: [{
        name: `${product_type} Level ${level_from} - ${level_to}`,
        quantity: 1,
        price: amount_idr
      }]
    }, {
      auth: { username: XENDIT_SECRET, password: '' },
      headers: { 'Content-Type': 'application/json' }
    });

    const invoice = xenditRes.data;

    // Simpan ke DB
    await db.query(`
      INSERT INTO xendit_invoices
        (student_id, xendit_invoice_id, xendit_invoice_url, product_type,
         level_from, level_to, amount_idr, referrer_code, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
    `, [student_id, invoice.id, invoice.invoice_url, product_type,
        level_from, level_to, amount_idr, referrer_code || null]);

    res.json({
      ok: true,
      invoice_id: invoice.id,
      invoice_url: invoice.invoice_url,
      amount_idr,
      expires_at: invoice.expiry_date
    });
  } catch (err) {
    console.error('Xendit create-invoice error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// POST /api/xendit/webhook  (dipanggil Xendit setelah payment)
router.post('/webhook', async (req, res) => {
  // Verifikasi webhook token dari Xendit
  const token = req.headers['x-callback-token'];
  if (XENDIT_WEBHOOK_TOKEN && token !== XENDIT_WEBHOOK_TOKEN) {
    return res.status(401).json({ error: 'webhook token tidak valid' });
  }

  const { id: xendit_invoice_id, status, paid_amount, external_id } = req.body || {};
  if (!xendit_invoice_id) return res.status(400).json({ error: 'data webhook tidak valid' });

  try {
    if (status !== 'PAID') {
      // Update status (EXPIRED / FAILED)
      await db.query(
        "UPDATE xendit_invoices SET status = LOWER($1) WHERE xendit_invoice_id = $2",
        [status, xendit_invoice_id]);
      return res.json({ ok: true, status });
    }

    // Status PAID — aktivasi akses
    const inv = await db.query(
      'SELECT * FROM xendit_invoices WHERE xendit_invoice_id = $1', [xendit_invoice_id]);
    if (inv.rowCount === 0) return res.status(404).json({ error: 'invoice tidak ditemukan' });
    const invoice = inv.rows[0];

    // Idempotent check
    if (invoice.status === 'paid') return res.json({ ok: true, already: true });

    const { referrerId, commission } = await calcCommission(invoice.referrer_code, invoice.amount_idr);
    const isPremium = invoice.product_type.startsWith('premium');
    const col = isPremium ? 'paid_premium_up_to_level' : 'paid_basic_up_to_level';

    // Update akses siswa
    await db.query(
      `UPDATE students SET ${col} = GREATEST(COALESCE(${col}, 0), $1) WHERE id = $2`,
      [invoice.level_to, invoice.student_id]);

    // Update invoice status
    await db.query(
      "UPDATE xendit_invoices SET status='paid', paid_at=NOW() WHERE id=$1",
      [invoice.id]);

    // Simpan payment_record
    const pr = await db.query(`
      INSERT INTO payment_records
        (student_id, product_type, level_from, level_to, amount_idr,
         payment_method, referrer_code, commission_amount_idr,
         is_confirmed, confirmed_by_admin_at)
      VALUES ($1,$2,$3,$4,$5,'xendit_invoice',$6,$7,true,NOW())
      RETURNING id
    `, [invoice.student_id, invoice.product_type, invoice.level_from,
        invoice.level_to, invoice.amount_idr, invoice.referrer_code, commission]);

    // Catat komisi referrer
    if (referrerId && commission > 0) {
      await db.query(`
        INSERT INTO referrer_earnings
          (referrer_id, payment_record_id, xendit_invoice_id, student_id,
           amount_idr, commission_rate, commission_idr)
        VALUES ($1,$2,$3,$4,$5,
          (SELECT commission_rate FROM referrers WHERE id=$1),$6)
      `, [referrerId, pr.rows[0].id, invoice.id, invoice.student_id,
          invoice.amount_idr, commission]);
      await db.query(`
        UPDATE referrers SET
          total_conversions  = total_conversions + 1,
          total_earnings_idr = total_earnings_idr + $1
        WHERE id = $2
      `, [commission, referrerId]);
    }

    res.json({ ok: true, activated: true, student_id: invoice.student_id });
  } catch (err) {
    console.error('Xendit webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/xendit/status/:invoice_id
router.get('/status/:invoice_id', verifyToken, async (req, res) => {
  try {
    const inv = await db.query(
      'SELECT status, paid_at, amount_idr, product_type, level_from, level_to FROM xendit_invoices WHERE xendit_invoice_id = $1',
      [req.params.invoice_id]);
    if (inv.rowCount === 0) return res.status(404).json({ error: 'invoice tidak ditemukan' });
    res.json(inv.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

/**
 * routes/admin.js - Sprint D.4
 * Admin Dashboard Routes (dilindungi x-admin-secret header)
 *
 * GET  /api/admin/students          - list semua siswa + status bayar
 * GET  /api/admin/students/:id      - detail siswa + payment history
 * GET  /api/admin/referrers         - list semua referrer + stats
 * POST /api/admin/referrers         - buat referrer baru
 * PUT  /api/admin/referrers/:id     - update referrer (status, rate, bank)
 * GET  /api/admin/payments          - list semua payment (xendit + manual)
 * GET  /api/admin/earnings          - list referrer_earnings (untuk transfer)
 * PUT  /api/admin/earnings/:id      - mark earning as transferred
 * POST /api/admin/billing/activate  - manual activate billing (dari payment.js)
 * GET  /api/admin/billing/status/:student_id
 */
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

router.use(requireAdmin);

// -- STUDENTS --------------------------------------------------
// GET /api/admin/students?page=1&limit=20&search=nama
router.get('/students', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const search = req.query.search ? `%${req.query.search}%` : null;

    const where  = search ? 'WHERE s.username ILIKE $3 OR s.display_name ILIKE $3' : '';
    const params = search ? [limit, offset, search] : [limit, offset];

    const rows = await db.query(`
      SELECT s.id, s.username, s.display_name, s.grade_level,
             s.current_level, s.trial_level,
             s.paid_basic_up_to_level, s.paid_premium_up_to_level,
             s.created_at,
             r.referral_code AS referred_by_code
      FROM students s
      LEFT JOIN referrers r ON r.id = s.referred_by
      ${where}
      ORDER BY s.created_at DESC
      LIMIT $1 OFFSET $2
    `, params);

    const total = await db.query(`SELECT COUNT(*) FROM students s ${where}`,
      search ? [search] : []);

    res.json({ page, limit, total: parseInt(total.rows[0].count), students: rows.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/students/:id
router.get('/students/:id', async (req, res) => {
  try {
    const s = await db.query(
      `SELECT s.*, r.referral_code AS referred_by_code
       FROM students s LEFT JOIN referrers r ON r.id = s.referred_by
       WHERE s.id = $1`, [req.params.id]);
    if (s.rowCount === 0) return res.status(404).json({ error: 'siswa tidak ditemukan' });

    const payments = await db.query(
      'SELECT * FROM payment_records WHERE student_id = $1 ORDER BY created_at DESC',
      [req.params.id]);
    const invoices = await db.query(
      'SELECT * FROM xendit_invoices WHERE student_id = $1 ORDER BY created_at DESC',
      [req.params.id]);

    res.json({ student: s.rows[0], payment_records: payments.rows, xendit_invoices: invoices.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// -- REFERRERS -------------------------------------------------
// GET /api/admin/referrers
router.get('/referrers', async (req, res) => {
  try {
    const rows = await db.query(`
      SELECT id, full_name, email, referral_code, referral_token,
             commission_rate, status, bank_name, bank_account_number,
             bank_account_name, total_clicks, total_conversions,
             total_earnings_idr, total_transferred_idr, created_at
      FROM referrers ORDER BY created_at DESC
    `);
    res.json({ referrers: rows.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/referrers - buat referrer baru
router.post('/referrers', async (req, res) => {
  const { full_name, email, password, referral_code, commission_rate,
          bank_name, bank_account_number, bank_account_name } = req.body || {};
  if (!full_name || !email || !password || !referral_code) {
    return res.status(400).json({ error: 'full_name, email, password, referral_code wajib' });
  }
  try {
    const password_hash  = await bcrypt.hash(password, 10);
    const referral_token = uuidv4().replace(/-/g, '').slice(0, 16);
    const r = await db.query(`
      INSERT INTO referrers
        (full_name, email, password_hash, referral_code, referral_token,
         commission_rate, bank_name, bank_account_number, bank_account_name, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'approved')
      RETURNING id, full_name, email, referral_code, referral_token, status
    `, [full_name, email, password_hash, referral_code, referral_token,
        commission_rate || 10, bank_name, bank_account_number, bank_account_name]);
    res.status(201).json({ ok: true, referrer: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'email atau referral_code sudah dipakai' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/referrers/:id - update referrer
router.put('/referrers/:id', async (req, res) => {
  const { status, commission_rate, bank_name, bank_account_number,
          bank_account_name, full_name } = req.body || {};
  try {
    const r = await db.query(`
      UPDATE referrers SET
        status              = COALESCE($1, status),
        commission_rate     = COALESCE($2, commission_rate),
        bank_name           = COALESCE($3, bank_name),
        bank_account_number = COALESCE($4, bank_account_number),
        bank_account_name   = COALESCE($5, bank_account_name),
        full_name           = COALESCE($6, full_name),
        updated_at          = NOW()
      WHERE id = $7
      RETURNING id, full_name, email, referral_code, status, commission_rate
    `, [status, commission_rate, bank_name, bank_account_number,
        bank_account_name, full_name, req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'referrer tidak ditemukan' });
    res.json({ ok: true, referrer: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// -- PAYMENTS --------------------------------------------------
// GET /api/admin/payments?page=1&limit=20
router.get('/payments', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;

    const manual = await db.query(`
      SELECT 'manual' AS source, p.id, p.student_id, s.display_name,
             p.product_type, p.level_from, p.level_to, p.amount_idr,
             p.payment_method, p.referrer_code, p.is_confirmed,
             p.confirmed_by_admin_at AS paid_at, p.created_at
      FROM payment_records p JOIN students s ON s.id = p.student_id
      ORDER BY p.created_at DESC LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const xendit = await db.query(`
      SELECT 'xendit' AS source, x.id, x.student_id, s.display_name,
             x.product_type, x.level_from, x.level_to, x.amount_idr,
             'xendit_invoice' AS payment_method, x.referrer_code,
             (x.status = 'paid') AS is_confirmed, x.paid_at, x.created_at
      FROM xendit_invoices x JOIN students s ON s.id = x.student_id
      ORDER BY x.created_at DESC LIMIT $1 OFFSET $2
    `, [limit, offset]);

    res.json({ manual: manual.rows, xendit: xendit.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// -- EARNINGS --------------------------------------------------
// GET /api/admin/earnings?status=pending
router.get('/earnings', async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const rows = await db.query(`
      SELECT e.*, r.full_name AS referrer_name, r.email AS referrer_email,
             r.bank_name, r.bank_account_number, r.bank_account_name,
             s.display_name AS student_name
      FROM referrer_earnings e
      JOIN referrers r ON r.id = e.referrer_id
      LEFT JOIN students s ON s.id = e.student_id
      WHERE e.status = $1
      ORDER BY e.created_at DESC
    `, [status]);
    res.json({ earnings: rows.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/admin/earnings/:id - mark as transferred
router.put('/earnings/:id', async (req, res) => {
  try {
    const e = await db.query(`
      UPDATE referrer_earnings
      SET status = 'transferred', transferred_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING *
    `, [req.params.id]);
    if (e.rowCount === 0) return res.status(404).json({ error: 'earning tidak ditemukan atau sudah ditransfer' });

    // Update total_transferred di referrers
    await db.query(
      'UPDATE referrers SET total_transferred_idr = total_transferred_idr + $1 WHERE id = $2',
      [e.rows[0].commission_idr, e.rows[0].referrer_id]);

    res.json({ ok: true, earning: e.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// -- BILLING (pindah dari payment.js) -------------------------
const PRICING = { basic_single:40000, basic_bundle_3:100000, premium_single:65000, premium_bundle_3:165000, upgrade_diff:25000 };

async function calcCommission(referrerCode, amountIdr) {
  if (!referrerCode) return { referrerId: null, commission: 0 };
  const r = await db.query(
    "SELECT id, commission_rate FROM referrers WHERE referral_code = $1 AND status = 'approved'",
    [referrerCode]);
  if (r.rowCount === 0) return { referrerId: null, commission: 0 };
  return { referrerId: r.rows[0].id, commission: Math.round(amountIdr * parseFloat(r.rows[0].commission_rate) / 100) };
}

// POST /api/admin/billing/activate
router.post('/billing/activate', async (req, res) => {
  const { student_id, product_type, level_from, level_to,
          amount_idr, payment_method, proof_note, referrer_code } = req.body || {};
  if (!student_id || !product_type || !level_from || !level_to || !amount_idr) {
    return res.status(400).json({ error: 'field wajib kurang' });
  }
  try {
    const { referrerId, commission } = await calcCommission(referrer_code, amount_idr);
    const isPremium = product_type.startsWith('premium');
    const col = isPremium ? 'paid_premium_up_to_level' : 'paid_basic_up_to_level';
    await db.query(
      `UPDATE students SET ${col} = GREATEST(COALESCE(${col}, 0), $1) WHERE id = $2`,
      [level_to, student_id]);

    const pr = await db.query(`
      INSERT INTO payment_records
        (student_id,product_type,level_from,level_to,amount_idr,
         payment_method,proof_url,referrer_code,commission_amount_idr,
         is_confirmed,confirmed_by_admin_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,NOW())
      RETURNING id
    `, [student_id, product_type, level_from, level_to, amount_idr,
        payment_method || 'manual_transfer', proof_note || null,
        referrer_code || null, commission]);

    if (referrerId && commission > 0) {
      await db.query(`
        INSERT INTO referrer_earnings
          (referrer_id, payment_record_id, student_id, amount_idr, commission_rate, commission_idr)
        VALUES ($1,$2,$3,$4,(SELECT commission_rate FROM referrers WHERE id=$1),$5)
      `, [referrerId, pr.rows[0].id, student_id, amount_idr, commission]);
      await db.query(
        `UPDATE referrers SET
           total_conversions  = total_conversions + 1,
           total_earnings_idr = total_earnings_idr + $1
         WHERE id = $2`,
        [commission, referrerId]);
    }

    const st = await db.query(
      'SELECT display_name,current_level,paid_basic_up_to_level,paid_premium_up_to_level FROM students WHERE id = $1',
      [student_id]);
    res.json({ ok: true, student_id, student: st.rows[0],
      activated: { product_type, level_from, level_to, is_premium: isPremium },
      commission_idr: commission });
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

// GET /api/admin/billing/status/:student_id
router.get('/billing/status/:student_id', async (req, res) => {
  try {
    const s = await db.query(
      'SELECT id,display_name,current_level,trial_level,paid_basic_up_to_level,paid_premium_up_to_level FROM students WHERE id = $1',
      [req.params.student_id]);
    if (s.rowCount === 0) return res.status(404).json({ error: 'siswa tidak ditemukan' });
    const p = await db.query(
      'SELECT * FROM payment_records WHERE student_id = $1 ORDER BY created_at DESC',
      [req.params.student_id]);
    res.json({ student: s.rows[0], payment_history: p.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

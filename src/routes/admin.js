/**
 * routes/admin.js - Sprint D.4 + Sprint I (Referral Sekolah/Marketing)
 *
 * GET  /api/admin/students              - list siswa + status bayar
 * GET  /api/admin/students/:id          - detail siswa + payment history
 * GET  /api/admin/referrers             - list semua referrer
 * POST /api/admin/referrers             - buat referrer baru (dengan type)
 * PUT  /api/admin/referrers/:id         - update referrer
 * GET  /api/admin/payments              - list semua payment
 * GET  /api/admin/earnings              - list earnings (untuk transfer)
 * GET  /api/admin/earnings/payout-queue - antrean fee 'ready' per referrer (A4)
 * POST /api/admin/earnings/payout       - cairkan borongan: 'ready' -> 'transferred' (A4)
 * PUT  /api/admin/earnings/:id          - mark earning as transferred
 * POST /api/admin/billing/activate      - manual activate billing
 * GET  /api/admin/billing/status/:id    - status billing siswa
 * GET  /api/admin/referral-settings     - baca setting global referral
 * PUT  /api/admin/referral-settings     - update setting global referral
 * GET  /api/admin/school-marketing-links       - list link sekolah-marketing
 * POST /api/admin/school-marketing-links       - buat link sekolah-marketing
 * PUT  /api/admin/school-marketing-links/:id   - update link (aktif/nonaktif)
 * DELETE /api/admin/school-marketing-links/:id - hapus link
 */
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');
const SECRET_KEY = process.env.JWT_SECRET || 'cadas_app_secure_secret_key_2026';
const { readyPayoutQueue, summarizeQueue } = require('../utils/payout');


// Helper: Bearer token dengan role 'admin' (login app/PIN, TTL 24 jam — A6)
function isAdminBearer(req) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return false;
  try {
    return jwt.verify(token, SECRET_KEY).role === 'admin';
  } catch (_) { return false; }
}

// Middleware: izinkan admin (x-admin-secret) ATAU referrer marketing (Bearer token)
function allowAdminOrMarketing(req, res, next) {
  // Admin via header secret ATAU Bearer role admin
  if (req.headers['x-admin-secret'] === process.env.ADMIN_SECRET || isAdminBearer(req)) {
    req.demoCallerKind = 'admin';
    return next();
  }
  // Referrer marketing via JWT Bearer
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, SECRET_KEY);
      if (payload.role === 'referrer') {
        // Cek type marketing dari DB dilakukan di handler (agar tidak async di middleware)
        req.auth = payload;
        req.demoCallerKind = 'referrer';
        return next();
      }
    } catch (_) { /* invalid token */ }
  }
  return res.status(401).json({ error: 'Akses ditolak: butuh admin secret atau token marketing' });
}

const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const feeMatrix = require('../utils/fee-matrix');
const partnerInvites = require('../services/partnerInviteService');
const marketingTestAccounts = require('../services/marketingTestAccountService');
const jwt     = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'cadas_app_secure_secret_key_2026';

// Middleware admin: x-admin-secret header (script/curl) ATAU Bearer role admin (app)
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET && !isAdminBearer(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
// DEMO-PASSCODES dikecualikan: pakai allowAdminOrMarketing (admin ATAU marketing).
// Tanpa ini, router.use(requireAdmin) memblokir token marketing sebelum
// sampai ke handler demo (bug: DemoHomeScreen generate passcode selalu 401).
router.use((req, res, next) => {
  if (req.path.startsWith('/demo-passcodes')) return next();
  return requireAdmin(req, res, next);
});

// Helper: baca referral_settings dari DB
async function getSettings() {
  return feeMatrix.getSettings();
}

// Helper: hitung split fee (sekolah + marketing)
async function calcSplitFee(referrerCode, amountIdr, settings) {
  return feeMatrix.calcSplitFee(referrerCode, amountIdr, settings);
}

// Helper: simpan earnings ke DB
async function saveEarnings(earnings, paymentRecordId, studentId, amountIdr) {
  return feeMatrix.saveEarnings(earnings, { paymentRecordId, studentId, amountIdr });
}
router.get('/marketing/overview', async (req, res) => {
  try {
    const settings = await feeMatrix.getSettings();
    const partners = await db.query(`SELECT type, COUNT(*)::int AS total,
      COALESCE(SUM(total_earnings_idr),0)::int AS total_earnings_idr
      FROM referrers WHERE status='approved' AND is_active=true GROUP BY type ORDER BY type`);
    const payments = await db.query(`SELECT
      COUNT(*) FILTER (WHERE is_confirmed=TRUE)::int AS confirmed_count,
      COALESCE(SUM(amount_idr) FILTER (WHERE is_confirmed=TRUE),0)::int AS confirmed_idr,
      COUNT(*) FILTER (WHERE is_confirmed=FALSE)::int AS pending_count FROM payment_records`);
    const earnings = await db.query(`SELECT
      COALESCE(SUM(commission_idr) FILTER (WHERE status<>'cancelled'),0)::int AS total_idr,
      COALESCE(SUM(commission_idr) FILTER (WHERE status='ready'),0)::int AS ready_idr,
      COALESCE(SUM(commission_idr) FILTER (WHERE status='transferred'),0)::int AS transferred_idr,
      COALESCE(SUM(commission_idr) FILTER (WHERE status='cancelled'),0)::int AS cancelled_idr,
      COALESCE(SUM(commission_idr) FILTER (WHERE earning_type='transaction'),0)::int AS normal_idr,
      COALESCE(SUM(commission_idr) FILTER (WHERE earning_type='quota_catchup'),0)::int AS catchup_idr
      FROM referrer_earnings`);
    const queue = await readyPayoutQueue();
    res.json({ settings, partners: partners.rows, payments: payments.rows[0] || {},
      earnings: earnings.rows[0] || {}, payout_queue: summarizeQueue(queue) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// Students
router.get('/students', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const search = req.query.search ? `%${req.query.search}%` : null;
    const where  = search ? 'WHERE s.username ILIKE $3 OR s.display_name ILIKE $3' : '';
    const params = search ? [limit, offset, search] : [limit, offset];

    const rows = await db.query(`
      SELECT s.id, s.username, s.display_name, s.grade_level,
             s.current_level, s.trial_level,
             s.paid_basic_up_to_level, s.paid_premium_up_to_level,
             s.created_at,
             r.referral_code AS referred_by_code,
             r.type          AS referred_by_type,
             r.full_name     AS referred_by_name
      FROM students s
      LEFT JOIN referrers r ON r.id = s.referred_by
      ${where}
      ORDER BY s.created_at DESC
      LIMIT $1 OFFSET $2
    `, params);

    const total = await db.query(
      `SELECT COUNT(*) FROM students s ${where}`,
      search ? [search] : []
    );
    res.json({ page, limit, total: parseInt(total.rows[0].count), students: rows.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/students/:id', async (req, res) => {
  try {
    const s = await db.query(
      `SELECT s.*, r.referral_code AS referred_by_code, r.type AS referred_by_type,
               r.full_name AS referred_by_name
         FROM students s LEFT JOIN referrers r ON r.id = s.referred_by
        WHERE s.id = $1`, [req.params.id]);
    if (s.rowCount === 0) return res.status(404).json({ error: 'siswa tidak ditemukan' });

    const payments = await db.query(
      'SELECT * FROM payment_records WHERE student_id = $1 ORDER BY created_at DESC',
      [req.params.id]);
    const invoices = await db.query(
      'SELECT * FROM midtrans_invoices WHERE student_id = $1 ORDER BY created_at DESC',
      [req.params.id]);
    const earnings = await db.query(
      `SELECT e.*, r.full_name AS referrer_name, r.type AS referrer_type
         FROM referrer_earnings e JOIN referrers r ON r.id = e.referrer_id
        WHERE e.student_id = $1 ORDER BY e.created_at DESC`,
      [req.params.id]);

    res.json({ student: s.rows[0], payment_records: payments.rows,
               midtrans_invoices: invoices.rows, referral_earnings: earnings.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin test accounts (M7). Optional owner_id targets a Head Marketing.
router.post('/test-accounts', async (req, res) => {
  try {
    const result = await marketingTestAccounts.createTestAccount({
      ownerId: req.body?.owner_referrer_id || null, createdByAdmin: true, label: req.body?.label || null,
    });
    return res.status(201).json(result);
  } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
});

router.get('/test-accounts', async (req, res) => {
  try { return res.json({ test_accounts: await marketingTestAccounts.listTestAccounts({ admin: true }) }); }
  catch (err) { return res.status(500).json({ error: err.message }); }
});

router.post('/test-accounts/:id/revoke', async (req, res) => {
  try {
    const row = await marketingTestAccounts.revokeTestAccount({ id: req.params.id, admin: true });
    return res.json({ ok: true, test_account: row });
  } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
});


// Secure partner invites. Raw token is returned only once; DB stores hash only.
router.post('/partner-invites', async (req, res) => {
  try {
    const result = await partnerInvites.createInvite({
      targetType: req.body?.target_type,
      inviterId: req.body?.inviter_referrer_id || null,
      createdByAdmin: true,
      expiresHours: req.body?.expires_hours,
    });
    return res.status(201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

router.get('/partner-invites', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT i.id, i.target_type, i.created_by_admin, i.expires_at,
              i.used_at, i.used_referrer_id, i.revoked_at, i.created_at,
              r.full_name AS inviter_name, r.referral_code AS inviter_code
       FROM partner_invites i
       LEFT JOIN referrers r ON r.id=i.inviter_referrer_id
       ORDER BY i.created_at DESC LIMIT 200`
    );
    return res.json({ invites: rows.rows });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.post('/partner-invites/:id/revoke', async (req, res) => {
  try {
    const rows = await db.query(
      `UPDATE partner_invites SET revoked_at=COALESCE(revoked_at,NOW())
       WHERE id=$1::uuid AND used_at IS NULL RETURNING id,revoked_at`,
      [req.params.id]
    );
    if (!rows.rowCount) return res.status(409).json({ error: 'Invite sudah dipakai atau tidak ditemukan.' });
    return res.json({ ok: true, invite: rows.rows[0] });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.get('/referrers', async (req, res) => {
  try {
    const type = req.query.type; // filter by type optional
    const where = type ? "WHERE type = $1" : "";
    const params = type ? [type] : [];
    const rows = await db.query(`
      SELECT r.id, r.full_name, r.email, r.type, r.is_active,
             r.referral_code, r.referral_token, r.commission_rate, r.status,
             r.bank_name, r.bank_account_number, r.bank_account_name,
             r.total_clicks, r.total_conversions,
             r.total_earnings_idr, r.total_transferred_idr, r.created_at,
             (SELECT COUNT(*) FROM school_marketing_links
              WHERE marketing_id = r.id AND is_active = true) AS linked_schools_count,
             (SELECT COUNT(*) FROM school_marketing_links
              WHERE school_id = r.id AND is_active = true) AS linked_marketing_count
      FROM referrers r ${where}
      ORDER BY r.type, r.created_at DESC
    `, params);
    res.json({ referrers: rows.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/referrers', async (req, res) => {
  const { full_name, email, password, referral_code, type,
          commission_rate, bank_name, bank_account_number, bank_account_name,
          parent_referrer_id } = req.body || {};
  if (!full_name || !email || !password || !referral_code || !type) {
    return res.status(400).json({ error: 'full_name, email, password, referral_code, type wajib' });
  }
  // A2: tipe 'sales' = referrer di bawah head marketing (marketing.md bagian 1-2)
  if (!['school','marketing','parent','student','sales'].includes(type)) {
    return res.status(400).json({ error: 'type harus: school | marketing | parent | student | sales' });
  }
  try {
    const settings     = await getSettings();
    const defaultRates = { school: settings.school_rate, marketing: settings.head_marketing_rate || settings.marketing_rate,
                           parent: settings.parent_rate,  student: settings.student_rate,
                           sales:  settings.sales_rate };
    const rate         = commission_rate || defaultRates[type] || 10;

    // sales WAJIB punya induk head marketing yang valid & aktif
    let parentUuid = null;
    if (type === 'sales') {
      if (!parent_referrer_id) {
        return res.status(400).json({ error: 'type sales wajib menyertakan parent_referrer_id (id head marketing)' });
      }
      const p = await db.query(
        "SELECT id FROM referrers WHERE id = $1 AND type = 'marketing' AND is_active = true AND status = 'approved'",
        [parent_referrer_id]);
      if (p.rowCount === 0) {
        return res.status(400).json({ error: 'parent_referrer_id bukan head marketing yang aktif/approved' });
      }
      parentUuid = p.rows[0].id;
    }

    const password_hash  = await bcrypt.hash(password, 10);
    const referral_token = uuidv4().replace(/-/g, '').slice(0, 16);

    const r = await db.query(`
      INSERT INTO referrers
        (full_name, email, password_hash, referral_code, referral_token,
         type, commission_rate, bank_name, bank_account_number, bank_account_name,
         parent_referrer_id, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'approved')
      RETURNING id, full_name, email, type, referral_code, referral_token,
                commission_rate, parent_referrer_id, status
    `, [full_name, email, password_hash, referral_code, referral_token,
        type, rate, bank_name, bank_account_number, bank_account_name, parentUuid]);

    res.status(201).json({ ok: true, referrer: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'email atau referral_code sudah dipakai' });
    if (err.code === '22P02') return res.status(400).json({ error: 'parent_referrer_id harus UUID valid' });
    if (err.code === '23503') return res.status(400).json({ error: 'parent_referrer_id tidak ditemukan' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/referrers/:id', async (req, res) => {
  const { status, commission_rate, bank_name, bank_account_number,
          bank_account_name, full_name, type, is_active } = req.body || {};
  try {
    const r = await db.query(`
      UPDATE referrers SET
        status              = COALESCE($1, status),
        commission_rate     = COALESCE($2, commission_rate),
        bank_name           = COALESCE($3, bank_name),
        bank_account_number = COALESCE($4, bank_account_number),
        bank_account_name   = COALESCE($5, bank_account_name),
        full_name           = COALESCE($6, full_name),
        type                = COALESCE($7, type),
        is_active           = COALESCE($8, is_active),
        updated_at          = NOW()
      WHERE id = $9
      RETURNING id, full_name, email, type, is_active, referral_code,
                status, commission_rate
    `, [status, commission_rate, bank_name, bank_account_number,
        bank_account_name, full_name, type, is_active, req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'referrer tidak ditemukan' });
    res.json({ ok: true, referrer: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Referral settings
router.get('/referral-settings', async (req, res) => {
  try {
    const rows = await db.query('SELECT key, value, description, updated_at FROM referral_settings ORDER BY key');
    res.json({ settings: rows.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/referral-settings', async (req, res) => {
  // Body: { key: value, key2: value2, ... }
  const updates = req.body || {};
  // A5: whitelist key matriks owner (migrasi 021) + key lama agar tetap bisa diubah
  const allowed = ['school_rate','marketing_rate','parent_rate','student_rate',
                   'school_enabled','marketing_enabled','parent_enabled',
                   'student_enabled','split_fee_enabled',
                   'head_marketing_rate','teacher_rate_full','teacher_quota_full',
                   'teacher_rate_half','teacher_quota_half',
                   'sales_rate','sales_quota',
                   'demo_no_persist_enabled'];
  try {
    const results = [];
    for (const [key, value] of Object.entries(updates)) {
      if (!allowed.includes(key)) continue;
      const r = await db.query(
        `UPDATE referral_settings SET value = $1, updated_at = NOW()
           WHERE key = $2 RETURNING key, value`,
        [String(value), key]
      );
      if (r.rowCount > 0) results.push(r.rows[0]);
    }
    res.json({ ok: true, updated: results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// School marketing links
router.get('/school-marketing-links', async (req, res) => {
  try {
    const rows = await db.query(`
      SELECT sml.id, sml.is_active, sml.created_at,
             s.id AS school_id, s.full_name AS school_name,
             s.referral_code AS school_code,
             m.id AS marketing_id, m.full_name AS marketing_name,
             m.referral_code AS marketing_code,
             m.commission_rate AS marketing_rate,
             s.commission_rate AS school_rate
      FROM school_marketing_links sml
      JOIN referrers s ON s.id = sml.school_id
      JOIN referrers m ON m.id = sml.marketing_id
      ORDER BY sml.created_at DESC
    `);
    res.json({ links: rows.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/school-marketing-links', async (req, res) => {
  const { school_id, marketing_id } = req.body || {};
  if (!school_id || !marketing_id) {
    return res.status(400).json({ error: 'school_id dan marketing_id wajib' });
  }
  try {
    // Validasi type
    const refs = await db.query(
      'SELECT id, type, full_name FROM referrers WHERE id = ANY($1)',
      [[school_id, marketing_id]]
    );
    const school    = refs.rows.find(r => r.id === school_id);
    const marketing = refs.rows.find(r => r.id === marketing_id);
    if (!school || school.type !== 'school') {
      return res.status(400).json({ error: 'school_id harus referrer dengan type=school' });
    }
    if (!marketing || marketing.type !== 'marketing') {
      return res.status(400).json({ error: 'marketing_id harus referrer dengan type=marketing' });
    }

    const r = await db.query(`
      INSERT INTO school_marketing_links (school_id, marketing_id)
      VALUES ($1, $2)
      ON CONFLICT (school_id, marketing_id) DO UPDATE SET is_active = true
      RETURNING id, school_id, marketing_id, is_active, created_at
    `, [school_id, marketing_id]);

    res.status(201).json({ ok: true, link: r.rows[0],
      school_name: school.full_name, marketing_name: marketing.full_name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/school-marketing-links/:id', async (req, res) => {
  const { is_active } = req.body || {};
  try {
    const r = await db.query(
      'UPDATE school_marketing_links SET is_active = $1 WHERE id = $2 RETURNING *',
      [is_active, req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'link tidak ditemukan' });
    res.json({ ok: true, link: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/school-marketing-links/:id', async (req, res) => {
  try {
    const r = await db.query(
      'DELETE FROM school_marketing_links WHERE id = $1 RETURNING id', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'link tidak ditemukan' });
    res.json({ ok: true, deleted_id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Payments
router.get('/payments', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;

    const manual = await db.query(`
      SELECT 'manual' AS source, p.id, p.student_id, s.display_name,
             p.product_type, p.level_from, p.level_to, p.amount_idr,
             p.payment_method, p.referrer_code, p.is_confirmed,
             p.confirmed_by_admin_at AS paid_at, p.created_at,
             r.full_name AS referrer_name, r.type AS referrer_type
      FROM payment_records p
      JOIN students s ON s.id = p.student_id
      LEFT JOIN referrers r ON r.referral_code = p.referrer_code
      ORDER BY p.created_at DESC LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const midtrans = await db.query(`
      SELECT 'midtrans' AS source, x.id, x.student_id, s.display_name,
             x.product_type, x.level_from, x.level_to, x.amount_idr,
             'midtrans' AS payment_method, x.referrer_code,
             (x.status = 'paid') AS is_confirmed, x.paid_at, x.created_at,
             r.full_name AS referrer_name, r.type AS referrer_type
      FROM midtrans_invoices x
      JOIN students s ON s.id = x.student_id
      LEFT JOIN referrers r ON r.referral_code = x.referrer_code
      ORDER BY x.created_at DESC LIMIT $1 OFFSET $2
    `, [limit, offset]);

    res.json({ manual: manual.rows, midtrans: midtrans.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Earnings
router.get('/earnings', async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const type   = req.query.type;  // filter by referrer type optional
    const where2 = type ? 'AND r.type = $2' : '';
    const params = type ? [status, type] : [status];

    const rows = await db.query(`
      SELECT e.*, r.full_name AS referrer_name, r.email AS referrer_email,
             r.type AS referrer_type,
             r.bank_name, r.bank_account_number, r.bank_account_name,
             s.display_name AS student_name
      FROM referrer_earnings e
      JOIN referrers r ON r.id = e.referrer_id
      LEFT JOIN students s ON s.id = e.student_id
      WHERE e.status = $1 ${where2}
      ORDER BY e.created_at DESC
    `, params);
    res.json({ earnings: rows.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/earnings/:id', async (req, res) => {
  try {
    const e = await db.query(`
      UPDATE referrer_earnings
      SET status = 'transferred', transferred_at = NOW()
      WHERE id = $1 AND status IN ('pending','ready')
      RETURNING *
    `, [req.params.id]);
    if (e.rowCount === 0) return res.status(404).json({ error: 'earning tidak ditemukan atau statusnya bukan pending/ready' });
    await db.query(
      'UPDATE referrers SET total_transferred_idr = total_transferred_idr + $1 WHERE id = $2',
      [e.rows[0].commission_idr, e.rows[0].referrer_id]);
    res.json({ ok: true, earning: e.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// A4: PAYOUT BORONGAN — semua earning 'ready' milik satu referrer (atau semua
// referrer) dicairkan dalam satu perintah. Kuota tier sudah diverifikasi saat
// invoice lunas (midtrans.js referralTierRate), jadi baris 'ready' di sini pasti
// sudah lolos kuota. Status DB langsung 'transferred'; transfer bank nyata tetap
// dilakukan owner karena repo ini tidak punya API disbursement.
router.get('/earnings/payout-queue', async (req, res) => {
  try {
    const queue = await readyPayoutQueue();
    res.json({ queue, summary: summarizeQueue(queue) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/earnings/payout', async (req, res) => {
  const referrerId = (req.body || {}).referrer_id || null;
  try {
    const rows = await db.query(
      `UPDATE referrer_earnings
          SET status = 'transferred', transferred_at = NOW()
        WHERE status = 'ready' ${referrerId ? 'AND referrer_id = $1' : ''}
        RETURNING id, referrer_id, commission_idr`,
      referrerId ? [referrerId] : []
    );
    if (rows.rowCount === 0) {
      return res.status(404).json({ error: 'Tidak ada earning berstatus ready untuk dicairkan' });
    }

    // Akumulasi per referrer → naikkan total_transferred_idr sekali per referrer
    const perRef = new Map();
    for (const r of rows.rows) {
      perRef.set(r.referrer_id, (perRef.get(r.referrer_id) || 0) + r.commission_idr);
    }
    for (const [id, total] of perRef) {
      await db.query(
        'UPDATE referrers SET total_transferred_idr = total_transferred_idr + $1 WHERE id = $2',
        [total, id]);
    }

    const banks = await db.query(
      `SELECT id, full_name, type AS referrer_type, bank_name,
              bank_account_number, bank_account_name
         FROM referrers WHERE id = ANY($1::uuid[])`,
      [Array.from(perRef.keys())]
    );
    const batches = banks.rows.map((b) => ({
      ...b,
      transferred_idr: perRef.get(b.id) || 0,
      bank_complete: !!(b.bank_name && b.bank_account_number),
    }));
    res.json({
      ok: true,
      earnings_count: rows.rowCount,
      referrers_count: batches.length,
      total_idr: batches.reduce((a, b) => a + b.transferred_idr, 0),
      batches,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Billing
router.post('/billing/activate', async (req, res) => {
  const { student_id, product_type, level_from, level_to,
          amount_idr, payment_method, proof_note, referrer_code } = req.body || {};
  if (!student_id || !product_type || !level_from || !level_to || !amount_idr) {
    return res.status(400).json({ error: 'field wajib kurang' });
  }
  try {
    const settings = await getSettings();
    const earnings = await calcSplitFee(referrer_code, amount_idr, settings);

    const isPremium = product_type.startsWith('premium');
    const col = isPremium ? 'paid_premium_up_to_level' : 'paid_basic_up_to_level';
    await db.query(
      `UPDATE students SET ${col} = GREATEST(COALESCE(${col}, 0), $1) WHERE id = $2`,
      [level_to, student_id]);

    const pr = await db.query(`
      INSERT INTO payment_records
        (student_id, product_type, level_from, level_to, amount_idr,
         payment_method, proof_url, referrer_code,
         commission_amount_idr, is_confirmed, confirmed_by_admin_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,NOW())
      RETURNING id
    `, [student_id, product_type, level_from, level_to, amount_idr,
        payment_method || 'manual_transfer', proof_note || null,
        referrer_code || null,
        earnings.reduce((s, e) => s + e.amount, 0)]);

    await saveEarnings(earnings, pr.rows[0].id, student_id, amount_idr);

    const st = await db.query(
      'SELECT display_name, current_level, paid_basic_up_to_level, paid_premium_up_to_level FROM students WHERE id = $1',
      [student_id]);

    res.json({
      ok: true, student_id, student: st.rows[0],
      activated: { product_type, level_from, level_to, is_premium: isPremium },
      earnings_created: earnings.map(e => ({
        type: e.type, commission_rate: e.rate, commission_idr: e.amount
      })),
    });
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

router.get('/billing/status/:student_id', async (req, res) => {
  try {
    const s = await db.query(
      'SELECT id, display_name, current_level, trial_level, paid_basic_up_to_level, paid_premium_up_to_level FROM students WHERE id = $1',
      [req.params.student_id]);
    if (s.rowCount === 0) return res.status(404).json({ error: 'siswa tidak ditemukan' });
    const p = await db.query(
      'SELECT * FROM payment_records WHERE student_id = $1 ORDER BY created_at DESC',
      [req.params.student_id]);
    res.json({ student: s.rows[0], payment_history: p.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// TAMBAHAN ENDPOINTS — admin_rag_miss (Sprint K, 13 Sep 2026)
// Tambahkan blok ini di admin.js SEBELUM baris `module.exports = router;`
// ═══════════════════════════════════════════════════════════════════

// ── RAG MISS — List ────────────────────────────────────────────────────────────
// GET /api/admin/rag-miss
// Query params:
//   ?resolved=false   (default) | true | all
//   ?level=8          filter by level
//   ?page=1&limit=50
router.get('/rag-miss', async (req, res) => {
  try {
    const page     = Math.max(1, parseInt(req.query.page)  || 1);
    const limit    = Math.min(100, parseInt(req.query.limit) || 50);
    const offset   = (page - 1) * limit;
    const resolved = req.query.resolved;   // 'true' | 'false' | 'all' | undefined
    const level    = req.query.level ? parseInt(req.query.level) : null;

    const conditions = [];
    const params     = [];

    if (resolved !== 'all') {
      const resolvedBool = resolved === 'true';
      params.push(resolvedBool);
      conditions.push(`m.resolved = $${params.length}`);
    }
    if (level) {
      params.push(level);
      conditions.push(`m.level_id = $${params.length}`);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // Total count
    const countRes = await db.query(
      `SELECT COUNT(*) FROM admin_rag_miss m ${where}`, params
    );
    const total = parseInt(countRes.rows[0].count);

    // Rows
    params.push(limit, offset);
    const rows = await db.query(
      `SELECT
         m.id,
         m.level_id,
         m.question_text,
         m.top_sim_score,
         m.top_chunk_text,
         m.llm_answered,
         m.llm_model,
         m.resolved,
         m.resolved_at,
         m.resolved_note,
         m.created_at,
         s.display_name AS student_name,
         s.username     AS student_username
       FROM admin_rag_miss m
       LEFT JOIN students s ON s.id = m.student_id
       ${where}
       ORDER BY m.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // Summary per level (untuk dashboard chart)
    const summary = await db.query(
      `SELECT level_id,
              COUNT(*) AS total,
              SUM(CASE WHEN resolved = false THEN 1 ELSE 0 END) AS unresolved,
              SUM(CASE WHEN llm_answered = true THEN 1 ELSE 0 END) AS llm_answered
       FROM admin_rag_miss
       GROUP BY level_id
       ORDER BY level_id`
    );

    res.json({
      page, limit, total,
      items:   rows.rows,
      summary: summary.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── RAG MISS — Mark resolved ───────────────────────────────────────────────────
// PUT /api/admin/rag-miss/:id/resolve
// Body: { resolved_note: "Materi sudah ditambah di level 8" }
router.put('/rag-miss/:id/resolve', async (req, res) => {
  const { resolved_note } = req.body || {};
  try {
    const r = await db.query(
      `UPDATE admin_rag_miss
       SET resolved = true, resolved_at = NOW(), resolved_note = $1
       WHERE id = $2 AND resolved = false
       RETURNING *`,
      [resolved_note || null, req.params.id]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'item tidak ditemukan atau sudah resolved' });
    }
    res.json({ ok: true, item: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── RAG MISS — Bulk resolve by level ──────────────────────────────────────────
// PUT /api/admin/rag-miss/resolve-level
// Body: { level_id: 8, resolved_note: "Materi level 8 sudah diupdate" }
router.put('/rag-miss/resolve-level', async (req, res) => {
  const { level_id, resolved_note } = req.body || {};
  if (!level_id) return res.status(400).json({ error: 'level_id wajib' });
  try {
    const r = await db.query(
      `UPDATE admin_rag_miss
       SET resolved = true, resolved_at = NOW(), resolved_note = $1
       WHERE level_id = $2 AND resolved = false
       RETURNING id`,
      [resolved_note || null, level_id]
    );
    res.json({ ok: true, resolved_count: r.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── RAG MISS — Delete (hapus false positive / noise) ─────────────────────────
// DELETE /api/admin/rag-miss/:id
router.delete('/rag-miss/:id', async (req, res) => {
  try {
    const r = await db.query(
      'DELETE FROM admin_rag_miss WHERE id = $1 RETURNING id', [req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'item tidak ditemukan' });
    res.json({ ok: true, deleted_id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── RAG MISS — Stats ringkasan untuk dashboard ────────────────────────────────
// GET /api/admin/rag-miss/stats
router.get('/rag-miss/stats', async (req, res) => {
  try {
    const overall = await db.query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN resolved = false THEN 1 ELSE 0 END) AS unresolved,
         SUM(CASE WHEN resolved = true  THEN 1 ELSE 0 END) AS resolved,
         SUM(CASE WHEN llm_answered = true THEN 1 ELSE 0 END) AS llm_answered,
         SUM(CASE WHEN llm_answered = false AND resolved = false THEN 1 ELSE 0 END) AS unanswered,
         ROUND(AVG(top_sim_score)::numeric, 4) AS avg_sim_score
       FROM admin_rag_miss`
    );

    // Top 10 pertanyaan yang paling sering muncul (potensi materi baru)
    const topQuestions = await db.query(
      `SELECT question_text, level_id, COUNT(*) AS frequency,
              MAX(top_sim_score) AS best_sim,
              BOOL_OR(llm_answered) AS ever_llm_answered
       FROM admin_rag_miss
       WHERE resolved = false
       GROUP BY question_text, level_id
       ORDER BY frequency DESC
       LIMIT 10`
    );

    // Tren 7 hari terakhir
    const trend = await db.query(
      `SELECT DATE(created_at) AS date, COUNT(*) AS miss_count
       FROM admin_rag_miss
       WHERE created_at >= NOW() - INTERVAL '7 days'
       GROUP BY DATE(created_at)
       ORDER BY date ASC`
    );

    res.json({
      overall:      overall.rows[0],
      top_questions: topQuestions.rows,
      trend_7d:     trend.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// TAMBAHKAN BLOK INI di admin.js, tepat sebelum baris: module.exports = router;
// ── DEMO PASSCODES ────────────────────────────────────────────────────────
// GET  /api/admin/demo-passcodes          — list semua passcode
// POST /api/admin/demo-passcodes          — buat passcode baru
// DELETE /api/admin/demo-passcodes/:id   — revoke passcode

function randomCode() {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4 digit, tidak mulai 0
}

router.get('/demo-passcodes', allowAdminOrMarketing, async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT id, code, label, expires_at, redeemed_at, no_persist, is_active, created_at
       FROM demo_passcodes ORDER BY created_at DESC`
    );
    res.json({ passcodes: rows.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/demo-passcodes', allowAdminOrMarketing, async (req, res) => {
  // Body opsional: { label: "Demo SMP Banjarbaru", hours: 0.5, no_persist: true }
  // A3: no_persist=true → sesi latihan pemegang passcode ini TIDAK disimpan DB.
  const { label, hours, no_persist } = req.body || {};
  // Jika caller adalah referrer, pastikan type = marketing
  if (req.demoCallerKind === 'referrer') {
    try {
      const ref = await db.query("SELECT type FROM referrers WHERE id = $1", [req.auth.sub]);
      if (ref.rowCount === 0 || ref.rows[0].type !== 'marketing') {
        return res.status(403).json({ error: 'Hanya referrer tipe marketing yang bisa buat passcode' });
      }
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  // Minimal 0.5 jam (30 menit) — passcode demo = full premium, jangan lama-lama (biaya LLM)
  const ttlHours = Math.min(72, Math.max(0.5, parseFloat(hours) || 0.5));
  try {
    let code, inserted = false;
    // Coba sampai dapat kode unik (max 10x)
    for (let i = 0; i < 10; i++) {
      code = randomCode();
      try {
        const r = await db.query(
          `INSERT INTO demo_passcodes (code, label, expires_at, no_persist)
           VALUES ($1, $2, NOW() + INTERVAL '1 hour' * $3, $4)
           RETURNING id, code, label, expires_at, no_persist, created_at`,
          [code, label || null, ttlHours, no_persist === true]
        );
        res.status(201).json({ ok: true, passcode: r.rows[0] });
        inserted = true;
        break;
      } catch (e) {
        if (e.code !== '23505') throw e; // bukan duplicate, lempar
        // duplicate code → coba lagi
      }
    }
    if (!inserted) res.status(500).json({ error: 'Gagal generate kode unik' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/demo-passcodes/:id', allowAdminOrMarketing, async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE demo_passcodes SET is_active = false WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'passcode tidak ditemukan' });
    res.json({ ok: true, revoked_id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

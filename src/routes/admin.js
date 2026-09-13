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
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
router.use(requireAdmin);

// ?? Helper: baca referral_settings dari DB ???????????????????????????????????
async function getSettings() {
  const rows = await db.query('SELECT key, value FROM referral_settings');
  return Object.fromEntries(rows.rows.map(r => [r.key, r.value]));
}

// ?? Helper: hitung split fee (sekolah + marketing) ???????????????????????????
// Alur: siswa punya referred_by (school_id atau marketing_id)
// Jika siswa dari sekolah ? cek apakah sekolah punya linked marketing
// Earnings: sekolah 30% + marketing 10% (jika split aktif)
// Jika siswa dari marketing langsung (tanpa sekolah) ? marketing 10% saja
async function calcSplitFee(referrerCode, amountIdr, settings) {
  if (!referrerCode) return [];

  const ref = await db.query(
    "SELECT id, type, commission_rate, is_active FROM referrers WHERE referral_code = $1 AND status = 'approved'",
    [referrerCode]
  );
  if (ref.rowCount === 0 || !ref.rows[0].is_active) return [];

  const referrer   = ref.rows[0];
  const splitActive = settings.split_fee_enabled === 'true';
  const results    = [];
  const splitGroupId = uuidv4();

  if (referrer.type === 'school') {
    // Cek apakah school_enabled
    if (settings.school_enabled !== 'true') return [];
    const rate   = parseFloat(referrer.commission_rate) || parseFloat(settings.school_rate) || 30;
    const amount = Math.round(amountIdr * rate / 100);
    results.push({ referrerId: referrer.id, type: 'school', rate, amount, splitGroupId });

    // Cek apakah ada marketing yang linked ke sekolah ini (split fee)
    if (splitActive && settings.marketing_enabled === 'true') {
      const link = await db.query(
        `SELECT sml.marketing_id, r.commission_rate, r.is_active
           FROM school_marketing_links sml
           JOIN referrers r ON r.id = sml.marketing_id
          WHERE sml.school_id = $1 AND sml.is_active = true AND r.is_active = true
          LIMIT 1`,
        [referrer.id]
      );
      if (link.rowCount > 0) {
        const mRate   = parseFloat(link.rows[0].commission_rate) || parseFloat(settings.marketing_rate) || 10;
        const mAmount = Math.round(amountIdr * mRate / 100);
        results.push({ referrerId: link.rows[0].marketing_id, type: 'marketing', rate: mRate, amount: mAmount, splitGroupId });
      }
    }
  } else if (referrer.type === 'marketing') {
    if (settings.marketing_enabled !== 'true') return [];
    const rate   = parseFloat(referrer.commission_rate) || parseFloat(settings.marketing_rate) || 10;
    const amount = Math.round(amountIdr * rate / 100);
    results.push({ referrerId: referrer.id, type: 'marketing', rate, amount, splitGroupId });
  } else if (referrer.type === 'parent') {
    if (settings.parent_enabled !== 'true') return [];
    const rate   = parseFloat(referrer.commission_rate) || parseFloat(settings.parent_rate) || 5;
    const amount = Math.round(amountIdr * rate / 100);
    results.push({ referrerId: referrer.id, type: 'parent', rate, amount, splitGroupId });
  } else if (referrer.type === 'student') {
    if (settings.student_enabled !== 'true') return [];
    const rate   = parseFloat(referrer.commission_rate) || parseFloat(settings.student_rate) || 5;
    const amount = Math.round(amountIdr * rate / 100);
    results.push({ referrerId: referrer.id, type: 'student', rate, amount, splitGroupId });
  }

  return results;
}

// ?? Helper: simpan earnings ke DB ????????????????????????????????????????????
async function saveEarnings(earnings, paymentRecordId, studentId, amountIdr) {
  for (const e of earnings) {
    await db.query(
      `INSERT INTO referrer_earnings
         (referrer_id, payment_record_id, student_id, amount_idr,
          commission_rate, commission_idr, split_group_id, referrer_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [e.referrerId, paymentRecordId, studentId, amountIdr,
       e.rate, e.amount, e.splitGroupId, e.type]
    );
    await db.query(
      `UPDATE referrers SET
         total_conversions  = total_conversions + 1,
         total_earnings_idr = total_earnings_idr + $1
       WHERE id = $2`,
      [e.amount, e.referrerId]
    );
  }
}

// ?? STUDENTS ??????????????????????????????????????????????????????????????????
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

// ?? REFERRERS ?????????????????????????????????????????????????????????????????
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
          commission_rate, bank_name, bank_account_number, bank_account_name } = req.body || {};
  if (!full_name || !email || !password || !referral_code || !type) {
    return res.status(400).json({ error: 'full_name, email, password, referral_code, type wajib' });
  }
  if (!['school','marketing','parent','student'].includes(type)) {
    return res.status(400).json({ error: 'type harus: school | marketing | parent | student' });
  }
  try {
    const settings     = await getSettings();
    const defaultRates = { school: settings.school_rate, marketing: settings.marketing_rate,
                           parent: settings.parent_rate,  student: settings.student_rate };
    const rate         = commission_rate || defaultRates[type] || 10;
    const password_hash  = await bcrypt.hash(password, 10);
    const referral_token = uuidv4().replace(/-/g, '').slice(0, 16);

    const r = await db.query(`
      INSERT INTO referrers
        (full_name, email, password_hash, referral_code, referral_token,
         type, commission_rate, bank_name, bank_account_number, bank_account_name, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'approved')
      RETURNING id, full_name, email, type, referral_code, referral_token,
                commission_rate, status
    `, [full_name, email, password_hash, referral_code, referral_token,
        type, rate, bank_name, bank_account_number, bank_account_name]);

    res.status(201).json({ ok: true, referrer: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'email atau referral_code sudah dipakai' });
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

// ?? REFERRAL SETTINGS ?????????????????????????????????????????????????????????
router.get('/referral-settings', async (req, res) => {
  try {
    const rows = await db.query('SELECT key, value, description, updated_at FROM referral_settings ORDER BY key');
    res.json({ settings: rows.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/referral-settings', async (req, res) => {
  // Body: { key: value, key2: value2, ... }
  const updates = req.body || {};
  const allowed = ['school_rate','marketing_rate','parent_rate','student_rate',
                   'school_enabled','marketing_enabled','parent_enabled',
                   'student_enabled','split_fee_enabled'];
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

// ?? SCHOOL-MARKETING LINKS ????????????????????????????????????????????????????
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

// ?? PAYMENTS ??????????????????????????????????????????????????????????????????
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

// ?? EARNINGS ??????????????????????????????????????????????????????????????????
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
      WHERE id = $1 AND status = 'pending'
      RETURNING *
    `, [req.params.id]);
    if (e.rowCount === 0) return res.status(404).json({ error: 'earning tidak ditemukan atau sudah ditransfer' });
    await db.query(
      'UPDATE referrers SET total_transferred_idr = total_transferred_idr + $1 WHERE id = $2',
      [e.rows[0].commission_idr, e.rows[0].referrer_id]);
    res.json({ ok: true, earning: e.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ?? BILLING ???????????????????????????????????????????????????????????????????
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

module.exports = router;

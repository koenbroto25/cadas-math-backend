/**
 * routes/referrer.js - Sprint D.3 + D.5
 * Referrer Auth + Dashboard Routes
 *
 * POST /api/referrer/login           - login referrer
 * GET  /api/referrer/me              - profil + stats
 * GET  /api/referrer/earnings        - history komisi
 * GET  /api/referrer/clicks          - history klik link
 * PUT  /api/referrer/bank            - update info bank
 * PUT  /api/referrer/password        - ganti password
 */
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');
const bcrypt  = require('bcryptjs');
const { signToken } = require('../middleware/auth');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const dashboard = require('../services/marketingDashboardService');
const partnerInvites = require('../services/partnerInviteService');
const marketingTestAccounts = require('../services/marketingTestAccountService');

const SECRET = process.env.JWT_SECRET || 'cadas_app_secure_secret_key_2026';

function verifyReferrerToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'token tidak ada' });
  try {
    const payload = jwt.verify(token, SECRET);
    if (payload.role !== 'referrer') return res.status(403).json({ error: 'bukan token referrer' });
    req.auth = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'token tidak valid / kedaluwarsa' });
  }
}

// POST /api/referrer/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email dan password wajib' });
  try {
    const r = await db.query(
      "SELECT * FROM referrers WHERE email = $1 AND status = 'approved'", [email]);
    if (r.rowCount === 0) return res.status(401).json({ error: 'email tidak ditemukan atau akun belum disetujui' });
    const ref = r.rows[0];
    if (!ref.password_hash) return res.status(401).json({ error: 'akun belum diatur passwordnya, hubungi admin' });

    const valid = await bcrypt.compare(password, ref.password_hash);
    if (!valid) return res.status(401).json({ error: 'password salah' });

    await db.query('UPDATE referrers SET last_login_at = NOW() WHERE id = $1', [ref.id]);
    // A6: head marketing sesi 24 jam (scope dashboard+demo); peran lain 30 hari.
    const ttl  = ref.type === 'marketing' ? '24h' : '30d';

    const token = jwt.sign(
      { sub: ref.id, role: 'referrer', referral_code: ref.referral_code, type: ref.type },
      SECRET, { expiresIn: ttl });

    res.json({
      ok: true, token,
      referrer: {
        id: ref.id, full_name: ref.full_name, email: ref.email,
        referral_code: ref.referral_code, referral_token: ref.referral_token,
        commission_rate: ref.commission_rate, status: ref.status
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/dashboard', verifyReferrerToken, async (req, res) => {
  try {
    const data = await dashboard.getPartnerDashboard(req.auth.sub);
    if (!data) return res.status(404).json({ error: 'referrer tidak ditemukan' });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/network', verifyReferrerToken, async (req, res) => {
  try {
    const data = await dashboard.getPartnerDashboard(req.auth.sub);
    if (!data) return res.status(404).json({ error: 'referrer tidak ditemukan' });
    if (data.tier.type !== 'marketing') return res.status(403).json({ error: 'endpoint khusus head marketing' });
    res.json(data.network);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// GET /api/referrer/me
router.get('/me', verifyReferrerToken, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT id, full_name, email, referral_code, referral_token,
             commission_rate, bank_name, bank_account_number, bank_account_name,
             total_clicks, total_conversions, total_earnings_idr,
             total_transferred_idr, last_login_at, created_at
      FROM referrers WHERE id = $1
    `, [req.auth.sub]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'referrer tidak ditemukan' });

    const pending = await db.query(
      "SELECT COALESCE(SUM(commission_idr),0) AS pending_idr FROM referrer_earnings WHERE referrer_id = $1 AND status IN ('pending','ready')",
      [req.auth.sub]);

    res.json({
      referrer: r.rows[0],
      pending_transfer_idr: parseInt(pending.rows[0].pending_idr),
      link_download: `${process.env.APP_BASE_URL || 'https://cadas.app'}/d/${r.rows[0].referral_token}`
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/referrer/earnings?page=1&limit=20
router.get('/earnings', verifyReferrerToken, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(50, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;

    const rows = await db.query(`
      SELECT e.id, e.amount_idr, e.commission_rate, e.commission_idr,
             e.status, e.earning_type, e.source_quota, e.window_id,
             e.transferred_at, e.created_at,
             s.display_name AS student_name
      FROM referrer_earnings e
      LEFT JOIN students s ON s.id = e.student_id
      WHERE e.referrer_id = $1
      ORDER BY e.created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.auth.sub, limit, offset]);

    const total = await db.query(
      'SELECT COUNT(*) FROM referrer_earnings WHERE referrer_id = $1', [req.auth.sub]);

    res.json({ page, limit, total: parseInt(total.rows[0].count), earnings: rows.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/referrer/clicks?page=1&limit=20
router.get('/clicks', verifyReferrerToken, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(50, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;

    const rows = await db.query(`
      SELECT id, ip_hash, user_agent, clicked_at
      FROM download_clicks
      WHERE referrer_id = $1
      ORDER BY clicked_at DESC
      LIMIT $2 OFFSET $3
    `, [req.auth.sub, limit, offset]);

    const total = await db.query(
      'SELECT COUNT(*) FROM download_clicks WHERE referrer_id = $1', [req.auth.sub]);

    res.json({ page, limit, total: parseInt(total.rows[0].count), clicks: rows.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/referrer/bank
router.put('/bank', verifyReferrerToken, async (req, res) => {
  const { bank_name, bank_account_number, bank_account_name } = req.body || {};
  if (!bank_name || !bank_account_number || !bank_account_name) {
    return res.status(400).json({ error: 'bank_name, bank_account_number, bank_account_name wajib' });
  }
  try {
    await db.query(
      'UPDATE referrers SET bank_name=$1, bank_account_number=$2, bank_account_name=$3, updated_at=NOW() WHERE id=$4',
      [bank_name, bank_account_number, bank_account_name, req.auth.sub]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/referrer/password
router.put('/password', verifyReferrerToken, async (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!old_password || !new_password) return res.status(400).json({ error: 'old_password dan new_password wajib' });
  if (new_password.length < 8) return res.status(400).json({ error: 'password minimal 8 karakter' });
  try {
    const r = await db.query('SELECT password_hash FROM referrers WHERE id = $1', [req.auth.sub]);
    const valid = await bcrypt.compare(old_password, r.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'password lama salah' });

    const new_hash = await bcrypt.hash(new_password, 10);
    await db.query('UPDATE referrers SET password_hash=$1, updated_at=NOW() WHERE id=$2',
      [new_hash, req.auth.sub]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// POST /api/referrer/register-via-invite
// Public endpoint: requires a one-time partner invite token, never referral_token.
router.post('/register-via-invite', async (req, res) => {
  const { invite_token, full_name, email, password } = req.body || {};
  if (!invite_token) return res.status(400).json({ error: 'invite_token wajib diisi.' });
  if (!full_name || String(full_name).trim().length < 2) return res.status(400).json({ error: 'Nama minimal 2 karakter.' });
  if (!email || !String(email).includes('@')) return res.status(400).json({ error: 'Email tidak valid.' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter.' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const invite = await partnerInvites.consumeInvite(client, String(invite_token).trim(), null);
    if (!['school', 'sales'].includes(invite.target_type)) {
      throw Object.assign(new Error('Target invite tidak valid.'), { status: 400 });
    }
    const emailNorm = String(email).trim().toLowerCase();
    const exists = await client.query('SELECT 1 FROM referrers WHERE email=$1', [emailNorm]);
    if (exists.rowCount) throw Object.assign(new Error('Email sudah terdaftar.'), { status: 409 });

    const type = invite.target_type;
    const rate = type === 'sales' ? 5 : 5;
    const referralCode = `${type === 'sales' ? 'SLS' : 'GUR'}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const shareToken = crypto.randomBytes(16).toString('hex');
    const passwordHash = await bcrypt.hash(String(password), 10);
    const inserted = await client.query(
      `INSERT INTO referrers
        (full_name,email,password_hash,referral_code,referral_token,type,commission_rate,
         parent_referrer_id,status,is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'approved',TRUE)
       RETURNING id,full_name,email,referral_code,referral_token,type,parent_referrer_id,status`,
      [String(full_name).trim(), emailNorm, passwordHash, referralCode, shareToken, type, rate,
       invite.inviter_referrer_id || null]
    );
    const account = inserted.rows[0];
    await partnerInvites.markUsedBy(client, String(invite_token).trim(), account.id);
    await client.query('COMMIT');
    return res.status(201).json({
      ok: true,
      message: `Akun ${type === 'school' ? 'guru' : 'referrer'} berhasil dibuat.`,
      referrer: account,
      token: signToken({ sub: account.id, role: 'referrer', type: account.type }, account.type === 'marketing' ? '24h' : '30d'),
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'Email atau kode referral sudah dipakai.' });
    console.error('[referrer/register-via-invite]', err);
    return res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// Head marketing membuat invite untuk school/sales di bawah dirinya.
router.post('/team-invites', verifyReferrerToken, async (req, res) => {
  try {
    if (req.auth.type !== 'marketing') return res.status(403).json({ error: 'Hanya head marketing yang dapat membuat invite.' });
    const result = await partnerInvites.createInvite({
      targetType: req.body?.target_type,
      inviterId: req.auth.sub,
      createdByAdmin: false,
      expiresHours: req.body?.expires_hours,
    });
    return res.status(201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

router.get('/team-invites', verifyReferrerToken, async (req, res) => {
  try {
    if (req.auth.type !== 'marketing') return res.status(403).json({ error: 'Hanya head marketing.' });
    const rows = await db.query(
      `SELECT id,target_type,created_by_admin,expires_at,used_at,used_referrer_id,revoked_at,created_at
       FROM partner_invites WHERE inviter_referrer_id=$1::uuid ORDER BY created_at DESC LIMIT 100`,
      [req.auth.sub]
    );
    return res.json({ invites: rows.rows });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.post('/team-invites/:id/revoke', verifyReferrerToken, async (req, res) => {
  try {
    if (req.auth.type !== 'marketing') return res.status(403).json({ error: 'Hanya head marketing.' });
    const row = await db.query(
      `UPDATE partner_invites SET revoked_at=NOW()
       WHERE id=$1::uuid AND inviter_referrer_id=$2::uuid AND used_at IS NULL
       RETURNING id,revoked_at`, [req.params.id, req.auth.sub]
    );
    if (!row.rowCount) return res.status(409).json({ error: 'Invite tidak ditemukan atau sudah dipakai.' });
    return res.json({ ok: true, invite: row.rows[0] });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// Head Marketing test ID (M7): maksimal 5 aktif, TTL 30 menit, one-time.
router.post('/test-accounts', verifyReferrerToken, async (req, res) => {
  try {
    if (req.auth.type !== 'marketing') return res.status(403).json({ error: 'Hanya Head Marketing.' });
    const result = await marketingTestAccounts.createTestAccount({
      ownerId: req.auth.sub, createdByAdmin: false, label: req.body?.label || null,
    });
    return res.status(201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

router.get('/test-accounts', verifyReferrerToken, async (req, res) => {
  try {
    if (req.auth.type !== 'marketing') return res.status(403).json({ error: 'Hanya Head Marketing.' });
    return res.json({ test_accounts: await marketingTestAccounts.listTestAccounts({ ownerId: req.auth.sub }) });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.post('/test-accounts/:id/revoke', verifyReferrerToken, async (req, res) => {
  try {
    if (req.auth.type !== 'marketing') return res.status(403).json({ error: 'Hanya Head Marketing.' });
    const row = await marketingTestAccounts.revokeTestAccount({ id: req.params.id, ownerId: req.auth.sub });
    return res.json({ ok: true, test_account: row });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Marketing & sekolah lihat murid yang masuk via referral mereka
router.get('/students', verifyReferrerToken, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(50, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;

    // Ambil referral_code milik referrer ini
    const ref = await db.query(
      'SELECT referral_code, type FROM referrers WHERE id = $1', [req.auth.sub]);
    if (ref.rowCount === 0) return res.status(404).json({ error: 'referrer tidak ditemukan' });
    const { referral_code, type } = ref.rows[0];

    const rows = await db.query(`
      SELECT s.id, s.display_name, s.username, s.current_level,
             s.paid_basic_up_to_level, s.paid_premium_up_to_level,
             s.created_at AS joined_at,
             COALESCE(SUM(e.commission_idr), 0) AS total_commission_idr
      FROM students s
      LEFT JOIN referrer_earnings e ON e.student_id = s.id AND e.referrer_id = $1
      WHERE s.referred_by = $2
      GROUP BY s.id
      ORDER BY s.created_at DESC
      LIMIT $3 OFFSET $4
    `, [req.auth.sub, req.auth.sub, limit, offset]);

    const total = await db.query(
      'SELECT COUNT(*) FROM students WHERE referred_by = $1', [req.auth.sub]);

    res.json({
      page, limit,
      total: parseInt(total.rows[0].count),
      referral_code,
      type,
      students: rows.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/referrer/linked-schools
// Khusus marketing: lihat sekolah yang dilinkkan ke akun marketing ini
router.get('/linked-schools', verifyReferrerToken, async (req, res) => {
  try {
    const ref = await db.query(
      'SELECT type FROM referrers WHERE id = $1', [req.auth.sub]);
    if (ref.rowCount === 0) return res.status(404).json({ error: 'referrer tidak ditemukan' });
    if (ref.rows[0].type !== 'marketing') {
      return res.status(403).json({ error: 'endpoint ini hanya untuk tipe marketing' });
    }

    const rows = await db.query(`
      SELECT sml.id AS link_id, sml.is_active, sml.created_at AS linked_at,
             r.id AS school_id, r.full_name AS school_name,
             r.referral_code AS school_code,
             r.commission_rate AS school_rate,
             r.total_conversions AS school_total_students,
             r.total_earnings_idr AS school_total_earned_idr
      FROM school_marketing_links sml
      JOIN referrers r ON r.id = sml.school_id
      WHERE sml.marketing_id = $1
      ORDER BY sml.created_at DESC
    `, [req.auth.sub]);

    res.json({ linked_schools: rows.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

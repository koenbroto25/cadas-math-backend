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
const jwt = require('jsonwebtoken');

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

    const token = jwt.sign(
      { sub: ref.id, role: 'referrer', referral_code: ref.referral_code },
      SECRET, { expiresIn: '30d' });

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
      "SELECT COALESCE(SUM(commission_idr),0) AS pending_idr FROM referrer_earnings WHERE referrer_id = $1 AND status = 'pending'",
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
             e.status, e.transferred_at, e.created_at,
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


// GET /api/referrer/students?page=1&limit=20
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

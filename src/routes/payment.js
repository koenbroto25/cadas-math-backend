/**
 * routes/payment.js - FASE 6
 * POST /api/payment/upgrade-tier
 * POST /api/admin/billing/activate
 * GET  /api/admin/billing/status/:student_id
 */
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { verifyToken, requireRole } = require('../middleware/auth');

const PRICING = { basic_single:40000, basic_bundle_3:100000, premium_single:65000, premium_bundle_3:165000, upgrade_diff:25000 };

async function calcCommission(referrerCode, amountIdr) {
  if (!referrerCode) return { referrerId: null, commission: 0 };
  const r = await db.query("SELECT id, commission_rate FROM referrers WHERE referral_code = $1 AND status = 'approved'", [referrerCode]);
  if (r.rowCount === 0) return { referrerId: null, commission: 0 };
  return { referrerId: r.rows[0].id, commission: Math.round(amountIdr * parseFloat(r.rows[0].commission_rate || 0) / 100) };
}

// POST /api/payment/upgrade-tier
router.post('/upgrade-tier', verifyToken, requireRole('parent', 'admin'), async (req, res) => {
  const { student_id, level } = req.body || {};
  if (!student_id || !level) return res.status(400).json({ error: 'student_id dan level wajib' });
  try {
    if (req.auth.role === 'parent') {
      const link = await db.query('SELECT 1 FROM parent_children WHERE parent_id = $1 AND student_id = $2', [req.auth.sub, student_id]);
      if (link.rowCount === 0) return res.status(403).json({ error: 'bukan anak Anda' });
    }
    const s = await db.query('SELECT paid_basic_up_to_level, paid_premium_up_to_level FROM students WHERE id = $1', [student_id]);
    if (s.rowCount === 0) return res.status(404).json({ error: 'siswa tidak ditemukan' });
    const { paid_basic_up_to_level, paid_premium_up_to_level } = s.rows[0];
    if (!paid_basic_up_to_level || level > paid_basic_up_to_level) return res.status(400).json({ error: 'level belum dibeli Basic' });
    if (paid_premium_up_to_level && level <= paid_premium_up_to_level) return res.status(400).json({ error: 'sudah Premium' });
    res.json({ ok: true, level, amount_idr: PRICING.upgrade_diff, whatsapp_contact: process.env.ADMIN_WHATSAPP || '6281234567890', whatsapp_message: `Halo, upgrade Level ${level} Basic ke Premium untuk student_id ${student_id}` });
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

// POST /api/admin/billing/activate  (router di-mount di /api/admin → path internal /billing/activate)
router.post('/billing/activate', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'unauthorized' });
  const { student_id, product_type, level_from, level_to, amount_idr, payment_method, proof_note, referrer_code } = req.body || {};
  if (!student_id || !product_type || !level_from || !level_to || !amount_idr) return res.status(400).json({ error: 'field wajib kurang' });
  try {
    const { referrerId, commission } = await calcCommission(referrer_code, amount_idr);
    const isPremium = product_type.startsWith('premium');
    const col = isPremium ? 'paid_premium_up_to_level' : 'paid_basic_up_to_level';
    await db.query(`UPDATE students SET ${col} = GREATEST(COALESCE(${col}, 0), $1) WHERE id = $2`, [level_to, student_id]);
    await db.query('INSERT INTO payment_records (student_id,product_type,level_from,level_to,amount_idr,payment_method,proof_url,referrer_code,commission_amount_idr,is_confirmed,confirmed_by_admin_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,NOW())', [student_id,product_type,level_from,level_to,amount_idr,payment_method||'manual_transfer',proof_note||null,referrer_code||null,commission]);
    if (referrerId) await db.query('UPDATE referrers SET total_active_referrals = total_active_referrals + 1 WHERE id = $1', [referrerId]);
    const st = await db.query('SELECT display_name,current_level,paid_basic_up_to_level,paid_premium_up_to_level FROM students WHERE id = $1', [student_id]);
    res.json({ ok: true, student_id, student: st.rows[0], activated: { product_type, level_from, level_to, is_premium: isPremium }, commission_idr: commission });
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

// GET /api/admin/billing/status/:student_id  (router di-mount di /api/admin)
router.get('/billing/status/:student_id', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'unauthorized' });
  try {
    const s = await db.query('SELECT id,display_name,current_level,trial_level,paid_basic_up_to_level,paid_premium_up_to_level FROM students WHERE id = $1', [req.params.student_id]);
    if (s.rowCount === 0) return res.status(404).json({ error: 'siswa tidak ditemukan' });
    const p = await db.query('SELECT * FROM payment_records WHERE student_id = $1 ORDER BY created_at DESC', [req.params.student_id]);
    res.json({ student: s.rows[0], payment_history: p.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

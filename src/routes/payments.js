/**
 * routes/payments.js — Auth & Payment (Placement_Test_System.md §13.5)
 *
 * Model: paket = kredit level. Rentang level 100% ditentukan placement test.
 *   POST /api/payments/purchase        — beli paket (level_1 / level_3)
 *   GET  /api/payments/status/:sid     — ringkasan scope + kredit pending
 *   POST /api/payments/invite          — buat kode undangan (anak→ortu / ortu→anak)
 *   POST /api/payments/invite/redeem   — ortu redeem kode → link + transfer kredit
 *
 * Pembayaran saat ini simulasi sukses (manual transfer / sandbox).
 * Gateway asli menyusul di sesi terpisah — tidak mengubah shape endpoint.
 */
const express = require('express');
const db      = require('../database/db');
const access  = require('../services/accessService');
const purchasePayment = require('../services/purchasePaymentService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── POST /api/payments/qris ───────────────────────────────────────────────────
// Body: { package, student_id?, referrer_code? }. QRIS adalah satu-satunya metode.
router.post('/qris', requireAuth, async (req, res) => {
  try {
    const packageName = String(req.body?.package || '').trim();
    const referrerCode = String(req.body?.referrer_code || '').trim() || null;
    const result = await purchasePayment.createQrisPurchase({
      role: req.user?.role,
      actorId: req.user?.id,
      studentId: req.body?.student_id || null,
      packageName,
      referrerCode,
    });
    return res.status(201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[payments/qris]', err);
    return res.status(502).json({ error: err.message || 'Gagal membuat QRIS' });
  }
});

// Body: { package: 'level_1'|'level_3' }. Actor/pemilik diambil dari JWT.
router.post('/purchase', requireAuth, async (req, res) => {
  return res.status(410).json({
    error: 'Endpoint purchase manual dinonaktifkan. Gunakan POST /api/payments/qris.',
  });
});

/*
router.post('/purchase', requireAuth, async (req, res) => {
  try {
    const packageName = req.body?.package;
    if (!packageName) {
      return res.status(400).json({ error: 'package wajib (level_1 atau level_3)' });
    }
    const role = req.user?.role;
    let studentId = role === 'student' ? req.user.id : null;
    const parentId = role === 'parent' ? req.user.id : null;
    if (!studentId && !parentId) {
      return res.status(403).json({ error: 'hanya siswa atau orang tua yang dapat membeli paket' });
    }
    if (role === 'parent' && req.body?.student_id) {
      const link = await db.query(
        'SELECT 1 FROM parent_children WHERE parent_id = $1 AND student_id = $2',
        [parentId, req.body.student_id]
      );
      if (link.rowCount === 0) return res.status(403).json({ error: 'anak belum tertaut ke akun ini' });
      studentId = req.body.student_id;
    }

    const result = await access.createPurchase(db, {
      studentId,
      parentId,
      packageName: packageName === 'level_1' ? 'basic_single' : packageName === 'level_3' ? 'basic_bundle_3' : packageName,
    });

    const summary = studentId
      ? await access.getAccessSummary(db, studentId)
      : null;

    return res.status(201).json({ purchase: result, access: summary });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[payments/purchase]', err);
    return res.status(500).json({ error: 'gagal memproses pembelian' });
  }
});
*/

// ── GET /api/payments/status/:studentId ─────────────────────────────────────
// Hanya siswa pemilik atau orang tua yang sudah tertaut boleh membaca status.
router.get('/status/:studentId', requireAuth, async (req, res) => {
  try {
    const targetId = req.params.studentId;
    const role = req.user?.role;
    if (role === 'student' && req.user.id !== targetId) {
      return res.status(403).json({ error: 'siswa hanya dapat membaca status miliknya' });
    }
    if (role === 'parent') {
      const link = await db.query(
        'SELECT 1 FROM parent_children WHERE parent_id = $1 AND student_id = $2',
        [req.user.id, targetId]
      );
      if (link.rowCount === 0) return res.status(403).json({ error: 'anak belum tertaut ke akun ini' });
    } else if (role !== 'student') {
      return res.status(403).json({ error: 'role tidak diizinkan' });
    }
    const summary = await access.getAccessSummary(db, targetId);
    return res.json(summary);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[payments/status]', err);
    return res.status(500).json({ error: 'gagal memuat status akses' });
  }
});

// ── POST /api/payments/invite ───────────────────────────────────────────────
// Auth wajib. ID actor selalu diambil dari JWT, bukan dari body request.
// - student: membuat kode untukchreier (student_id = req.user.id)
// - parent: membuat kode untuk nanti dikaitkan ke anak
router.post('/invite', requireAuth, async (req, res) => {
  try {
    const role = req.user?.role;
    let studentId = null;
    let parentId = null;

    if (role === 'student') {
      studentId = req.user.id;
    } else if (role === 'parent') {
      parentId = req.user.id;
    } else {
      return res.status(403).json({ error: 'hanya siswa atau orang tua yang dapat membuat undangan' });
    }

    const invite = await access.createInvite(db, { studentId, parentId });
    return res.status(201).json(invite);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[payments/invite]', err);
    return res.status(500).json({ error: 'gagal membuat kode undangan' });
  }
});

// ── POST /api/payments/invite/redeem ────────────────────────────────────────
// Body: { code }. Aktor(parent atau student) diambil dari JWT.
router.post('/invite/redeem', requireAuth, async (req, res) => {
  try {
    const code = String(req.body?.code || '').trim();
    if (!code) return res.status(400).json({ error: 'code wajib' });
    const role = req.user?.role;
    if (role !== 'parent' && role !== 'student') {
      return res.status(403).json({ error: 'hanya siswa atau orang tua yang dapat menukar kode' });
    }

    const result = await access.redeemInvite(db, {
      code,
      parentId: role === 'parent' ? req.user.id : null,
      studentId: role === 'student' ? req.user.id : null,
    });
    const ownerParentId = role === 'parent' ? req.user.id : (await db.query('SELECT parent_id FROM invite_links WHERE code=$1', [code])).rows[0]?.parent_id;
    if (ownerParentId) {
      const attachedAgain = await access.attachPaidPurchasesToStudent(db, ownerParentId, result.student_id);
      for (const purchaseId of attachedAgain.purchase_ids) {
        await purchasePayment.reconcileStudentPurchase(db, purchaseId, result.student_id);
      }
    }
    for (const purchaseId of result.paid_purchase_ids || []) {
      await purchasePayment.reconcileStudentPurchase(db, purchaseId, result.student_id);
    }
    const anchor = await access.getPlacementAnchor(db, result.student_id);
    let activation = null;
    if (anchor !== null && result.transferred_levels > 0) {
      activation = await access.activatePendingPurchases(db, result.student_id, anchor);
    }

    const summary = await access.getAccessSummary(db, result.student_id);
    return res.json({ ...result, activation, access: summary });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[payments/invite/redeem]', err);
    return res.status(500).json({ error: 'gagal redeem kode undangan' });
  }
});

module.exports = router;

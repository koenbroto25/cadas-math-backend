/**
 * routes/auth.js — Sistem Auth Baru Cadas Matematika
 * Phase 1+3: display_id, parent_phone, parent_children, add-child, card-shared
 * Backward compatible — endpoint lama tetap berfungsi
 */

const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const db       = require('../database/db');
const { requireAuth, requireParent } = require('../middleware/auth');
const { generateDisplayId, normalizeDisplayId, normalizePhone } = require('../utils/studentId');

const router = express.Router();

const JWT_SECRET  = process.env.JWT_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

// ── Helper ────────────────────────────────────────────────────────────────────

function signToken(payload, expiresIn = '90d') {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

async function checkDisplayIdExists(id) {
  const r = await db.query('SELECT 1 FROM students WHERE display_id = $1', [id]);
  return r.rowCount > 0;
}

async function linkParentChild(parentId, studentId) {
  await db.query(
    `INSERT INTO parent_children (parent_id, student_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [parentId, studentId]
  );
}

async function getLinkedChildren(parentId) {
  const r = await db.query(
    `SELECT s.id, s.display_id, s.name, s.kelas, s.current_level,
            s.card_shared, s.parent_phone
     FROM students s
     JOIN parent_children pc ON pc.student_id = s.id
     WHERE pc.parent_id = $1
     ORDER BY pc.linked_at ASC`,
    [parentId]
  );
  return r.rows;
}

// ── STUDENT — Register ────────────────────────────────────────────────────────

router.post('/student/register', async (req, res) => {
  try {
    const { name, kelas, parent_phone } = req.body;

    if (!name?.trim() || name.trim().length < 2)
      return res.status(400).json({ error: 'Nama minimal 2 karakter.' });

    const k = parseInt(kelas, 10);
    if (!k || k < 1 || k > 9)
      return res.status(400).json({ error: 'Kelas harus 1-9.' });

    // Generate display_id unik
    const display_id = await generateDisplayId(checkDisplayIdExists);

    // Normalisasi phone jika ada
    const phone_normalized = parent_phone ? normalizePhone(parent_phone) : null;

    const r = await db.query(
      `INSERT INTO students (name, kelas, display_id, parent_phone)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, kelas, display_id, parent_phone, current_level`,
      [name.trim(), k, display_id, phone_normalized]
    );
    const student = r.rows[0];
    const token   = signToken({ id: student.id, role: 'student' });

    return res.json({ token, student });
  } catch (err) {
    console.error('[auth/student/register]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ── STUDENT — Login ───────────────────────────────────────────────────────────

router.post('/student/login', async (req, res) => {
  try {
    // Support login via display_id (B7KM) ATAU student_id lama (UUID)
    const { student_id, display_id: rawDisplayId } = req.body;

    let student = null;

    if (rawDisplayId) {
      const did = normalizeDisplayId(rawDisplayId);
      if (!did) return res.status(400).json({ error: 'Format ID tidak valid. Gunakan 4 karakter seperti B7KM.' });
      const r = await db.query(
        `SELECT id, name, kelas, display_id, current_level, card_shared
         FROM students WHERE display_id = $1`, [did]
      );
      student = r.rows[0];
    } else if (student_id) {
      // Backward compat — login via UUID lama
      const r = await db.query(
        `SELECT id, name, kelas, display_id, current_level, card_shared
         FROM students WHERE id = $1`, [student_id]
      );
      student = r.rows[0];
    } else {
      return res.status(400).json({ error: 'Kirim display_id (B7KM) atau student_id.' });
    }

    if (!student) return res.status(404).json({ error: 'Akun tidak ditemukan.' });

    const token = signToken({ id: student.id, role: 'student' });
    return res.json({ token, student });
  } catch (err) {
    console.error('[auth/student/login]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ── STUDENT — Mark card shared ────────────────────────────────────────────────

router.patch('/student/card-shared', requireAuth, async (req, res) => {
  try {
    const { shared_via } = req.body; // 'whatsapp' | 'pdf' | 'copy'
    const studentId = req.user.id;

    await db.query(
      `UPDATE students
       SET card_shared = true, card_shared_at = now()
       WHERE id = $1`,
      [studentId]
    );

    // Log channel yang dipakai (opsional, untuk analytics)
    if (shared_via) {
      await db.query(
        `INSERT INTO events (student_id, event_type, meta)
         VALUES ($1, 'card_shared', $2)
         ON CONFLICT DO NOTHING`,
        [studentId, JSON.stringify({ via: shared_via })]
      ).catch(() => {}); // non-blocking, tabel events mungkin belum ada
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[auth/student/card-shared]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ── STUDENT — Get card data (untuk re-share dari Settings) ───────────────────

router.get('/student/card', requireAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, name, kelas, display_id, current_level, card_shared,
              card_shared_at, parent_phone
       FROM students WHERE id = $1`,
      [req.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Tidak ditemukan.' });

    const student = r.rows[0];

    // Cek apakah sudah ada orang tua yang terhubung
    const parentR = await db.query(
      `SELECT p.id, p.name FROM parents p
       JOIN parent_children pc ON pc.parent_id = p.id
       WHERE pc.student_id = $1 LIMIT 1`,
      [student.id]
    );
    student.parent_linked = parentR.rowCount > 0;
    student.parent_name   = parentR.rows[0]?.name || null;

    return res.json(student);
  } catch (err) {
    console.error('[auth/student/card]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ── PARENT — Register ─────────────────────────────────────────────────────────

router.post('/parent/register', async (req, res) => {
  try {
    const { name, email, password, phone, child_id } = req.body;

    if (!name?.trim())  return res.status(400).json({ error: 'Nama wajib diisi.' });
    if (!email?.trim()) return res.status(400).json({ error: 'Email wajib diisi.' });
    if (!password || password.length < 6)
      return res.status(400).json({ error: 'Password minimal 6 karakter.' });
    if (!phone?.trim()) return res.status(400).json({ error: 'Nomor HP wajib diisi.' });

    const phone_normalized = normalizePhone(phone);
    if (!phone_normalized)
      return res.status(400).json({ error: 'Format nomor HP tidak valid.' });

    // Cek duplikat email
    const emailCheck = await db.query(
      'SELECT id FROM parents WHERE email = $1', [email.trim().toLowerCase()]
    );
    if (emailCheck.rowCount > 0)
      return res.status(409).json({ error: 'Email sudah terdaftar.' });

    const hashed = await bcrypt.hash(password, 10);

    const r = await db.query(
      `INSERT INTO parents (name, email, password_hash, phone)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, phone`,
      [name.trim(), email.trim().toLowerCase(), hashed, phone_normalized]
    );
    const parent = r.rows[0];

    // ── Auto-link via child_id (Jalur A/B) ──
    let linked_children = [];
    if (child_id) {
      const did = normalizeDisplayId(child_id);
      if (did) {
        const sr = await db.query(
          'SELECT id FROM students WHERE display_id = $1', [did]
        );
        if (sr.rows[0]) {
          await linkParentChild(parent.id, sr.rows[0].id);
        }
      }
    }

    // ── Auto-link via phone matching (Jalur C) — jika child_id tidak ada ──
    if (!child_id && phone_normalized) {
      const sr = await db.query(
        'SELECT id FROM students WHERE parent_phone = $1', [phone_normalized]
      );
      for (const student of sr.rows) {
        await linkParentChild(parent.id, student.id);
      }
    }

    linked_children = await getLinkedChildren(parent.id);
    const token = signToken({ id: parent.id, role: 'parent' });

    return res.json({ token, parent, linked_children });
  } catch (err) {
    console.error('[auth/parent/register]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ── PARENT — Login ────────────────────────────────────────────────────────────

router.post('/parent/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email dan password wajib diisi.' });

    const r = await db.query(
      'SELECT id, name, email, password_hash, phone FROM parents WHERE email = $1',
      [email.trim().toLowerCase()]
    );
    const parent = r.rows[0];
    if (!parent) return res.status(404).json({ error: 'Akun tidak ditemukan.' });

    const valid = await bcrypt.compare(password, parent.password_hash);
    if (!valid) return res.status(401).json({ error: 'Password salah.' });

    const linked_children = await getLinkedChildren(parent.id);
    const token = signToken({ id: parent.id, role: 'parent' });

    return res.json({ token, parent: { id: parent.id, name: parent.name, email: parent.email, phone: parent.phone }, linked_children });
  } catch (err) {
    console.error('[auth/parent/login]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ── PARENT — Add child ke akun yang sudah ada ─────────────────────────────────

router.post('/parent/add-child', requireAuth, requireParent, async (req, res) => {
  try {
    const { child_id } = req.body;
    if (!child_id) return res.status(400).json({ error: 'child_id wajib diisi.' });

    const did = normalizeDisplayId(child_id);
    if (!did) return res.status(400).json({ error: 'Format ID tidak valid (contoh: B7KM).' });

    const sr = await db.query(
      'SELECT id, name, kelas, display_id, current_level FROM students WHERE display_id = $1',
      [did]
    );
    if (!sr.rows[0]) return res.status(404).json({ error: 'Siswa dengan ID tersebut tidak ditemukan.' });

    await linkParentChild(req.user.id, sr.rows[0].id);
    const linked_children = await getLinkedChildren(req.user.id);

    return res.json({ ok: true, linked_children });
  } catch (err) {
    console.error('[auth/parent/add-child]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ── PARENT — Get children list ────────────────────────────────────────────────

router.get('/parent/children', requireAuth, requireParent, async (req, res) => {
  try {
    const children = await getLinkedChildren(req.user.id);
    return res.json({ children });
  } catch (err) {
    console.error('[auth/parent/children]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ── DEMO — Passcode (endpoint lama, tetap ada) ────────────────────────────────

router.post('/demo/redeem', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || String(code).length !== 4 || isNaN(Number(code)))
      return res.status(400).json({ error: 'Passcode harus 4 angka.' });

    const r = await db.query(
      `SELECT id, label, expires_at FROM demo_passcodes
       WHERE code = $1 AND is_active = true AND expires_at > now()`,
      [String(code)]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Passcode tidak valid atau sudah kadaluarsa.' });

    const { label, expires_at } = r.rows[0];
    const token = signToken({ role: 'demo', kind: 'client', label }, '30d');

    return res.json({ ok: true, token, label, expires_at });
  } catch (err) {
    console.error('[auth/demo/redeem]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

router.post('/demo/admin-token', async (req, res) => {
  try {
    const secret = req.headers['x-admin-secret'];
    if (!secret || secret !== ADMIN_SECRET)
      return res.status(403).json({ error: 'Forbidden.' });

    const token = signToken({ role: 'demo', kind: 'admin', label: 'Admin Demo' }, '30d');
    return res.json({ ok: true, demo_token: token });
  } catch (err) {
    console.error('[auth/demo/admin-token]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;

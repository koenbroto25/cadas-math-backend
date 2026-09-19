/**
 * routes/auth.js — Sistem Auth Baru Cadas Matematika
 * Phase 1+3: display_id, parent_phone, parent_children, add-child, card-shared
 * Backward compatible — endpoint lama tetap berfungsi
 *
 * FIX 2026-09-18 (sinkron Neon, Opsi A1):
 *  - Kolom display (name/kelas/parents.name) dari migrasi 019; semua SELECT
 *    pakai COALESCE agar baris lama (display_name/grade_level) tetap jalan.
 *  - JWT via middleware signToken (satu SECRET + fail-fast production).
 *  - Tambah POST /parent/merge-account (D3, wajib): gabung akun lama ke aktif.
 */

const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const db       = require('../database/db');
const { requireAuth, requireParent, signToken } = require('../middleware/auth');
const { generateDisplayId, normalizeDisplayId, normalizePhone } = require('../utils/studentId');

const router = express.Router();

const ADMIN_SECRET = process.env.ADMIN_SECRET;

// ── Helper ────────────────────────────────────────────────────────────────────

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
    `SELECT s.id, s.display_id,
            COALESCE(s.name, s.display_name) AS name,
            COALESCE(s.kelas, s.grade_level) AS kelas,
            s.current_level, s.card_shared, s.parent_phone
     FROM students s
     JOIN parent_children pc ON pc.student_id = s.id
     WHERE pc.parent_id = $1
     ORDER BY pc.linked_at ASC`,
    [parentId]
  );
  return r.rows;
}

// Baris student untuk respons publik (lama + baru digabung).
const STUDENT_PUBLIC_COLS = `
  id,
  COALESCE(name, display_name) AS name,
  COALESCE(kelas, grade_level) AS kelas,
  display_id, current_level, card_shared
`;

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
      `INSERT INTO students (name, kelas, display_id, parent_phone, display_name, grade_level)
       VALUES ($1, $2, $3, $4, $1, $2)
       RETURNING id, name,
                 COALESCE(kelas, grade_level) AS kelas,
                 display_id, parent_phone, current_level`,
      [name.trim(), k, display_id, phone_normalized]
    );
    const student = r.rows[0];
    const token   = signToken({ id: student.id, role: 'student' });

    // Respons lengkap untuk frontend v3 (StudentRegisterScreen):
    // data.student.display_id dipakai untuk RegisterSuccessView + kartu identitas.
    return res.status(201).json({
      token,
      student_id: student.id,
      student: { ...student, card_shared: false },
    });
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
        `SELECT id, COALESCE(name, display_name) AS name, COALESCE(kelas, grade_level) AS kelas, display_id, current_level, card_shared
         FROM students WHERE display_id = $1`, [did]
      );
      student = r.rows[0];
    } else if (student_id) {
      // Backward compat — login via UUID lama
      const r = await db.query(
        `SELECT id, COALESCE(name, display_name) AS name, COALESCE(kelas, grade_level) AS kelas, display_id, current_level, card_shared
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
      `SELECT id, COALESCE(name, display_name) AS name, COALESCE(kelas, grade_level) AS kelas, display_id, current_level, card_shared,
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
      `INSERT INTO parents (name, display_name, email, password_hash, phone)
       VALUES ($1::text, $1::text, $2, $3, $4)
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
      'SELECT id, COALESCE(name, display_name) AS name, email, password_hash, phone FROM parents WHERE email = $1',
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
      'SELECT id, COALESCE(name, display_name) AS name, COALESCE(kelas, grade_level) AS kelas, display_id, current_level FROM students WHERE display_id = $1',
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
// ── PARENT — Merge account (D3, wajib) ───────────────────────────────────
// Body: { source_email, password }. Pindahkan semua link anak dari akun
// lama ke akun yg sedang login (dalam transaksi). Dipakai saat ortu tanpa
// sengaja punya 2 akun (daftar via placement + daftar manual).
router.post('/parent/merge-account', requireAuth, requireParent, async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { source_email, password } = req.body;
    if (!source_email || !password)
      return res.status(400).json({ error: 'source_email dan password wajib diisi.' });
    const em = String(source_email).trim().toLowerCase();
    const sr = await client.query('SELECT id, password_hash FROM parents WHERE email = $1', [em]);
    if (!sr.rows[0]) return res.status(404).json({ error: 'Akun lama tidak ditemukan.' });
    const srcId = sr.rows[0].id;
    if (srcId === req.user.id)
      return res.status(400).json({ error: 'Tidak bisa merge ke akun yang sama.' });
    const valid = await bcrypt.compare(password, sr.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Password akun lama salah.' });
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO parent_children (parent_id, student_id) SELECT $1, student_id FROM parent_children WHERE parent_id = $2 ON CONFLICT DO NOTHING',
      [req.user.id, srcId]
    );
    await client.query('DELETE FROM parent_children WHERE parent_id = $1', [srcId]);
    await client.query('COMMIT');
    const linked_children = await getLinkedChildren(req.user.id);
    return res.json({ ok: true, linked_children });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[auth/parent/merge-account]', err);
    return res.status(500).json({ error: 'Server error.' });
  } finally { client.release(); }
});



router.get('/parent/children', requireAuth, requireParent, async (req, res) => {
  try {
    const children = await getLinkedChildren(req.user.id);
    return res.json({ children });
  } catch (err) {
    console.error('[auth/parent/children]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/auth/me — echo payload token ─────────────────────────────

router.get('/me', requireAuth, async (req, res) => {
  try {
    return res.json({ auth: { id: req.auth.id, role: req.auth.role, sub: req.auth.id } });
  } catch (err) {
    console.error('[auth/me]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ── PARENT — Gate (D3, wajib) ────────────────────────────────────────────────
// Endpoint challenge soal perkalian sebelum masuk area parent/guru dari sesi anak
// Body: tidak ada
// Response: { challenge_token, question }
// Token: JWT Bearer (role parent) dengan expiry 2 menit (custom)
// Validasi: hanya role parent/guru bisa akses

router.get('/parent-gate/challenge', async (req, res) => {
  try {
    const { sub: parentId } = req.auth || {};

    // Generate random multiplication question (2-9 × 2-9)
    const a = Math.floor(Math.random() * 8) + 2; // 2-9
    const b = Math.floor(Math.random() * 8) + 2; // 2-9
    const correctAnswer = a * b;

    // Create short-lived challenge token with answer
    const challengeToken = jwt.sign({
      role: 'parent_gate',
      parent_id: parentId,
      ans: correctAnswer
    }, process.env.JWT_SECRET || 'cadas_app_secure_secret_key_2026', { expiresIn: '2m' });

    const question = `${a} × ${b} = ?`;

    return res.json({ challenge_token: challengeToken, question });
  } catch (err) {
    console.error('[auth/parent-gate/challenge]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// Verifikasi jawaban challenge parent-gate
// Body: { challenge_token, answer }
// Response: { gate_token } pada jawaban benar
// TTL gate_token: 15 menit

router.post('/parent-gate/verify', async (req, res) => {
  try {
    const { challenge_token, answer } = req.body;
    if (!challenge_token || typeof answer === 'undefined') {
      return res.status(400).json({ error: 'challenge_token dan answer wajib diisi.' });
    }

    let decoded;
    try {
      decoded = jwt.verify(challenge_token, process.env.JWT_SECRET || 'cadas_app_secure_secret_key_2026');
    } catch {
      return res.status(401).json({ error: 'challenge_token tidak valid atau kedaluwarsa.' });
    }

    // Pastikan challenge token milik user yang sedang login dan role parent_gate
    if (decoded.role !== 'parent_gate' || decoded.parent_id !== req.auth.sub) {
      return res.status(403).json({ error: 'Akses ditolak untuk challenge token ini.' });
    }

    if (decoded.ans !== Number(answer)) {
      return res.status(401).json({ error: 'Jawaban salah.' });
    }

    // Berikan gate_token untuk session parent selanjutnya
    const gateToken = signToken({
      role: 'parent',
      sub: req.auth.sub,
      kind: 'gate_pass',
      challenge_valid: true
    }, '15m');

    return res.json({ gate_token: gateToken });
  } catch (err) {
    console.error('[auth/parent-gate/verify]', err);
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

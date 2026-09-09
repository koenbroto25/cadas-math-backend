/**
 * FASE 3.1 — Auth: register/login 3 role + Parent Gate.
 *
 * Urutan onboarding mengikuti [ADD] §6.2 (OVERRIDE): siswa daftar TANPA
 * registrasi orang tua — orang tua baru daftar SETELAH placement (FASE 4).
 * Maka: student/register hanya bikin profil anak, TANPA email/password.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../database/db');
const { signToken, verifyToken } = require('../middleware/auth');

const router = express.Router();
const BCRYPT_ROUNDS = 10;

// ── STUDENT ────────────────────────────────────────────────────────────────
// POST /api/auth/student/register  { name, kelas }
// → 200 { student_id } — TIDAK minta email/password (urutan [ADD] §6.2)
router.post('/student/register', async (req, res) => {
  const { name, kelas } = req.body || {};
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return res.status(400).json({ error: 'name wajib diisi (min 2 karakter)' });
  }
  const grade = parseInt(kelas, 10);
  if (!Number.isInteger(grade) || grade < 1 || grade > 9) {
    return res.status(400).json({ error: 'kelas harus angka 1-9 (SMP ke atas)' });
  }

  try {
    const username = `siswa_${crypto.randomBytes(4).toString('hex')}`;
    const r = await db.query(
      `INSERT INTO students (username, display_name, grade_level, current_level, trial_level)
       VALUES ($1, $2, $3, 1, 1)
       RETURNING id, username, display_name AS name, grade_level AS kelas, current_level`,
      [username, name.trim(), grade]
    );
    const student = r.rows[0];
    // Token siswa: untuk identitas device-profile (tanpa login mandiri, V3 §5.3)
    res.status(201).json({
      student_id: student.id,
      student,
      token: signToken({ sub: student.id, role: 'student' }),
    });
  } catch (err) {
    console.error('student/register:', err.message);
    res.status(500).json({ error: 'gagal mendaftarkan siswa' });
  }
});

// ── PARENT ─────────────────────────────────────────────────────────────────
// POST /api/auth/parent/register  { name, email?, phone?, password }
router.post('/parent/register', async (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return res.status(400).json({ error: 'name wajib diisi' });
  }
  if (!email && !phone) {
    return res.status(400).json({ error: 'email atau phone wajib diisi salah satu' });
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'password wajib diisi (min 6 karakter)' });
  }

  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const r = await db.query(
      `INSERT INTO parents (phone, email, display_name, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, display_name, email, phone`,
      [phone || null, email || null, name.trim(), hash]
    );
    const parent = r.rows[0];
    res.status(201).json({
      parent_id: parent.id,
      parent,
      token: signToken({ sub: parent.id, role: 'parent' }),
    });
  } catch (err) {
    if (String(err.message).includes('uq_parents_email') || String(err.message).includes('parents_phone_key')) {
      return res.status(409).json({ error: 'email/phone sudah terdaftar' });
    }
    console.error('parent/register:', err.message);
    res.status(500).json({ error: 'gagal mendaftarkan parent' });
  }
});

// POST /api/auth/parent/login  { email? , phone?, password }
router.post('/parent/login', async (req, res) => {
  const { email, phone, password } = req.body || {};
  if ((!email && !phone) || !password) {
    return res.status(400).json({ error: 'email/phone + password wajib diisi' });
  }
  try {
    const r = await db.query(
      'SELECT id, display_name, password_hash FROM parents WHERE email = $1 OR phone = $1',
      [email || phone]
    );
    if (r.rowCount === 0) return res.status(401).json({ error: 'kredensial salah' });
    const ok = await bcrypt.compare(password, r.rows[0].password_hash || '');
    if (!ok) return res.status(401).json({ error: 'kredensial salah' });

    res.json({
      parent_id: r.rows[0].id,
      name: r.rows[0].display_name,
      token: signToken({ sub: r.rows[0].id, role: 'parent' }),
    });
  } catch (err) {
    console.error('parent/login:', err.message);
    res.status(500).json({ error: 'gagal login' });
  }
});

// ── TEACHER ────────────────────────────────────────────────────────────────
// POST /api/auth/teacher/register  { name, email, password, teacher_type }
// teacher_type: 'school' (classroom gratis, 0% komisi) | 'private' (referral+komisi)
router.post('/teacher/register', async (req, res) => {
  const { name, email, password, teacher_type } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name + email wajib diisi' });
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'password wajib diisi (min 6 karakter)' });
  }
  if (!['school', 'private'].includes(teacher_type)) {
    return res.status(400).json({ error: "teacher_type harus 'school' atau 'private'" });
  }

  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const r = await db.query(
      `INSERT INTO teachers (email, display_name, teacher_type, password_hash, is_verified)
       VALUES ($1, $2, $3, $4, FALSE)
       RETURNING id, display_name, email, teacher_type, is_verified`,
      [email.toLowerCase(), name.trim(), teacher_type, hash]
    );
    const teacher = r.rows[0];
    // Guru baru BELUM verified — tidak bisa bikin classroom/referral sampai FASE 11 approval
    res.status(201).json({
      teacher_id: teacher.id,
      teacher,
      verified: false,
      token: signToken({ sub: teacher.id, role: 'teacher', verified: false }),
    });
  } catch (err) {
    if (String(err.message).includes('teachers_email_key') || String(err.message).includes('duplicate')) {
      return res.status(409).json({ error: 'email sudah terdaftar' });
    }
    console.error('teacher/register:', err.message);
    res.status(500).json({ error: 'gagal mendaftarkan guru' });
  }
});

// POST /api/auth/teacher/login  { email, password }
router.post('/teacher/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email + password wajib' });
  try {
    const r = await db.query(
      'SELECT id, display_name, teacher_type, is_verified, password_hash FROM teachers WHERE email = $1',
      [String(email).toLowerCase()]
    );
    if (r.rowCount === 0) return res.status(401).json({ error: 'kredensial salah' });
    const t = r.rows[0];
    const ok = await bcrypt.compare(password, t.password_hash || '');
    if (!ok) return res.status(401).json({ error: 'kredensial salah' });

    res.json({
      teacher_id: t.id,
      name: t.display_name,
      teacher_type: t.teacher_type,
      verified: t.is_verified,
      token: signToken({ sub: t.id, role: 'teacher', verified: t.is_verified }),
    });
  } catch (err) {
    console.error('teacher/login:', err.message);
    res.status(500).json({ error: 'gagal login' });
  }
});

// ── PARENT GATE ([V3] §5.2) ────────────────────────────────────────────────
// Soal perkalian sederhana sebelum masuk area Parent/Guru dari sesi anak.
// Challenge stateless: jawaban ditandatangani ke dalam token ber-TTL 2 menit.
// GET /api/auth/parent-gate/challenge → { challenge_token, question }
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'cadas_app_secure_secret_key_2026';

router.get('/parent-gate/challenge', (req, res) => {
  const a = 2 + Math.floor(Math.random() * 8); // 2..9
  const b = 2 + Math.floor(Math.random() * 8); // 2..9
  const challengeToken = jwt.sign({ ans: a * b, kind: 'gate_challenge' }, SECRET, { expiresIn: '2m' });
  res.json({ challenge_token: challengeToken, question: `${a} × ${b} = ?` });
});

// POST /api/auth/parent-gate/verify  { challenge_token, answer }
// → benar: { gate_token } (TTL 15 menit, dipakai utk akses area parent/guru)
router.post('/parent-gate/verify', (req, res) => {
  const { challenge_token, answer } = req.body || {};
  if (!challenge_token || answer === undefined) {
    return res.status(400).json({ error: 'challenge_token + answer wajib' });
  }
  try {
    const payload = jwt.verify(challenge_token, SECRET);
    if (payload.kind !== 'gate_challenge') {
      return res.status(401).json({ error: 'challenge tidak valid' });
    }
    if (Number(answer) !== Number(payload.ans)) {
      return res.status(401).json({ error: 'jawaban salah — bukan orang tua/wali?' });
    }
    res.json({ gate_token: signToken({ kind: 'gate_pass' }, '15m') });
  } catch {
    return res.status(401).json({ error: 'challenge kedaluwarsa — minta yang baru' });
  }
});

// GET /api/auth/me — echo payload token (uji middleware + dipakai app
// untuk cek identitas setelah login: role, sub, verified)
router.get('/me', verifyToken, (req, res) => {
  res.json({ auth: req.auth });
});

module.exports = router;



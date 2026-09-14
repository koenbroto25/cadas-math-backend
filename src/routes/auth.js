/**
 * FASE 3.1 - Auth: register/login 3 role + Parent Gate.
 */
const express = require('express');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const db      = require('../database/db');
const { signToken, verifyToken, requireRole } = require('../middleware/auth');

const router       = express.Router();
const BCRYPT_ROUNDS = 10;
const SECRET       = process.env.JWT_SECRET || 'cadas_app_secure_secret_key_2026';

// -- STUDENT --------------------------------------------------------------
// POST /api/auth/student/register  { name, kelas, referral_code? }
// referral_code opsional — dikirim frontend jika siswa datang via link /d/:token
router.post('/student/register', async (req, res) => {
  const { name, kelas, referral_code } = req.body || {};
  if (!name || typeof name !== 'string' || name.trim().length < 2)
    return res.status(400).json({ error: 'name wajib diisi (min 2 karakter)' });
  const grade = parseInt(kelas, 10);
  if (!Number.isInteger(grade) || grade < 1 || grade > 9)
    return res.status(400).json({ error: 'kelas harus angka 1-9' });
  try {
    // Resolve referral_code ? referrer id (jika ada dan aktif)
    let referredBy = null;
    if (referral_code && typeof referral_code === 'string') {
      const ref = await db.query(
        `SELECT id, type, is_active FROM referrers
         WHERE referral_code = $1 AND status = 'approved' AND is_active = true`,
        [referral_code.trim().toUpperCase()]
      );
      if (ref.rowCount > 0) referredBy = ref.rows[0].id;
    }

    const username = `siswa_${crypto.randomBytes(4).toString('hex')}`;
    const r = await db.query(
      `INSERT INTO students (username, display_name, grade_level, current_level, trial_level, referred_by)
       VALUES ($1, $2, $3, 1, 1, $4)
       RETURNING id, username, display_name AS name, grade_level AS kelas, current_level`,
      [username, name.trim(), grade, referredBy]
    );
    const student = r.rows[0];
    res.status(201).json({
      student_id: student.id,
      student,
      referral_attached: referredBy !== null,
      token: signToken({ sub: student.id, role: 'student' }),
    });
  } catch (err) {
    console.error('student/register:', err.message);
    res.status(500).json({ error: 'gagal mendaftarkan siswa' });
  }
});

// POST /api/auth/student/login  { student_id }
router.post('/student/login', async (req, res) => {
  const { student_id } = req.body || {};
  if (!student_id || typeof student_id !== 'string')
    return res.status(400).json({ error: 'student_id wajib diisi' });
  try {
    const r = await db.query(
      `SELECT id, username, display_name AS name, grade_level AS kelas,
              current_level, trial_level, paid_basic_up_to_level, paid_premium_up_to_level
       FROM students WHERE id = $1`,
      [student_id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'siswa tidak ditemukan' });
    const student = r.rows[0];
    res.json({ student_id: student.id, student, token: signToken({ sub: student.id, role: 'student' }) });
  } catch (err) {
    console.error('student/login:', err.message);
    res.status(500).json({ error: 'gagal login' });
  }
});

// -- PARENT ---------------------------------------------------------------
// POST /api/auth/parent/register  { name, email?, phone?, password }
router.post('/parent/register', async (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name || typeof name !== 'string' || name.trim().length < 2)
    return res.status(400).json({ error: 'name wajib diisi' });
  if (!email && !phone)
    return res.status(400).json({ error: 'email atau phone wajib diisi salah satu' });
  if (!password || typeof password !== 'string' || password.length < 6)
    return res.status(400).json({ error: 'password wajib diisi (min 6 karakter)' });
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
    if (String(err.message).includes('uq_parents_email') || String(err.message).includes('parents_phone_key'))
      return res.status(409).json({ error: 'email/phone sudah terdaftar' });
    console.error('parent/register:', err.message);
    res.status(500).json({ error: 'gagal mendaftarkan parent' });
  }
});

// POST /api/auth/parent/login  { email?, phone?, password }
router.post('/parent/login', async (req, res) => {
  const { email, phone, password } = req.body || {};
  if ((!email && !phone) || !password)
    return res.status(400).json({ error: 'email/phone + password wajib diisi' });
  try {
    const r = await db.query(
      `SELECT id, display_name, password_hash FROM parents
       WHERE email = $1 OR phone = $1`,
      [email || phone]
    );
    if (r.rowCount === 0) return res.status(401).json({ error: 'kredensial salah' });
    const ok = await bcrypt.compare(password, r.rows[0].password_hash || '');
    if (!ok) return res.status(401).json({ error: 'kredensial salah' });
    res.json({
      parent_id: r.rows[0].id,
      parent: { id: r.rows[0].id, display_name: r.rows[0].display_name },
      token: signToken({ sub: r.rows[0].id, role: 'parent' }),
    });
  } catch (err) {
    console.error('parent/login:', err.message);
    res.status(500).json({ error: 'gagal login' });
  }
});

// POST /api/auth/parent/link-child  { student_id }
router.post('/parent/link-child', verifyToken, requireRole('parent'), async (req, res) => {
  const { student_id } = req.body || {};
  if (!student_id) return res.status(400).json({ error: 'student_id wajib diisi' });
  try {
    const s = await db.query(
      'SELECT id, display_name, current_level, trial_level FROM students WHERE id = $1',
      [student_id]
    );
    if (s.rowCount === 0) return res.status(404).json({ error: 'siswa tidak ditemukan' });
    await db.query(
      'INSERT INTO parent_children (parent_id, student_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.auth.sub, student_id]
    );
    res.json({ ok: true, student: s.rows[0] });
  } catch (err) {
    console.error('parent/link-child:', err.message);
    res.status(500).json({ error: 'gagal menghubungkan akun' });
  }
});

// -- TEACHER --------------------------------------------------------------
// POST /api/auth/teacher/register  { name, email, password, teacher_type }
router.post('/teacher/register', async (req, res) => {
  const { name, email, password, teacher_type } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name + email wajib diisi' });
  if (!password || password.length < 6)
    return res.status(400).json({ error: 'password wajib diisi (min 6 karakter)' });
  if (!['school', 'private'].includes(teacher_type))
    return res.status(400).json({ error: "teacher_type harus 'school' atau 'private'" });
  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const r = await db.query(
      `INSERT INTO teachers (email, display_name, teacher_type, password_hash, is_verified)
       VALUES ($1, $2, $3, $4, FALSE)
       RETURNING id, display_name, email, teacher_type, is_verified`,
      [email.toLowerCase(), name.trim(), teacher_type, hash]
    );
    const teacher = r.rows[0];
    res.status(201).json({
      teacher_id: teacher.id,
      teacher,
      verified: false,
      token: signToken({ sub: teacher.id, role: 'teacher', verified: false }),
    });
  } catch (err) {
    if (String(err.message).includes('teachers_email_key') || String(err.message).includes('duplicate'))
      return res.status(409).json({ error: 'email sudah terdaftar' });
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
      `SELECT id, display_name, teacher_type, is_verified, password_hash
       FROM teachers WHERE email = $1`,
      [String(email).toLowerCase()]
    );
    if (r.rowCount === 0) return res.status(401).json({ error: 'kredensial salah' });
    const t  = r.rows[0];
    const ok = await bcrypt.compare(password, t.password_hash || '');
    if (!ok) return res.status(401).json({ error: 'kredensial salah' });
    res.json({
      teacher_id:   t.id,
      teacher: {
        id:          t.id,
        display_name: t.display_name,
        teacher_type: t.teacher_type,
        verified:    t.is_verified,
      },
      display_name: t.display_name,
      name:         t.display_name,
      teacher_type: t.teacher_type,
      verified:     t.is_verified,
      token: signToken({ sub: t.id, role: 'teacher', verified: t.is_verified }),
    });
  } catch (err) {
    console.error('teacher/login:', err.message);
    res.status(500).json({ error: 'gagal login' });
  }
});

// POST /api/auth/teacher/link-student  { student_id }
router.post('/teacher/link-student', verifyToken, requireRole('teacher'), async (req, res) => {
  try {
    const { student_id } = req.body || {};
    if (!student_id) return res.status(400).json({ error: 'student_id wajib diisi' });
    const s = await db.query(
      'SELECT id, display_name, current_level, trial_level FROM students WHERE id = $1',
      [student_id]
    );
    if (s.rowCount === 0) return res.status(404).json({ error: 'siswa tidak ditemukan' });
    await db.query(
      'INSERT INTO teacher_students (teacher_id, student_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.auth.sub, student_id]
    );
    res.json({ ok: true, student: s.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// -- PARENT GATE ----------------------------------------------------------
// GET /api/auth/parent-gate/challenge
router.get('/parent-gate/challenge', (req, res) => {
  const a = 2 + Math.floor(Math.random() * 8);
  const b = 2 + Math.floor(Math.random() * 8);
  const challengeToken = jwt.sign({ ans: a * b, kind: 'gate_challenge' }, SECRET, { expiresIn: '2m' });
  res.json({ challenge_token: challengeToken, question: `${a} x ${b} = ?` });
});

// POST /api/auth/parent-gate/verify  { challenge_token, answer }
router.post('/parent-gate/verify', (req, res) => {
  const { challenge_token, answer } = req.body || {};
  if (!challenge_token || answer === undefined)
    return res.status(400).json({ error: 'challenge_token + answer wajib' });
  try {
    const payload = jwt.verify(challenge_token, SECRET);
    if (payload.kind !== 'gate_challenge')
      return res.status(401).json({ error: 'challenge tidak valid' });
    if (Number(answer) !== Number(payload.ans))
      return res.status(401).json({ error: 'jawaban salah' });
    res.json({ gate_token: signToken({ kind: 'gate_pass' }, '15m') });
  } catch {
    return res.status(401).json({ error: 'challenge kedaluwarsa' });
  }
});

// GET /api/auth/me
router.get('/me', verifyToken, (req, res) => {
  res.json({ auth: req.auth });
});


// GET /api/auth/teacher/by-code/:code  — public, murid cari guru by kode
router.get('/teacher/by-code/:code', async (req, res) => {
  try {
    const r = await db.query(
      'SELECT id, display_name, teacher_type, teacher_code FROM teachers WHERE teacher_code = $1',
      [req.params.code.toUpperCase().trim()]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Kode guru tidak ditemukan' });
    res.json({ teacher: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/auth/student/link-teacher  { teacher_code }  — butuh JWT student
router.post('/student/link-teacher', verifyToken, requireRole('student'), async (req, res) => {
  try {
    const { teacher_code } = req.body || {};
    if (!teacher_code) return res.status(400).json({ error: 'teacher_code wajib diisi' });
    const t = await db.query(
      'SELECT id, display_name, teacher_type FROM teachers WHERE teacher_code = $1',
      [teacher_code.toUpperCase().trim()]
    );
    if (t.rowCount === 0) return res.status(404).json({ error: 'Kode guru tidak ditemukan' });
    const teacher = t.rows[0];
    await db.query(
      'INSERT INTO teacher_students (teacher_id, student_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [teacher.id, req.auth.sub]
    );
    res.json({ ok: true, teacher });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// TAMBAHKAN DUA ENDPOINT INI di auth.js, tepat sebelum baris: module.exports = router;

// -- DEMO PASSCODE (Client) ------------------------------------------------
// POST /api/auth/demo/redeem  { code }
router.post('/demo/redeem', async (req, res) => {
  const { code } = req.body || {};
  if (!code || String(code).length !== 4)
    return res.status(400).json({ error: 'Passcode harus 4 digit' });
  try {
    const r = await db.query(
      `SELECT id, label, expires_at FROM demo_passcodes
       WHERE code = $1 AND is_active = true AND expires_at > NOW()`,
      [String(code).trim()]
    );
    if (r.rowCount === 0)
      return res.status(404).json({ error: 'Passcode tidak valid atau sudah kadaluarsa' });

    await db.query(
      `UPDATE demo_passcodes SET redeemed_at = NOW(), redeemed_ip = $1
       WHERE id = $2 AND redeemed_at IS NULL`,
      [req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null, r.rows[0].id]
    );

    const expiresAt = new Date(r.rows[0].expires_at);
    const ttlSec    = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000));
    const token = signToken(
      { role: 'demo', kind: 'client_passcode', label: r.rows[0].label || 'Demo' },
      `${ttlSec}s`
    );
    res.json({
      ok: true,
      demo_token: token,
      label:      r.rows[0].label || 'Demo',
      expires_at: r.rows[0].expires_at,
    });
  } catch (err) {
    console.error('demo/redeem:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/demo/admin-token  — pakai x-admin-secret header
router.post('/demo/admin-token', (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: 'unauthorized' });
  const token = signToken({ role: 'demo', kind: 'admin', label: 'Admin Demo' }, '30d');
  res.json({ ok: true, demo_token: token });
});

module.exports = router;

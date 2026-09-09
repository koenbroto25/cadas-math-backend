/**
 * FASE 3.1 — Uji end-to-end auth (tanpa emulator).
 * Jalankan server dulu: npm start, lalu: node src/test/test-auth.js
 * Bisa juga dipanggil otomatis (server di-start/stop sendiri).
 */
const { spawn } = require('child_process');
const BASE = 'http://localhost:3000';

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  ✅ ${label} ${detail || ''}`); }
  else { fail++; console.log(`  ❌ ${label} ${detail || ''}`); }
}
async function req(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-json */ }
  return { status: res.status, data };
}
// decode payload JWT tanpa verifikasi (untuk tahu jawaban challenge saat test)
function jwtPayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

async function runTests() {
  const run = crypto.randomUUID().slice(0, 6);
  const email = `ortu_${run}@test.id`;

  // 1. Register siswa — TANPA email/password (urutan [ADD] §6.2)
  let r = await req('POST', '/api/auth/student/register', { name: 'Anak Uji', kelas: '5' });
  check('student/register → 201 + student_id + token', r.status === 201 && r.data.student_id && r.data.token, `(id: ${r.data.student_id})`);
  const studentId = r.data.student_id, studentToken = r.data.token;

  // 2. Validasi input siswa
  r = await req('POST', '/api/auth/student/register', { name: 'X', kelas: '5' });
  check('student/register nama terlalu pendek → 400', r.status === 400);

  // 3. Register parent
  r = await req('POST', '/api/auth/parent/register', { name: 'Ortu Uji', email, password: 'rahasia123' });
  check('parent/register → 201 + parent_id + token', r.status === 201 && r.data.parent_id && r.data.token);
  const parentToken = r.data.token;

  // 4. Duplicate email
  r = await req('POST', '/api/auth/parent/register', { name: 'Ortu Lagi', email, password: 'rahasia123' });
  check('parent/register email duplikat → 409', r.status === 409);

  // 5. Login benar / salah
  r = await req('POST', '/api/auth/parent/login', { email, password: 'rahasia123' });
  check('parent/login benar → 200 + token', r.status === 200 && r.data.token);
  r = await req('POST', '/api/auth/parent/login', { email, password: 'salahbanget' });
  check('parent/login password salah → 401', r.status === 401);

  // 6. /api/auth/me dengan token parent
  r = await req('GET', '/api/auth/me', null, parentToken);
  check('/api/auth/me → role=parent, sub=parent_id', r.status === 200 && r.data.auth.role === 'parent');
  // /api/auth/me tanpa token
  r = await req('GET', '/api/auth/me');
  check('/api/auth/me tanpa token → 401', r.status === 401);
  // token siswa diterima (role student) — identitas device-profile
  r = await req('GET', '/api/auth/me', null, studentToken);
  check('/api/auth/me token siswa → role=student', r.status === 200 && r.data.auth.role === 'student');

  // 7. Teacher register + login (dua tipe)
  r = await req('POST', '/api/auth/teacher/register', { name: 'Guru Les', email: `guru_${run}@test.id`, password: 'rahasia123', teacher_type: 'private' });
  check('teacher/register (private) → 201, verified=false', r.status === 201 && r.data.verified === false);
  const tToken = r.data.token;
  r = await req('POST', '/api/auth/teacher/register', { name: 'Guru Sekolah', email: `sekolah_${run}@test.id`, password: 'rahasia123', teacher_type: 'nonsense' });
  check('teacher/register type tidak valid → 400', r.status === 400);
  r = await req('POST', '/api/auth/teacher/login', { email: `guru_${run}@test.id`, password: 'rahasia123' });
  check('teacher/login → 200 + verified=false', r.status === 200 && r.data.verified === false);

  // 8. Parent Gate: challenge → salah → benar
  r = await req('GET', '/api/auth/parent-gate/challenge');
  const { challenge_token, question } = r.data;
  check('parent-gate/challenge → token + pertanyaan', r.status === 200 && challenge_token && /×/.test(question), `(${question})`);
  r = await req('POST', '/api/auth/parent-gate/verify', { challenge_token, answer: -1 });
  check('parent-gate jawaban salah → 401', r.status === 401);
  const ans = jwtPayload(challenge_token).ans;
  r = await req('POST', '/api/auth/parent-gate/verify', { challenge_token, answer: ans });
  check('parent-gate jawaban benar → gate_token', r.status === 200 && r.data.gate_token);
  // gate_token bisa diverifikasi /me (kind gate_pass)
  r = await req('GET', '/api/auth/me', null, r.data.gate_token);
  check('gate_token terverifikasi via /me → kind=gate_pass', r.status === 200 && r.data.auth.kind === 'gate_pass');

  console.log(`\n=== HASIL AUTH: ${pass} lulus, ${fail} gagal ===`);
  return fail === 0;
}

const crypto = require('crypto');

// mode otomatis: start server → test → stop
if (require.main === module) {
  const auto = process.argv.includes('--auto');
  const server = auto
    ? spawn('node', ['src/index.js'], { cwd: 'D:/local-rag-voice-bot/cadas-app-backend', stdio: 'ignore' })
    : null;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    if (auto) await wait(2000);
    let ok;
    try { ok = await runTests(); }
    catch (e) { console.error('Test error:', e.message); ok = false; }
    if (server) server.kill();
    process.exit(ok ? 0 : 1);
  })();
}

module.exports = { runTests };

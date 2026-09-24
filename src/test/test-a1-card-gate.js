/**
 * test-a1-card-gate.js — Backtest A1: kartu ID wajib sebelum latihan.
 * Staging: PORT=3002 + CARD_GATE_SINCE=2020-01-01 (siswa uji = "baru").
 *  1. Daftar siswa uji → token student.
 *  2. GET /api/exercises/1?student_id=X → 403 CARD_NOT_SHARED.
 *  3. GET /api/exercises/level-info/1?student_id=X → card_gate.required=true.
 *  4. POST /api/session/start (token) → 403 CARD_NOT_SHARED.
 *  5. PATCH /api/auth/student/card-shared → ok:true.
 *  6. Ulangi 2–4 → 200 (soal / card_gate / session_id).
 *  7. GET /api/exercises/1 tanpa student_id → 200 (fail-open, perilaku lama).
 * Cleanup: hapus study_sessions + students uji.
 */
const PORT = process.env.PORT || 3002;
const BASE = `http://localhost:${PORT}`;
const db = require('../database/db');

let pass = 0, fail = 0;
function logPass(m) { pass++; console.log('  [PASS]', m); }
function logFail(m) { fail++; console.log('  [FAIL]', m); }

async function request(method, path, opt = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opt.token) headers.Authorization = `Bearer ${opt.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

// Unit check murni (tanpa server): kill-switch, cutover, fail-open, legacy.
async function unitChecks() {
  console.log('[0] unit check card-gate.js');
  const g = require('../middleware/card-gate');
  const d = g.cutoverDate();
  if (d instanceof Date && !Number.isNaN(d.getTime())) logPass('cutoverDate valid: ' + d.toISOString());
  else logFail('cutoverDate invalid');
  process.env.CARD_GATE_DISABLED = '1';
  if (g.isDisabled() === true) logPass('CARD_GATE_DISABLED=1 → disabled');
  else logFail('isDisabled tidak membaca env');
  delete process.env.CARD_GATE_DISABLED;
  if (g.isDisabled() === false) logPass('tanpa env → gate aktif');
  else logFail('isDisabled default harus false');
  const errR = await g.getCardGate({ query: async () => { throw new Error('db down'); } }, '9f8b7a6d-1234-4bcd-9abc-1234567890ab');
  if (errR.required === false && errR.reason === 'error') logPass('DB error → fail-open');
  else logFail('fail-open rusak: ' + JSON.stringify(errR));
  const legR = await g.getCardGate({ query: async () => ({ rowCount: 1, rows: [{ card_shared: false, created_at: '2020-05-01T00:00:00Z' }] }) }, '9f8b7a6d-1234-4bcd-9abc-1234567890ab');
  if (legR.required === false && legR.reason === 'legacy') logPass('siswa lama → legacy');
  else logFail('legacy check rusak: ' + JSON.stringify(legR));
}
async function main() {
  await unitChecks();

  const studentId = require('crypto').randomUUID();
  const displayId = 'B' + Math.floor(Math.random() * 9000 + 1000);
  await db.query(
    "INSERT INTO students (id, display_id, name, kelas, parent_phone, current_level, trial_level) VALUES ($1, $2, 'TEST A1 CARD GATE', '3', '081000000001', 1, 1) ON CONFLICT (id) DO NOTHING",
    [studentId, displayId]
  );
  const reg = await request('POST', '/api/auth/student/register', {
    body: { name: 'TEST A1 CARD GATE', kelas: '3', parent_phone: '081000000001' },
  });
  let token = null, sid = studentId;
  if (reg.status === 201 && reg.json && reg.json.token) {
    token = reg.json.token; sid = reg.json.student_id || reg.json.student.id;
  } else {
    const login = await request('POST', '/api/auth/student/login', { body: { display_id: displayId } });
    if (!login.json || !login.json.token) throw new Error('register+login gagal');
    token = login.json.token; sid = login.json.student.id;
  }
  console.log('[1] siswa uji siap:', sid);

  try {
    console.log('[2] GET /api/exercises/1?student_id=X (belum share)');
    const ex = await request('GET', `/api/exercises/1?student_id=${sid}`);
    if (ex.status === 403 && ex.json && ex.json.error === 'CARD_NOT_SHARED') logPass('403 CARD_NOT_SHARED next=' + ex.json.next);
    else logFail('harusnya 403, dapat ' + ex.status + ' ' + JSON.stringify(ex.json));

    console.log('[3] GET /api/exercises/level-info/1?student_id=X');
    const li = await request('GET', `/api/exercises/level-info/1?student_id=${sid}`);
    if (li.status === 200 && li.json && li.json.card_gate && li.json.card_gate.required === true) logPass('card_gate.required=true');
    else logFail('card_gate hilang/salah: ' + li.status + ' ' + JSON.stringify(li.json && li.json.card_gate));

    console.log('[4] POST /api/session/start (belum share)');
    const st = await request('POST', '/api/session/start', { token, body: { level: 1 } });
    if (st.status === 403 && st.json && st.json.error === 'CARD_NOT_SHARED') logPass('403 via token');
    else logFail('harusnya 403, dapat ' + st.status + ' ' + JSON.stringify(st.json));

    console.log('[5] PATCH /api/auth/student/card-shared');
    const sh = await request('PATCH', '/api/auth/student/card-shared', { token, body: { shared_via: 'backtest' } });
    if (sh.status === 200 && sh.json && sh.json.ok === true) logPass('card_shared=true tercatat');
    else logFail('share gagal: ' + sh.status + ' ' + JSON.stringify(sh.json));

    console.log('[6] ulangi setelah share → gate terbuka');
    const ex2 = await request('GET', `/api/exercises/1?student_id=${sid}`);
    if (ex2.status === 200 && Array.isArray(ex2.json.exercises)) logPass('soal terbuka (' + ex2.json.exercises.length + ' soal)');
    else logFail('exercises tertutup: ' + ex2.status + ' ' + JSON.stringify(ex2.json));
    const li2 = await request('GET', `/api/exercises/level-info/1?student_id=${sid}`);
    if (li2.status === 200 && li2.json.card_gate && li2.json.card_gate.required === false && li2.json.card_gate.card_shared === true) logPass('card_gate.required=false, shared=true');
    else logFail('card_gate salah: ' + JSON.stringify(li2.json && li2.json.card_gate));
    const st2 = await request('POST', '/api/session/start', { token, body: { level: 1 } });
    if (st2.status === 200 && st2.json.session_id) logPass('session_id terbit: ' + st2.json.session_id);
    else logFail('session/start gagal: ' + st2.status + ' ' + JSON.stringify(st2.json));

    console.log('[7] GET /api/exercises/1 tanpa student_id');
    const ex3 = await request('GET', '/api/exercises/1');
    if (ex3.status === 200) logPass('200 — jalur tanpa student tidak kena gate');
    else logFail('harusnya 200, dapat ' + ex3.status);

    console.log('\nHASIL: ' + pass + ' pass, ' + fail + ' fail');
  } finally {
    await db.query('DELETE FROM study_sessions WHERE student_id = $1', [sid]).catch(() => {});
    await db.query('DELETE FROM students WHERE id = $1', [sid]).catch(() => {});
    await db.query('DELETE FROM students WHERE id = $1', [studentId]).catch(() => {});
    console.log('[cleanup] siswa uji dihapus');
    process.exit(fail === 0 ? 0 : 1);
  }
}

main().catch((e) => { console.error('A1 BACKTEST FAIL:', e.message); process.exit(1); });

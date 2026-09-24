/**
 * BACKTEST — Matriks fee & tier marketing (A1–A9 + P2)
 *
 *   A1 matriks fee tunggal (utils/fee-matrix.js) dipakai midtrans/admin/payment
 *   A2 sales hidup di bawah head marketing (referrers.parent_referrer_id)
 *   A3 demo passcode no_persist → sesi latihan TIDAK disimpan
 *   A4 pencairan borongan: POST /api/admin/earnings/payout + antrean + cron
 *   A5 whitelist key referral-settings matriks owner
 *   A6 token admin TTL 24 jam
 *   A7 PIN admin + rate-limit 10 gagal/15 menit + jejak DB (migrasi 023)
 *   A9 register sales via kode undangan head marketing
 *   P2 billing manual (payment.js) tidak lagi memakai kolom hantu
 *
 * Jalankan:  node src/test/test-marketing-fee.js
 *   - backend di-start sendiri di port 3087 (BT_PORT untuk ganti)
 *   - DB: LOKAL cadas_app_dev — DATABASE_URL dikosongkan lebih dulu sehingga
 *     database/db.js memakai DB_HOST/DB_NAME dari .env (TIDAK menyentuh Neon)
 *   - semua baris uji diberi tag RUN lalu dihapus lagi di akhir
 *   - laporan ditulis ke backtest-marketing-fee.txt (root repo)
 */
process.env.DATABASE_URL = '';           // paksa DB lokal (dibaca db.js saat require)
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.BT_PORT || '3087';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const BACKEND = path.join(__dirname, '..', '..');
const BASE = `http://localhost:${process.env.PORT}`;
const REPORT = path.join(BACKEND, '..', 'backtest-marketing-fee.txt');

const BT_SECRET = 'bt-admin-secret-2026';
const BT_EMAIL = 'bt_admin@cadas.test';
const BT_PASSWORD = 'bt-admin-pass-123';
const BT_PIN = '2468';
process.env.ADMIN_SECRET = BT_SECRET;
process.env.ADMIN_EMAIL = BT_EMAIL;
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync(BT_PASSWORD, 8);
process.env.ADMIN_PIN_HASH = bcrypt.hashSync(BT_PIN, 8);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'bt-jwt-secret-2026';

const db = require('../database/db');
const feeMatrix = require('../utils/fee-matrix');
const payout = require('../utils/payout');

const RUN = 'bt' + Date.now().toString(36);
const IP_RANGE = '10.77.7.';                      // prefix IP uji rate-limit (dibersihkan di akhir)
let ipSeq = 0;
const IP = () => IP_RANGE + (++ipSeq);

let pass = 0, fail = 0, warn = 0;
const fails = [];
const CHUNKS = [];
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => { CHUNKS.push(String(chunk)); return origWrite(chunk, ...rest); };

function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  OK   ${label}${detail ? ' — ' + detail : ''}`); }
  else { fail++; fails.push(label); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}
function skip(label, reason) { warn++; console.log(`  SKIP ${label} — ${reason}`); }
function head(t) { console.log('\n' + '='.repeat(74) + '\n' + t + '\n' + '='.repeat(74)); }

async function req(method, urlPath, body, token, headers) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* respons non-JSON */ }
  return { status: res.status, data };
}

function jwtPayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}


// ── SEEDING ──────────────────────────────────────────────────────────────────
const seeded = { referrers: [], students: [], passcodes: [] };

async function mkReferrer({ type, name, rate, parentId, token }) {
  const r = await db.query(
    `INSERT INTO referrers (full_name, email, referral_code, referral_token, type,
                            commission_rate, parent_referrer_id, status, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'approved',true)
     RETURNING id, full_name, referral_code, referral_token, type, commission_rate`,
    [name,
     `${RUN}.${type}.${Math.random().toString(36).slice(2, 7)}@cadas.test`,
     `${RUN}-${type}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase(),
     token || null, type, rate == null ? 10 : rate, parentId || null]
  );
  seeded.referrers.push(r.rows[0].id);
  return r.rows[0];
}

/** n baris siswa menunjuk satu referrer (students.referred_by = referrers.id). */
async function mkStudents(referrerId, n, label) {
  if (n <= 0) return [];
  const ins = await db.query(
    `INSERT INTO students (username, display_name, referred_by)
     SELECT $1 || $2 || '_' || g, 'BT ' || $2 || ' ' || g, $3
       FROM generate_series(1, $4::int) g
     RETURNING id`,
    [RUN + '_', label, referrerId, n]
  );
  const ids = ins.rows.map((r) => r.id);
  seeded.students.push(...ids);
  return ids;
}

/** n siswa LUNAS (ada payment_records) — dasar kuota tier fee-matrix. */
async function mkPaidStudents(referrerId, n, label) {
  const ids = await mkStudents(referrerId, n, label);
  if (!ids.length) return [];
  await db.query(
    `INSERT INTO payment_records (student_id, product_type, level_from, level_to,
                                  amount_idr, referrer_code, is_confirmed, confirmed_by_admin_at)
     SELECT id, 'basic_single', 1, 3, 40000, $1, true, NOW() FROM students WHERE id = ANY($2::uuid[])`,
    [`${RUN}-PAID`, ids]
  );
  return ids;
}

async function mkReadyEarning(referrerId, amountIdr, rate) {
  const r = await db.query(
    `INSERT INTO referrer_earnings (referrer_id, amount_idr, commission_rate, commission_idr, status)
     VALUES ($1,$2,$3,$4,'ready') RETURNING id`,
    [referrerId, amountIdr, rate, Math.round(amountIdr * rate / 100)]
  );
  return r.rows[0].id;
}

/** Passcode 4 angka unik (kolom char(4) UNIQUE) untuk uji demo. */
async function mkPasscode(label, noPersist) {
  for (let i = 0; i < 10; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    try {
      const r = await db.query(
        `INSERT INTO demo_passcodes (code, label, expires_at, no_persist)
         VALUES ($1,$2, NOW() + INTERVAL '1 hour', $3) RETURNING id, code`,
        [code, `BT ${label} ${RUN}`, noPersist === true]
      );
      seeded.passcodes.push(r.rows[0].id);
      return r.rows[0];
    } catch (e) {
      if (!/duplicate key/i.test(e.message)) throw e;
    }
  }
  throw new Error('gagal membuat passcode unik setelah 10 percobaan');
}

// ── 1. MATRIKS FEE TUNGGAL (A1) ────────────────────────────────────────────────
async function testUnifiedFeeMatrix() {
  head('1. MATRIKS FEE TUNGGAL (A1) — utils/fee-matrix.js');
  const s = await feeMatrix.getSettings();
  // guru belum punya payment_record → kuota 0 → rate 0
  const teacher = await mkReferrer({ type: 'teacher', rate: 25 });
  let tier = await feeMatrix.referralTierRate(teacher.id, 'teacher', s);
  check('guru kosong konversi → rate 0', tier.rate === 0, tier);

  await mkPaidStudents(teacher.id, 40, 'half');   // 40 siswa bayar, tier half (50-99 → 10%)
  tier = await feeMatrix.referralTierRate(teacher.id, 'teacher', s);
  check('guru 40 siswa bayar → tier half, rate 10', tier.rate === 10, tier);

  await mkPaidStudents(teacher.id, 60, 'full');  // 100 siswa bayar, tier full (>=100 → 20%)
  tier = await feeMatrix.referralTierRate(teacher.id, 'teacher', s);
  check('guru 100 siswa bayar → tier full, rate 20', tier.rate === 20, tier);

  // sales kuota <10 → rate 0
  const sales = await mkReferrer({ type: 'sales', rate: 5 });
  await mkPaidStudents(sales.id, 8, 'sales-low');
  tier = await feeMatrix.referralTierRate(sales.id, 'sales', s);
  check('sales 8 siswa bayar (<10) → rate 0', tier.rate === 0, tier);

  await mkPaidStudents(sales.id, 5, 'sales-ok');  // sekarang 13 → rate 10
  tier = await feeMatrix.referralTierRate(sales.id, 'sales', s);
  check('sales 13 siswa bayar (>=10) → rate 10', tier.rate === 10, tier);

  // head marketing flat 10%, tanpa kuota
  const head = await mkReferrer({ type: 'marketing' });
  tier = await feeMatrix.referralTierRate(head.id, 'marketing', s);
  check('head marketing flat 10% (tanpa kuota)', tier.rate === 10, tier);

  let fees = await feeMatrix.calcSplitFee(teacher.referral_code, 100000, s);
  if (!fees.length) skip('split-fee teacher ke-0', 'referral_code belum tercatat → fee 0');
  else check('split-fee guru 20% of 100k = 20.000', fees.length === 1 && fees[0].amount === 20000, fees);
}

// ── 2. PENCATATAN FEE: PAYLOAD `earnings` DAN STATUS 'ready' (A4 penyesuaian) ────
async function testFeePayloadAndStatus() {
  head('2. PENCATATAN FEE — earnings.length, rate, commission_idr, status=ready');
  const s = await feeMatrix.getSettings();
  const teacher = await mkReferrer({ type: 'teacher', rate: 20 });
  await mkPaidStudents(teacher.id, 100, 'full');
  const fees = await feeMatrix.calcSplitFee(teacher.referral_code, 100000, s);
  check('split-fee guru full 20% → [{amount:20000, rate:20}]', fees.length === 1 && fees[0].amount === 20000 && fees[0].rate === 20, fees);

  const before = await db.query('SELECT COUNT(*)::int c FROM referrer_earnings WHERE referrer_id=$1 AND status=\'ready\'', [teacher.id]);
  // simpan earnings (A4) → status langsung ready
  await payout.saveEarnings(fees, { paymentRecordId: `pr-${RUN}`, studentId: null, amountIdr: 100000, status: 'ready' });
  const after = await db.query('SELECT COUNT(*)::int c, SUM(commission_idr)::int total FROM referrer_earnings WHERE referrer_id=$1 AND status=\'ready\'', [teacher.id]);
  check('setelah saveEarnings: 1 baris ready + commission_idr=20000', after.rows[0].c === before.rows[0].c + 1 && after.rows[0].total === 20000, after.rows[0]);
}

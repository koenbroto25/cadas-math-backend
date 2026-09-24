const crypto = require('crypto');
const db = require('../database/db');

const MAX_ACTIVE_PER_OWNER = 5;
const TTL_MINUTES = 30;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');
}

function makeCode() {
  let code = 'TEST-';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

function redeemUrl(code) {
  return `${process.env.PWA_URL || 'https://cadasmatematika.web.id'}/test/redeem?code=${encodeURIComponent(code)}`;
}

async function assertOwnerIsMarketing(ownerId) {
  if (!ownerId) return;
  const r = await db.query(
    "SELECT id FROM referrers WHERE id=$1::uuid AND type='marketing' AND status='approved' AND is_active=true",
    [ownerId]
  );
  if (!r.rowCount) throw Object.assign(new Error('Owner test ID harus Head Marketing aktif'), { status: 400 });
}

async function createTestAccount({ ownerId = null, createdByAdmin = false, label = null, client = db }) {
  await assertOwnerIsMarketing(ownerId);
  const ownerClause = ownerId ? 'owner_referrer_id=$1::uuid' : 'owner_referrer_id IS NULL';
  const countParams = ownerId ? [ownerId] : [];
  const active = await client.query(
    `SELECT COUNT(*)::int AS n FROM marketing_test_accounts
     WHERE ${ownerClause} AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`,
    countParams
  );
  if ((active.rows[0]?.n || 0) >= MAX_ACTIVE_PER_OWNER) {
    throw Object.assign(new Error('Maksimal 5 test ID aktif per Head Marketing'), { status: 409 });
  }

  for (let i = 0; i < 8; i++) {
    const code = makeCode();
    try {
      const result = await client.query(
        `INSERT INTO marketing_test_accounts
          (code_hash,code_hint,label,owner_referrer_id,created_by_admin,expires_at)
         VALUES ($1,$2,$3,$4::uuid,$5,NOW()+INTERVAL '30 minutes')
         RETURNING id,code_hint,label,owner_referrer_id,created_by_admin,expires_at,created_at`,
        [hashCode(code), code.slice(-4), label || null, ownerId || null, !!createdByAdmin]
      );
      return { test_account: result.rows[0], code, redeem_url: redeemUrl(code), expires_in_minutes: TTL_MINUTES };
    } catch (err) {
      if (err.code !== '23505') throw err;
    }
  }
  throw Object.assign(new Error('Gagal membuat kode test ID unik'), { status: 500 });
}

async function listTestAccounts({ ownerId = null, admin = false } = {}) {
  const params = [];
  let where = '';
  if (!admin) { where = 'WHERE t.owner_referrer_id=$1::uuid'; params.push(ownerId); }
  const r = await db.query(
    `SELECT t.id,t.code_hint,t.label,t.owner_referrer_id,t.created_by_admin,t.expires_at,
            t.used_at,t.revoked_at,t.created_at,r.full_name AS owner_name
     FROM marketing_test_accounts t
     LEFT JOIN referrers r ON r.id=t.owner_referrer_id
     ${where} ORDER BY t.created_at DESC LIMIT 200`, params);
  return r.rows;
}

async function revokeTestAccount({ id, ownerId = null, admin = false }) {
  const params = [id];
  let where = 'id=$1::uuid AND used_at IS NULL';
  if (!admin) { where += ' AND owner_referrer_id=$2::uuid'; params.push(ownerId); }
  const r = await db.query(
    `UPDATE marketing_test_accounts SET revoked_at=NOW() WHERE ${where}
     RETURNING id,revoked_at`, params);
  if (!r.rowCount) throw Object.assign(new Error('Test ID sudah dipakai atau tidak ditemukan'), { status: 409 });
  return r.rows[0];
}

async function redeemTestAccount({ code, ip = null, client = db }) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^TEST-[A-Z0-9]{6}$/.test(normalized)) throw Object.assign(new Error('Format test ID tidak valid'), { status: 400 });
  const result = await client.query(
    `SELECT * FROM marketing_test_accounts WHERE code_hash=$1 FOR UPDATE`, [hashCode(normalized)]);
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error('Test ID tidak ditemukan'), { status: 404 });
  if (row.used_at) throw Object.assign(new Error('Test ID sudah digunakan'), { status: 409 });
  if (row.revoked_at) throw Object.assign(new Error('Test ID telah dicabut'), { status: 410 });
  if (new Date(row.expires_at) < new Date()) throw Object.assign(new Error('Test ID kedaluwarsa'), { status: 410 });
  await client.query('UPDATE marketing_test_accounts SET used_at=NOW(),used_ip=$2 WHERE id=$1', [row.id, ip]);
  return { id: row.id, label: row.label || 'Preview Cadas', owner_referrer_id: row.owner_referrer_id, expires_at: new Date(row.expires_at).toISOString() };
}

module.exports = { MAX_ACTIVE_PER_OWNER, TTL_MINUTES, createTestAccount, listTestAccounts, revokeTestAccount, redeemTestAccount, hashCode };

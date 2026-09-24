const crypto = require('crypto');
const db = require('../database/db');

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function inviteUrl(token) {
  return `${process.env.PWA_URL || 'https://cadasmatematika.web.id'}/partner/invite?token=${encodeURIComponent(token)}`;
}

function validateTarget(type) {
  if (!['school', 'sales'].includes(type)) {
    throw Object.assign(new Error('target_type harus school atau sales'), { status: 400 });
  }
}

async function createInvite({ targetType, inviterId, createdByAdmin, expiresHours = 72 }) {
  validateTarget(targetType);
  if (targetType === 'sales' && !inviterId) {
    throw Object.assign(new Error('Invite sales wajib terhubung ke head marketing'), { status: 400 });
  }
  if (inviterId) {
    const head = await db.query(
      "SELECT id FROM referrers WHERE id=$1::uuid AND type='marketing' AND status='approved' AND is_active=true",
      [inviterId]
    );
    if (!head.rowCount) throw Object.assign(new Error('Inviter bukan head marketing yang aktif'), { status: 400 });
  }
  const token = newToken();
  const hours = Math.min(Math.max(Number(expiresHours) || 72, 1), 168);
  const result = await db.query(
    `INSERT INTO partner_invites
      (token_hash,target_type,inviter_referrer_id,created_by_admin,expires_at)
     VALUES ($1,$2,$3,$4,NOW()+($5 || ' hours')::interval)
     RETURNING id,target_type,expires_at,created_at,created_by_admin,inviter_referrer_id`,
    [tokenHash(token), targetType, inviterId || null, !!createdByAdmin, String(hours)]
  );
  return { invite: result.rows[0], token, invite_url: inviteUrl(token) };
}

async function findValidInvite(token) {
  if (!token) return null;
  const result = await db.query(
    `SELECT i.*, r.full_name AS inviter_name, r.referral_code AS inviter_code
     FROM partner_invites i
     LEFT JOIN referrers r ON r.id=i.inviter_referrer_id
     WHERE i.token_hash=$1 FOR UPDATE`,
    [tokenHash(token)]
  );
  return result.rows[0] || null;
}

function assertUsable(invite) {
  if (!invite) throw Object.assign(new Error('Kode undangan tidak valid'), { status: 404 });
  if (invite.revoked_at) throw Object.assign(new Error('Kode undangan telah dicabut'), { status: 410 });
  if (invite.used_at) throw Object.assign(new Error('Kode undangan sudah digunakan'), { status: 409 });
  if (new Date(invite.expires_at) < new Date()) {
    throw Object.assign(new Error('Kode undangan kedaluwarsa'), { status: 410 });
  }
}

async function consumeInvite(client, token, referrerId) {
  const invite = await client.query(
    `SELECT * FROM partner_invites WHERE token_hash=$1 FOR UPDATE`,
    [tokenHash(token)]
  );
  const row = invite.rows[0];
  assertUsable(row);
  await client.query(
    `UPDATE partner_invites SET used_at=NOW(), used_referrer_id=$2 WHERE id=$1`,
    [row.id, referrerId]
  );
  return row;
}

async function markUsedBy(client, token, referrerId) {
  await client.query(
    `UPDATE partner_invites SET used_referrer_id=$2 WHERE token_hash=$1`,
    [tokenHash(token), referrerId]
  );
}

module.exports = { createInvite, findValidInvite, assertUsable, consumeInvite, markUsedBy, tokenHash, inviteUrl };

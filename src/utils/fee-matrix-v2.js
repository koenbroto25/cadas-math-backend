/**
 * Marketing core fee engine v2.
 * Core only: teacher, referrer/sales, head marketing.
 * Semester/yearly bonuses are intentionally not implemented.
 */
const db = require('../database/db');
const { v4: uuidv4 } = require('uuid');

const num = (s, key, fallback) => {
  const n = Number(s && s[key]);
  return Number.isFinite(n) ? n : fallback;
};
const money = (amount, rate) => Math.round(Number(amount) * Number(rate) / 100);
const canonicalType = (type) => type === 'teacher' ? 'school' : (type === 'sales' ? 'referrer' : type);

async function getSettings() {
  const rows = await db.query('SELECT key, value FROM referral_settings');
  return Object.fromEntries(rows.rows.map((r) => [r.key, r.value]));
}

async function getReferrer(referrerCode) {
  const r = await db.query(
    `SELECT id, type, commission_rate, is_active, parent_referrer_id
     FROM referrers WHERE referral_code=$1 AND status='approved'`,
    [String(referrerCode || '').trim()]
  );
  return r.rows[0] && r.rows[0].is_active ? r.rows[0] : null;
}

async function paidStudentCount(referrerId, windowId = null) {
  const windowClause = windowId ? 'AND COALESCE(pr.confirmed_by_admin_at,pr.created_at) BETWEEN $2 AND $3' : '';
  const params = windowId ? [referrerId, null, null] : [referrerId];
  let from = '', to = null;
  if (windowId) {
    const w = await db.query('SELECT started_at, expires_at FROM referrer_windows WHERE id=$1', [windowId]);
    if (!w.rowCount) return 0;
    from = w.rows[0].started_at; to = w.rows[0].expires_at;
    params[1] = from; params[2] = to;
  }
  const r = await db.query(
    `SELECT COUNT(DISTINCT s.id)::int AS n
     FROM students s JOIN payment_records pr ON pr.student_id=s.id
     WHERE s.referred_by=$1 AND pr.is_confirmed=TRUE ${windowClause}`,
    params
  );
  return r.rows[0]?.n || 0;
}

async function getOrCreateWindow(referrerId, studentId, paymentRecordId, settings) {
  const days = num(settings, 'referrer_window_days', 90);
  const latest = await db.query(
    `SELECT * FROM referrer_windows WHERE referrer_id=$1 ORDER BY started_at DESC LIMIT 1`,
    [referrerId]
  );
  let window = latest.rows[0] || null;
  const now = new Date();
  if (window && window.status === 'open' && new Date(window.expires_at) > now) return window;
  if (window && window.status === 'open') {
    await db.query("UPDATE referrer_windows SET status='expired' WHERE id=$1 AND status='open'", [window.id]);
    window = null;
  }
  let startedAt = new Date();
  if (!latest.rows[0]) {
    const first = await db.query(
      `SELECT MIN(COALESCE(pr.confirmed_by_admin_at,pr.created_at)) AS started_at
       FROM payment_records pr JOIN students s ON s.id=pr.student_id
       WHERE s.referred_by=$1 AND pr.is_confirmed=TRUE`, [referrerId]
    );
    if (first.rows[0]?.started_at) startedAt = new Date(first.rows[0].started_at);
  }
  try {
    const created = await db.query(
      `INSERT INTO referrer_windows(referrer_id,started_from_payment_id,started_at,expires_at,status)
       VALUES ($1,$2,$3,$4,'open') RETURNING *`,
      [referrerId, paymentRecordId || null, startedAt, new Date(startedAt.getTime() + days * 86400000)]
    );
    if (new Date(created.rows[0].expires_at) <= new Date()) {
      await db.query("UPDATE referrer_windows SET status='expired' WHERE id=$1", [created.rows[0].id]);
      created.rows[0].status = 'expired';
    }
    return created.rows[0];
  } catch (err) {
    if (err.code === '23505') {
      const open = await db.query("SELECT * FROM referrer_windows WHERE referrer_id=$1 AND status='open' LIMIT 1", [referrerId]);
      return open.rows[0] || null;
    }
    throw err;
  }
}

function teacherRate(count, s) {
  if (count >= 40) return num(s, 'teacher_tier_40_rate', 20);
  if (count >= 30) return num(s, 'teacher_tier_30_rate', 15);
  if (count >= 20) return num(s, 'teacher_tier_20_rate', 10);
  if (count >= 1) return num(s, 'teacher_tier_1_rate', 5);
  return 0;
}
function referrerRate(count, s) {
  if (count >= 20) return num(s, 'referrer_tier_20_rate', 10);
  if (count >= 10) return num(s, 'referrer_tier_10_rate', 5);
  return 0;
}

async function effectiveTier(referrer, settings, paymentRecordId = null) {
  const type = canonicalType(referrer.type);
  if (type === 'marketing') {
    return { type, rate: num(settings, 'head_marketing_rate', 10), paid: null, window: null, nextRate: null, remaining: null };
  }
  if (type === 'school') {
    const paid = await paidStudentCount(referrer.id);
    const rate = teacherRate(paid, settings);
    const next = paid >= 40 ? 20 : paid >= 30 ? 15 : paid >= 20 ? 10 : 20;
    return { type, rate, paid, window: null, nextRate: paid >= 20 ? (paid >= 30 ? 15 : 10) : 5, remaining: Math.max(0, (paid >= 40 ? 40 : paid >= 30 ? 30 : paid >= 20 ? 20 : 1) - paid), next };
  }
  const window = await getOrCreateWindow(referrer.id, null, paymentRecordId, settings);
  const paid = await paidStudentCount(referrer.id, window?.id || null);
  const rate = referrerRate(paid, settings);
  const target = paid >= 20 ? 20 : paid >= 10 ? 10 : 10;
  return { type, rate, paid, window, nextRate: paid >= 20 ? 10 : paid >= 10 ? 10 : 5, remaining: Math.max(0, target - paid), next: target };
}

async function getHeadMarketingFor(referrer) {
  if (canonicalType(referrer.type) === 'marketing') return referrer;
  if (referrer.parent_referrer_id) {
    const r = await db.query("SELECT id,type,commission_rate,is_active FROM referrers WHERE id=$1 AND type='marketing' AND status='approved' AND is_active=true", [referrer.parent_referrer_id]);
    if (r.rowCount) return r.rows[0];
  }
  const r = await db.query(
    `SELECT r.id,r.type,r.commission_rate,r.is_active
     FROM school_marketing_links sml JOIN referrers r ON r.id=sml.marketing_id
     WHERE sml.school_id=$1 AND sml.is_active=true AND r.is_active=true AND r.status='approved'
     LIMIT 1`, [referrer.id]
  );
  return r.rows[0] || null;
}

function earning(referrerId, type, rate, amount, splitGroupId, extra = {}) {
  return { referrerId, type, rate, amount, splitGroupId, ...extra };
}

async function calcCoreFee(referrerCode, amountIdr, settings, opts = {}) {
  const referrer = await getReferrer(referrerCode);
  if (!referrer) return [];
  const s = settings || await getSettings();
  const tier = await effectiveTier(referrer, s, opts.paymentRecordId || null);
  const group = uuidv4();
  const rows = [];
  if (tier.rate > 0) {
    rows.push(earning(referrer.id, tier.type, tier.rate, money(amountIdr, tier.rate), group, {
      earningType: 'transaction', sourceQuota: tier.paid, windowId: tier.window?.id || null,
    }));
  }
  const head = await getHeadMarketingFor(referrer);
  if (head && head.id !== referrer.id) {
    const hRate = num(s, 'head_marketing_rate', 10);
    rows.push(earning(head.id, 'marketing', hRate, money(amountIdr, hRate), group, {
      earningType: 'transaction', sourceQuota: null, windowId: null,
    }));
  }
  return rows;
}

async function getPriorPayments(referrerId, windowId, currentPaymentId, limit = 500) {
  const params = windowId
    ? [referrerId, limit, windowId, currentPaymentId || null]
    : [referrerId, limit, currentPaymentId || null];
  const windowFilter = windowId
    ? `AND COALESCE(pr.confirmed_by_admin_at,pr.created_at) BETWEEN
         (SELECT started_at FROM referrer_windows WHERE id=$3::uuid)
         AND (SELECT expires_at FROM referrer_windows WHERE id=$3::uuid)`
    : '';
  const currentParam = windowId ? '$4::uuid' : '$3::uuid';
  const r = await db.query(
    `SELECT pr.id, pr.student_id, pr.amount_idr,
            COALESCE(SUM(re.commission_idr) FILTER (WHERE re.status <> 'cancelled'), 0)::int AS already_paid
     FROM payment_records pr
     JOIN students s ON s.id=pr.student_id
     LEFT JOIN referrer_earnings re
       ON re.referrer_id=$1::uuid
      AND (re.payment_record_id=pr.id OR re.source_payment_id=pr.id)
     WHERE s.referred_by=$1::uuid AND pr.is_confirmed=TRUE ${windowFilter}
       AND (${currentParam} IS NULL OR pr.id<>${currentParam})
     GROUP BY pr.id, pr.student_id, pr.amount_idr
     ORDER BY COALESCE(pr.confirmed_by_admin_at,pr.created_at) ASC
     LIMIT $2::int`, params
  );
  return r.rows;
}

async function calcCatchup(referrerCode, settings, opts = {}) {
  const referrer = await getReferrer(referrerCode);
  if (!referrer || opts.skipCatchup) return [];
  const s = settings || await getSettings();
  const tier = await effectiveTier(referrer, s, opts.paymentRecordId || null);
  if (!tier.rate) return [];
  const prior = await getPriorPayments(referrer.id, tier.type === 'referrer' ? tier.window?.id : null, opts.paymentRecordId || null);
  const currentRate = tier.rate;
  const currentPaid = tier.paid;
  const previousPaid = new Set(prior.map((p) => p.student_id)).size;
  const previousRate = tier.type === 'school'
    ? teacherRate(previousPaid, s)
    : referrerRate(previousPaid, s);
  const delta = currentRate - previousRate;
  if (delta <= 0 || !prior.length) return [];
  const group = uuidv4();
  return prior.map((p) => {
    const target = money(p.amount_idr, currentRate);
    const deltaAmount = Math.max(0, target - Number(p.already_paid || 0));
    return { source: p, target, alreadyPaid: Number(p.already_paid || 0), deltaAmount };
  }).filter((x) => x.deltaAmount > 0).map((x) => earning(referrer.id, tier.type, delta, x.deltaAmount, group, {
    earningType: 'quota_catchup', sourceQuota: currentPaid, windowId: tier.window?.id || null,
    sourcePaymentId: x.source.id, sourceStudentId: x.source.student_id, sourceAmountIdr: x.source.amount_idr,
  }));
}

function idempotencyKey(e, ctx) {
  const payment = ctx.paymentRecordId || 'preview';
  if (e.earningType === 'quota_catchup') {
    return `catchup:${e.sourcePaymentId || 'none'}:${e.referrerId}:${e.sourceQuota || 0}:${e.windowId || 'none'}`;
  }
  return `transaction:${payment}:${e.referrerId}`;
}

async function saveEarnings(rows, ctx = {}) {
  const saved = [];
  const status = ctx.status || 'ready';
  for (const e of rows) {
    const key = e.idempotencyKey || idempotencyKey(e, ctx);
    const ins = await db.query(
      `INSERT INTO referrer_earnings
        (referrer_id,payment_record_id,midtrans_invoice_id,student_id,
         amount_idr,commission_rate,commission_idr,split_group_id,referrer_type,
         status,earning_type,source_quota,window_id,idempotency_key,
         source_payment_id,eligible_at,settled_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::int,$6::numeric,$7::int,$8::uuid,$9::text,
               $10::text,$11::text,$12::int,$13::uuid,$14::text,$15::uuid,NOW(),NOW())
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id, referrer_id, commission_idr, status, earning_type`,
      [e.referrerId, ctx.paymentRecordId || null, ctx.midtransInvoiceId || null,
       e.sourceStudentId || ctx.studentId || null, e.sourceAmountIdr || ctx.amountIdr || e.amount,
       e.rate, e.amount, e.splitGroupId || null, e.type, status,
       e.earningType || 'transaction', e.sourceQuota || null, e.windowId || null,
       key, e.sourcePaymentId || null]
    );
    if (!ins.rowCount) continue;
    await db.query(
      `UPDATE referrers SET
         total_earnings_idr=total_earnings_idr+$1::int,
         total_conversions=total_conversions + CASE WHEN $2::text='transaction' THEN 1 ELSE 0 END
       WHERE id=$3::uuid`, [e.amount, e.earningType || 'transaction', e.referrerId]
    );
    saved.push(ins.rows[0]);
  }
  return saved;
}

async function calcSplitFee(referrerCode, amountIdr, settings, opts = {}) {
  const normal = await calcCoreFee(referrerCode, amountIdr, settings, opts);
  const catchup = await calcCatchup(referrerCode, settings, opts);
  return normal.concat(catchup);
}

module.exports = {
  TIERED_TYPES: ['school', 'teacher', 'referrer', 'sales', 'marketing'],
  canonicalType, num, getSettings, getReferrer, paidStudentCount,
  effectiveTier, getHeadMarketingFor, calcCoreFee, calcCatchup, calcSplitFee,
  saveEarnings, money,
};

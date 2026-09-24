/** Read-only marketing dashboard summary; ledger and fee-matrix are source of truth. */
const db = require('../database/db');
const fee = require('../utils/fee-matrix-v2');
const typeName = (t) => t === 'teacher' ? 'school' : t === 'sales' ? 'referrer' : t;
const num = (v) => Number(v || 0);

async function getPartner(id) {
  const r = await db.query(`SELECT id, full_name, email, type, referral_code, referral_token,
    commission_rate, bank_name, bank_account_number, bank_account_name, status, is_active,
    total_clicks, total_conversions, total_earnings_idr, total_transferred_idr,
    parent_referrer_id, created_at FROM referrers WHERE id=$1::uuid`, [id]);
  return r.rows[0] || null;
}

async function openWindow(referrerId) {
  const r = await db.query(`SELECT id, started_at, expires_at, status FROM referrer_windows
    WHERE referrer_id=$1::uuid AND status='open' ORDER BY started_at DESC LIMIT 1`, [referrerId]);
  if (r.rows[0]) return r.rows[0];
  // Legacy/read-only fallback: window bisnis dimulai dari confirmed payment pertama.
  const first = await db.query(`SELECT MIN(COALESCE(p.confirmed_by_admin_at,p.created_at)) AS started_at
    FROM students s JOIN payment_records p ON p.student_id=s.id AND p.is_confirmed=TRUE
    WHERE s.referred_by=$1::uuid
      AND COALESCE(p.confirmed_by_admin_at,p.created_at) >= NOW() - INTERVAL '90 days'`, [referrerId]);
  if (!first.rows[0]?.started_at) return null;
  const startedAt = new Date(first.rows[0].started_at);
  const expiresAt = new Date(startedAt.getTime() + 90 * 86400000);
  if (expiresAt <= new Date()) return null;
  return { id: null, started_at: startedAt, expires_at: expiresAt, status: 'open_derived' };
}

async function directPaid(referrerId, windowId = null) {
  const clause = windowId ? 'AND COALESCE(p.confirmed_by_admin_at,p.created_at) BETWEEN $2 AND $3' : '';
  const params = [referrerId];
  if (windowId) {
    const w = await db.query('SELECT started_at, expires_at FROM referrer_windows WHERE id=$1::uuid', [windowId]);
    if (!w.rowCount) return 0;
    params.push(w.rows[0].started_at, w.rows[0].expires_at);
  }
  const r = await db.query(`SELECT COUNT(DISTINCT s.id)::int n FROM students s
    JOIN payment_records p ON p.student_id=s.id AND p.is_confirmed=TRUE
    WHERE s.referred_by=$1::uuid ${clause}`, params);
  return Number(r.rows[0]?.n || 0);
}

async function directPaidBetween(referrerId, startedAt, expiresAt) {
  const r = await db.query(`SELECT COUNT(DISTINCT s.id)::int n FROM students s
    JOIN payment_records p ON p.student_id=s.id AND p.is_confirmed=TRUE
    WHERE s.referred_by=$1::uuid
      AND COALESCE(p.confirmed_by_admin_at,p.created_at) BETWEEN $2 AND $3`,
    [referrerId, startedAt, expiresAt]);
  return Number(r.rows[0]?.n || 0);
}

async function tierFor(partner, settings) {
  const type = typeName(partner.type);
  if (type === 'marketing') return { type, rate: Number(settings.head_marketing_rate || 10), paid: null, next: null, remaining: null, window: null };
  const window = type === 'referrer' ? await openWindow(partner.id) : null;
  const paid = type === 'referrer'
    ? (window?.id ? await directPaid(partner.id, window.id)
      : window ? await directPaidBetween(partner.id, window.started_at, window.expires_at)
      : 0)
    : await directPaid(partner.id);
  let rate = 0, next = null;
  if (type === 'school') {
    rate = paid >= 40 ? num(settings.teacher_tier_40_rate || 20) : paid >= 30 ? num(settings.teacher_tier_30_rate || 15) : paid >= 20 ? num(settings.teacher_tier_20_rate || 10) : paid >= 1 ? num(settings.teacher_tier_1_rate || 5) : 0;
    next = paid >= 40 ? null : paid >= 30 ? 40 : paid >= 20 ? 30 : 20;
  } else {
    rate = paid >= 20 ? num(settings.referrer_tier_20_rate || 10) : paid >= 10 ? num(settings.referrer_tier_10_rate || 5) : 0;
    next = 20;
  }
  return { type, rate, paid, next, remaining: Math.max(0, next - paid), window };
}

async function ledgerSummary(id) {
  const r = await db.query(`SELECT
    COALESCE(SUM(commission_idr) FILTER (WHERE status<>'cancelled'),0)::int AS total_idr,
    COALESCE(SUM(commission_idr) FILTER (WHERE status='ready'),0)::int AS ready_idr,
    COALESCE(SUM(commission_idr) FILTER (WHERE status='transferred'),0)::int AS transferred_idr,
    COALESCE(SUM(commission_idr) FILTER (WHERE status='cancelled'),0)::int AS cancelled_idr,
    COALESCE(SUM(commission_idr) FILTER (WHERE earning_type='transaction'),0)::int AS normal_idr,
    COALESCE(SUM(commission_idr) FILTER (WHERE earning_type='quota_catchup'),0)::int AS catchup_idr,
    COUNT(*) FILTER (WHERE status<>'cancelled')::int AS earning_count
    FROM referrer_earnings WHERE referrer_id=$1::uuid`, [id]);
  return r.rows[0] || {};
}

async function networkSummary(headId) {
  const p = await db.query(`SELECT DISTINCT r.id,r.full_name,r.type,r.referral_code
    FROM referrers r WHERE r.status='approved' AND r.is_active=true
      AND (r.parent_referrer_id=$1::uuid OR EXISTS
        (SELECT 1 FROM school_marketing_links l WHERE l.marketing_id=$1::uuid AND l.school_id=r.id AND l.is_active=true))
    ORDER BY r.full_name`, [headId]);
  const ids = p.rows.map(x => x.id);
  if (!ids.length) return { partners: [], paid_students: 0, clicks: 0, ledger: { total_idr: 0, ready_idr: 0, transferred_idr: 0 } };
  const s = await db.query(`SELECT COUNT(DISTINCT s.id)::int AS n FROM students s
    JOIN payment_records p ON p.student_id=s.id AND p.is_confirmed=TRUE WHERE s.referred_by=ANY($1::uuid[])`, [ids]);
  const c = await db.query(`SELECT COALESCE(SUM(total_clicks),0)::int AS n FROM referrers WHERE id=ANY($1::uuid[])`, [ids]);
  const l = await db.query(`SELECT COALESCE(SUM(commission_idr) FILTER (WHERE status<>'cancelled'),0)::int AS total_idr,
    COALESCE(SUM(commission_idr) FILTER (WHERE status='ready'),0)::int AS ready_idr,
    COALESCE(SUM(commission_idr) FILTER (WHERE status='transferred'),0)::int AS transferred_idr
    FROM referrer_earnings WHERE referrer_id=ANY($1::uuid[])`, [ids]);
  return { partners: p.rows, paid_students: Number(s.rows[0].n || 0), clicks: Number(c.rows[0].n || 0), ledger: l.rows[0] || {} };
}

async function getPartnerDashboard(id) {
  const partner = await getPartner(id);
  if (!partner) return null;
  const settings = await fee.getSettings();
  const tier = await tierFor(partner, settings);
  const ledger = await ledgerSummary(partner.id);
  const clicks = await db.query('SELECT COUNT(*)::int AS n FROM download_clicks WHERE referrer_id=$1::uuid', [partner.id]);
  const result = {
    partner: { ...partner, effective_rate: tier.rate },
    tier: { type: tier.type, paid: tier.paid, rate: tier.rate, next_target: tier.next, remaining: tier.remaining,
      window: tier.window ? { id: tier.window.id, started_at: tier.window.started_at, expires_at: tier.window.expires_at } : null },
    clicks: Number(clicks.rows[0].n || 0),
    earnings: { total_idr: num(ledger.total_idr), ready_idr: num(ledger.ready_idr), transferred_idr: num(ledger.transferred_idr), cancelled_idr: num(ledger.cancelled_idr), normal_idr: num(ledger.normal_idr), catchup_idr: num(ledger.catchup_idr), count: num(ledger.earning_count) },
  };
  if (tier.type === 'marketing') result.network = await networkSummary(partner.id);
  return result;
}

module.exports = { getPartnerDashboard, getPartner, tierFor, ledgerSummary, networkSummary };

/** Finance domain: cash ledger, fee liability, payout batches, reports, audit. */
const db = require('../database/db');
const crypto = require('crypto');
const n = (v) => Number(v || 0);
const asDate = (v) => { const d = new Date(`${v}T00:00:00.000Z`); return Number.isNaN(d.getTime()) ? null : d; };

function getFilters(q = {}) {
  const f = { from: asDate(q.from), to: asDate(q.to) };
  for (const k of ['partner_id','partner_type','earning_status','earning_type','payment_status','package']) if (q[k]) f[k] = String(q[k]).trim();
  return f;
}
function addWhere(alias, dateColumn, f, params, onlyDates = false) {
  const parts = [];
  if (f.from) { params.push(f.from); parts.push(`${dateColumn} >= $${params.length}::timestamptz`); }
  if (f.to) { params.push(f.to); parts.push(`${dateColumn} < $${params.length}::timestamptz + INTERVAL '1 day'`); }
  if (!onlyDates) {
    if (f.partner_id) { params.push(f.partner_id); parts.push(`${alias}.${alias === 'r' ? 'id' : 'referrer_id'}=$${params.length}::uuid`); }
    if (f.partner_type) { params.push(f.partner_type); parts.push(`${alias}.${alias === 'r' ? 'type' : 'referrer_type'}=$${params.length}::text`); }
    if (f.earning_status) { params.push(f.earning_status); parts.push(`${alias}.status=$${params.length}::text`); }
    if (f.earning_type) { params.push(f.earning_type); parts.push(`${alias}.earning_type=$${params.length}::text`); }
    if (f.payment_status) { params.push(f.payment_status); parts.push(`${alias}.status=$${params.length}::text`); }
    if (f.package) { params.push(f.package); parts.push(`${alias}.product_type=$${params.length}::text`); }
  }
  return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
}

async function recordSettlement(invoice) {
  const r = await db.query(
    `INSERT INTO finance_cash_ledger
     (entry_type,source_type,source_id,external_id,amount_idr,occurred_at,description,metadata)
     VALUES ('settlement','midtrans_invoice',$1::uuid,$2::text,$3::int,COALESCE($4::timestamptz,NOW()),'Midtrans settlement',$5::jsonb)
     ON CONFLICT (source_type,source_id,entry_type) WHERE source_id IS NOT NULL DO NOTHING RETURNING *`,
    [invoice.id, invoice.midtrans_order_id, invoice.amount_idr, invoice.paid_at || null,
      JSON.stringify({ purchase_id: invoice.purchase_id || null, product_type: invoice.product_type })]
  );
  return r.rows[0] || null;
}
async function backfillSettlementLedger() {
  const r = await db.query(`SELECT i.* FROM midtrans_invoices i WHERE i.status='paid'
    AND NOT EXISTS (SELECT 1 FROM finance_cash_ledger l WHERE l.source_type='midtrans_invoice' AND l.source_id=i.id AND l.entry_type='settlement')`);
  let inserted = 0;
  for (const row of r.rows) if (await recordSettlement(row)) inserted++;
  return { scanned: r.rowCount, inserted };
}

async function summary(q = {}) {
  const f=getFilters(q), p=[],e=[],b=[],c=[];
  const payWhere=addWhere('i','COALESCE(i.paid_at,i.created_at)',{from:f.from,to:f.to,payment_status:f.payment_status,package:f.package},p);
  const earnWhere=addWhere('e','e.created_at',{from:f.from,to:f.to,partner_id:f.partner_id,partner_type:f.partner_type,earning_status:f.earning_status,earning_type:f.earning_type},e);
  const batchWhere=addWhere('b','b.created_at',{from:f.from,to:f.to},b,true);
  const cashWhere=addWhere('l','l.occurred_at',{from:f.from,to:f.to},c,true);
  const [pay,earn,batch,cash,partners]=await Promise.all([
    db.query(`SELECT COUNT(*) FILTER(WHERE i.status='paid')::int paid_count,COALESCE(SUM(i.amount_idr) FILTER(WHERE i.status='paid'),0)::bigint gross_settlement_idr,COUNT(*) FILTER(WHERE i.status<>'paid')::int non_paid_count FROM midtrans_invoices i ${payWhere}`,p),
    db.query(`SELECT COALESCE(SUM(e.commission_idr) FILTER(WHERE e.status<>'cancelled'),0)::bigint earned_idr,COALESCE(SUM(e.commission_idr) FILTER(WHERE e.status IN ('pending','ready')),0)::bigint outstanding_idr,COALESCE(SUM(e.commission_idr) FILTER(WHERE e.status='scheduled'),0)::bigint scheduled_idr,COALESCE(SUM(e.commission_idr) FILTER(WHERE e.status='transferred'),0)::bigint transferred_idr,COALESCE(SUM(e.commission_idr) FILTER(WHERE e.status='cancelled'),0)::bigint cancelled_idr,COALESCE(SUM(e.commission_idr) FILTER(WHERE e.status<>'cancelled' AND e.earning_type='transaction'),0)::bigint normal_idr,COALESCE(SUM(e.commission_idr) FILTER(WHERE e.status<>'cancelled' AND e.earning_type='quota_catchup'),0)::bigint catchup_idr FROM referrer_earnings e ${earnWhere}`,e),
    db.query(`SELECT COUNT(*)::int batch_count,COALESCE(SUM(b.total_idr) FILTER(WHERE b.status='scheduled'),0)::bigint scheduled_idr,COALESCE(SUM(b.total_idr) FILTER(WHERE b.status='transferred'),0)::bigint transferred_idr FROM payout_batches b ${batchWhere}`,b),
    db.query(`SELECT COALESCE(SUM(l.amount_idr),0)::bigint signed_delta_idr,COALESCE(SUM(l.amount_idr) FILTER(WHERE l.entry_type='settlement'),0)::bigint settlement_idr,COALESCE(SUM(l.amount_idr) FILTER(WHERE l.entry_type='refund'),0)::bigint refund_idr,COALESCE(SUM(l.amount_idr) FILTER(WHERE l.entry_type='payout'),0)::bigint payout_idr FROM finance_cash_ledger l ${cashWhere}`,c),
    db.query(`SELECT type,COUNT(*)::int count FROM referrers WHERE status='approved' AND is_active=true GROUP BY type ORDER BY type`),
  ]);
  const settlements = pay.rows[0] || {};
  const earnings = earn.rows[0] || {};
  const batches = batch.rows[0] || {};
  const cashLedger = cash.rows[0] || {};
  const earned = n(earnings.earned_idr);
  const outstanding = n(earnings.outstanding_idr);
  const scheduled = n(earnings.scheduled_idr);
  const transferred = n(earnings.transferred_idr);
  const cancelled = n(earnings.cancelled_idr);
  return {
    payments: {
      paid_count: settlements.paid_count || 0,
      gross_settlement_idr: n(settlements.gross_settlement_idr),
      non_paid_count: settlements.non_paid_count || 0,
    },
    cash: {
      signed_delta_idr: n(cashLedger.signed_delta_idr),
      settlement_idr: n(cashLedger.settlement_idr),
      refund_idr: n(cashLedger.refund_idr),
      payout_idr: n(cashLedger.payout_idr),
      available_balance_idr: n(cashLedger.signed_delta_idr) - outstanding - scheduled,
    },
    fees: {
      earned_idr: earned,
      outstanding_idr: outstanding,
      scheduled_idr: scheduled,
      payable_liability_idr: outstanding + scheduled,
      transferred_idr: transferred,
      cancelled_idr: cancelled,
      normal_idr: n(earnings.normal_idr),
      catchup_idr: n(earnings.catchup_idr),
      balance_ok: earned === outstanding + scheduled + transferred,
    },
    payouts: {
      batch_count: batches.batch_count || 0,
      scheduled_idr: n(batches.scheduled_idr),
      transferred_idr: n(batches.transferred_idr),
    },
    partners: partners.rows,
    generated_at: new Date().toISOString(),
  };
}

async function payments(q = {}) {
  const f=getFilters(q),p=[],w=addWhere('i','COALESCE(i.paid_at,i.created_at)',{from:f.from,to:f.to,payment_status:f.payment_status,package:f.package},p);
  return (await db.query(`SELECT i.id,i.midtrans_order_id,i.midtrans_transaction_id,i.status,i.amount_idr,i.product_type,i.payment_type,i.created_at,i.paid_at,i.student_id,i.parent_id,i.purchase_id,s.display_name student_name,pr.id payment_record_id,COALESCE(pr.commission_amount_idr,0)::numeric commission_amount_idr FROM midtrans_invoices i LEFT JOIN students s ON s.id=i.student_id LEFT JOIN payment_records pr ON pr.purchase_id=i.purchase_id ${w} ORDER BY COALESCE(i.paid_at,i.created_at) DESC LIMIT 1000`,p)).rows;
}
async function earnings(q = {}) {
  const f=getFilters(q),p=[],w=addWhere('e','e.created_at',{from:f.from,to:f.to,partner_id:f.partner_id,partner_type:f.partner_type,earning_status:f.earning_status,earning_type:f.earning_type},p);
  return (await db.query(`SELECT e.id,e.referrer_id,r.full_name referrer_name,r.type referrer_type,e.student_id,e.payment_record_id,e.midtrans_invoice_id,e.amount_idr,e.commission_rate,e.commission_idr,e.status,e.earning_type,e.source_payment_id,e.source_quota,e.created_at,e.eligible_at,e.cancelled_at,e.transferred_at FROM referrer_earnings e JOIN referrers r ON r.id=e.referrer_id ${w} ORDER BY e.created_at DESC LIMIT 1000`,p)).rows;
}
async function cancellations(q = {}) { return earnings({...q,earning_status:'cancelled'}); }
async function payouts(q = {}) {
  const f=getFilters(q),p=[],w=addWhere('b','b.created_at',{from:f.from,to:f.to},p,true);
  const batches=(await db.query(`SELECT b.*,COUNT(i.id)::int item_count,COALESCE(SUM(i.amount_idr),0)::bigint item_total_idr FROM payout_batches b LEFT JOIN payout_batch_items i ON i.payout_batch_id=b.id ${w} GROUP BY b.id ORDER BY b.created_at DESC LIMIT 1000`,p)).rows;
  const items=(await db.query(`SELECT i.*,b.batch_code,r.full_name referrer_name FROM payout_batch_items i JOIN payout_batches b ON b.id=i.payout_batch_id JOIN referrers r ON r.id=i.referrer_id ORDER BY i.created_at DESC LIMIT 2000`)).rows;
  return {batches,items};
}
async function audit(q = {}) {
  const f=getFilters(q),p=[],w=addWhere('a','a.created_at',{from:f.from,to:f.to},p,true);
  return (await db.query(`SELECT a.* FROM finance_audit_logs a ${w} ORDER BY a.created_at DESC LIMIT 1000`,p)).rows;
}
async function reconciliation(q = {}) {
  const f=getFilters(q),p=[],w=addWhere('l','l.occurred_at',{from:f.from,to:f.to},p,true);
  const r=await db.query(`SELECT COALESCE(SUM(l.amount_idr),0)::bigint app_balance_idr FROM finance_cash_ledger l ${w}`,p);
  const last=await db.query(`SELECT * FROM finance_reconciliations ORDER BY account_date DESC,created_at DESC LIMIT 1`);
  const app=n(r.rows[0]?.app_balance_idr),row=last.rows[0]||null;
  return {app_balance_idr:app,actual_balance_idr:row?n(row.actual_balance_idr):null,difference_idr:row?app-n(row.actual_balance_idr):null,latest:row};
}
async function recordAudit(actor,action,entityType,entityId,oldValue,newValue,notes) {
  return (await db.query(`INSERT INTO finance_audit_logs(actor_id,actor_role,action,entity_type,entity_id,old_value,new_value,notes) VALUES($1::uuid,$2,$3,$4,$5::uuid,$6::jsonb,$7::jsonb,$8) RETURNING *`,[actor?.id||null,actor?.role||null,action,entityType,entityId||null,oldValue?JSON.stringify(oldValue):null,newValue?JSON.stringify(newValue):null,notes||null])).rows[0];
}
function csvCell(v) { const s=v==null?'':String(v); return /^[=+\-@]/.test(s)?`'${s}`:`"${s.replace(/"/g,'""')}"`; }
function csv(rows) { if(!rows.length)return '\ufeff\r\n'; const keys=Object.keys(rows[0]); return '\ufeff'+[keys.map(csvCell).join(';'),...rows.map(r=>keys.map(k=>csvCell(typeof r[k]==='object'?JSON.stringify(r[k]):r[k])).join(';'))].join('\r\n')+'\r\n'; }


async function createPayoutBatch({earningIds,notes,actor}) {
  if(!Array.isArray(earningIds)||!earningIds.length)throw Object.assign(new Error('earning_ids wajib'),{status:400});
  const client=await db.getClient();
  try{await client.query('BEGIN');
    const lock=await client.query(`SELECT e.*,r.bank_name,r.bank_account_number FROM referrer_earnings e JOIN referrers r ON r.id=e.referrer_id WHERE e.id=ANY($1::uuid[]) AND e.status='ready' FOR UPDATE`,[earningIds]);
    if(lock.rowCount!==earningIds.length)throw Object.assign(new Error('earning tidak semua ready'),{status:409});
    if(lock.rows.some(x=>!x.bank_name||!x.bank_account_number))throw Object.assign(new Error('data bank partner belum lengkap'),{status:409});
    const code=`PAYOUT-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const total=lock.rows.reduce((s,x)=>s+n(x.commission_idr),0),partners=new Set(lock.rows.map(x=>x.referrer_id)).size;
    const b=await client.query(`INSERT INTO payout_batches(batch_code,status,total_idr,partner_count,notes,created_by) VALUES($1,'scheduled',$2,$3,$4,$5::uuid) RETURNING *`,[code,total,partners,notes||null,actor?.id||null]);
    for(const x of lock.rows){await client.query(`INSERT INTO payout_batch_items(payout_batch_id,earning_id,referrer_id,amount_idr,status) VALUES($1::uuid,$2::uuid,$3::uuid,$4::int,'scheduled')`,[b.rows[0].id,x.id,x.referrer_id,x.commission_idr]);await client.query(`UPDATE referrer_earnings SET status='scheduled' WHERE id=$1::uuid`,[x.id]);}
    await client.query('COMMIT');await recordAudit(actor,'payout_scheduled','payout_batch',b.rows[0].id,null,{batch_code:code,total_idr:total,partner_count:partners},notes);
    return {...b.rows[0],items:lock.rows.map(x=>({earning_id:x.id,referrer_id:x.referrer_id,amount_idr:x.commission_idr}))};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
async function markBatchTransferred({batchId,bankReference,notes,actor}) {
  const client=await db.getClient();
  try{await client.query('BEGIN');const b=await client.query(`SELECT * FROM payout_batches WHERE id=$1::uuid FOR UPDATE`,[batchId]);
    if(!b.rowCount)throw Object.assign(new Error('batch tidak ditemukan'),{status:404});if(b.rows[0].status==='transferred'){await client.query('COMMIT');return b.rows[0];}if(b.rows[0].status!=='scheduled')throw Object.assign(new Error('batch tidak scheduled'),{status:409});
    const items=await client.query(`SELECT * FROM payout_batch_items WHERE payout_batch_id=$1::uuid AND status='scheduled' FOR UPDATE`,[batchId]);const total=items.rows.reduce((s,x)=>s+n(x.amount_idr),0);
    for(const x of items.rows)await client.query(`UPDATE referrer_earnings SET status='transferred',transferred_at=NOW() WHERE id=$1::uuid`,[x.earning_id]);
    await client.query(`UPDATE payout_batch_items SET status='transferred',transferred_at=NOW() WHERE payout_batch_id=$1::uuid`,[batchId]);
    await client.query(`UPDATE payout_batches SET status='transferred',bank_reference=$2,transferred_by=$3::uuid,transferred_at=NOW(),notes=COALESCE($4,notes) WHERE id=$1::uuid`,[batchId,bankReference||null,actor?.id||null,notes||null]);
    await client.query(`INSERT INTO finance_cash_ledger(entry_type,source_type,source_id,external_id,amount_idr,occurred_at,bank_reference,description,actor_id,actor_role,metadata) VALUES('payout','payout_batch',$1::uuid,$2::text,$3::int * -1,NOW(),$4,'Fee partner payout',$5::uuid,'admin',$6::jsonb)`,[batchId,b.rows[0].batch_code,total,bankReference||null,actor?.id||null,JSON.stringify({item_count:items.rowCount})]);
    await client.query('COMMIT');await recordAudit(actor,'payout_transferred','payout_batch',batchId,b.rows[0],{status:'transferred',total_idr:total,bank_reference:bankReference},notes);return {...b.rows[0],status:'transferred',bank_reference:bankReference,item_count:items.rowCount};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
async function saveReconciliation({accountName,accountDate,actualBalanceIdr,notes,actor}) {
  if(!accountName||!accountDate||actualBalanceIdr==null)throw Object.assign(new Error('account_name, account_date, actual_balance_idr wajib'),{status:400});
  const current=await reconciliation(),difference=current.app_balance_idr-n(actualBalanceIdr);
  const r=await db.query(`INSERT INTO finance_reconciliations(account_name,account_date,app_balance_idr,actual_balance_idr,difference_idr,status,notes,created_by) VALUES($1,$2::date,$3::bigint,$4::bigint,$5::bigint,$6,$7,$8::uuid) ON CONFLICT(account_name,account_date) DO UPDATE SET app_balance_idr=EXCLUDED.app_balance_idr,actual_balance_idr=EXCLUDED.actual_balance_idr,difference_idr=EXCLUDED.difference_idr,status=EXCLUDED.status,notes=EXCLUDED.notes,created_by=EXCLUDED.created_by,created_at=NOW() RETURNING *`,[accountName,accountDate,current.app_balance_idr,actualBalanceIdr,difference,difference===0?'matched':'needs_reconciliation',notes||null,actor?.id||null]);
  await recordAudit(actor,'bank_reconciled','finance_reconciliation',r.rows[0].id,null,r.rows[0],notes);return r.rows[0];
}
async function cancelEarning({ earningId, reason, actor }) {
  if (!reason || !String(reason).trim()) throw Object.assign(new Error('reason wajib'), { status: 400 });
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT * FROM referrer_earnings WHERE id=$1::uuid FOR UPDATE`, [earningId]);
    if (!r.rowCount) throw Object.assign(new Error('earning tidak ditemukan'), { status: 404 });
    if (r.rows[0].status === 'transferred') throw Object.assign(new Error('earning sudah transferred tidak dapat dibatalkan'), { status: 409 });
    if (r.rows[0].status === 'cancelled') { await client.query('COMMIT'); return r.rows[0]; }
    const updated = await client.query(`UPDATE referrer_earnings
      SET status='cancelled',cancelled_at=NOW(),cancellation_reason=$2,cancelled_by=$3::uuid
      WHERE id=$1::uuid RETURNING *`, [earningId,String(reason).trim(),actor?.id||null]);
    if (r.rows[0].status === 'scheduled') {
      await client.query(`UPDATE payout_batch_items SET status='cancelled'
        WHERE earning_id=$1::uuid AND status='scheduled'`, [earningId]);
    }
    await client.query('COMMIT');
    await recordAudit(actor,'fee_cancelled','referrer_earning',earningId,r.rows[0],updated.rows[0],reason);
    return updated.rows[0];
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}




module.exports = {
  filters:getFilters, summary, payments, earnings, cancellations, payouts, audit, reconciliation,
  recordSettlement, backfillSettlementLedger, createPayoutBatch, markBatchTransferred,
  saveReconciliation, cancelEarning, recordAudit, csv,
  windows: async (q = {}) => {
    const f = getFilters(q), p = [];
    const parts = [];
    if (f.from) { p.push(f.from); parts.push(`w.expires_at >= $${p.length}::timestamptz`); }
    if (f.to) { p.push(f.to); parts.push(`w.expires_at < $${p.length}::timestamptz + INTERVAL '1 day'`); }
    if (f.partner_id) { p.push(f.partner_id); parts.push(`w.referrer_id=$${p.length}::uuid`); }
    const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
    return (await db.query(`SELECT w.*,r.full_name referrer_name,r.type referrer_type FROM referrer_windows w JOIN referrers r ON r.id=w.referrer_id ${where} ORDER BY w.expires_at DESC LIMIT 1000`,p)).rows;
  },
  schedulerRuns: async (limit = 50) => (await db.query('SELECT * FROM finance_scheduler_runs ORDER BY started_at DESC LIMIT $1::int',[Math.min(200,Math.max(1,Number(limit)||50))])).rows,
  runFinanceMaintenance: async ({ windowIds } = {}) => {
    const hasScope = windowIds !== undefined;
    if (hasScope && !Array.isArray(windowIds)) {
      throw Object.assign(new Error('window_ids harus berupa array UUID'), { status: 400 });
    }
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const ids = hasScope ? windowIds.map(String) : [];
    if (ids.some((id) => !UUID_RE.test(id))) {
      throw Object.assign(new Error('window_ids mengandung UUID tidak valid'), { status: 400 });
    }
    const params = hasScope ? [ids] : [];
    const scope = hasScope ? ' AND id=ANY($1::uuid[])' : '';
    const started = await db.query(
      `INSERT INTO finance_scheduler_runs(job_name,status,metadata) VALUES('expire_referrer_windows','running',$1::jsonb) RETURNING *`,
      [JSON.stringify({ scoped_window_ids: hasScope ? ids.length : 0 })]
    );
    try {
      const expired = await db.query(
        `UPDATE referrer_windows SET status='expired'
         WHERE status='open' AND expires_at<=NOW()${scope}
         RETURNING id,referrer_id,started_at,expires_at`,
        params
      );
      for (const w of expired.rows) {
        await recordAudit({id:null,role:'system'}, 'referrer_window_expired', 'referrer_window', w.id, null, w, 'Scheduler finance');
      }
      const done = await db.query(
        `UPDATE finance_scheduler_runs SET status='success',affected_count=$2::int,completed_at=NOW(),metadata=$3::jsonb
         WHERE id=$1::uuid RETURNING *`,
        [started.rows[0].id, expired.rowCount, JSON.stringify({ expired_windows: expired.rowCount, scoped_window_ids: ids.length })]
      );
      return done.rows[0];
    } catch (err) {
      await db.query(
        `UPDATE finance_scheduler_runs SET status='failed',completed_at=NOW(),error_message=$2::text WHERE id=$1::uuid`,
        [started.rows[0].id, err.message]
      ).catch(() => {});
      throw err;
    }
  },
};

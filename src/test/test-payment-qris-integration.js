/** Live QRIS settlement regression: /api/payments/qris + signed webhook + replay. */
process.env.NODE_ENV='test';
require('dotenv').config();
const crypto=require('crypto');
const db=require('../database/db');
const BASE=process.env.PAYMENT_TEST_BASE||'http://localhost:3000';
const KEY=process.env.MIDTRANS_SERVER_KEY||'';
const stamp=Date.now();
let pass=0,fail=0;
const ids={students:[],parents:[],referrers:[]};
function check(label,ok,detail=''){if(ok){pass++;console.log(`[PASS] ${label}${detail?` — ${detail}`:''}`)}else{fail++;console.error(`[FAIL] ${label}${detail?` — ${detail}`:''}`)}}
async function req(method,path,body,token){const r=await fetch(`${BASE}/api${path}`,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json().catch(()=>({}));return{status:r.status,data:d}}
const sign=(id,status,gross)=>crypto.createHash('sha512').update(`${id}${status}${gross}${KEY}`).digest('hex');
async function cleanup(){
  for(const sid of ids.students){const p=await db.query('SELECT id FROM payment_records WHERE student_id=$1',[sid]);for(const x of p.rows)await db.query('DELETE FROM referrer_earnings WHERE payment_record_id=$1 OR source_payment_id=$1',[x.id]).catch(()=>{});for(const t of ['payment_records','midtrans_invoices','purchases','placement_tests','student_trial_usage','student_sessions'])await db.query(`DELETE FROM ${t} WHERE student_id=$1`,[sid]).catch(()=>{});await db.query('DELETE FROM students WHERE id=$1',[sid]).catch(()=>{})}
  for(const pid of ids.parents){await db.query('DELETE FROM purchases WHERE parent_id=$1',[pid]).catch(()=>{});await db.query('DELETE FROM parent_children WHERE parent_id=$1',[pid]).catch(()=>{});await db.query('DELETE FROM parents WHERE id=$1',[pid]).catch(()=>{})}
  for(const rid of ids.referrers){await db.query('DELETE FROM referrer_earnings WHERE referrer_id=$1',[rid]).catch(()=>{});await db.query('DELETE FROM referrer_windows WHERE referrer_id=$1',[rid]).catch(()=>{});await db.query('DELETE FROM referrers WHERE id=$1',[rid]).catch(()=>{})}
}
async function run(){
  const suffix=`${stamp}${crypto.randomBytes(2).toString('hex')}`;const refCode=`MKT${suffix}`.slice(0,32);
  const ref=await db.query(`INSERT INTO referrers(full_name,email,password_hash,referral_code,referral_token,type,commission_rate,status,is_active) VALUES($1,$2,$3,$4,$5,'marketing',10,'approved',true) RETURNING id`,[`QRIS Marketing ${suffix}`,`qrism-${suffix}@test.local`,'x',refCode,`tok-${suffix}`]);ids.referrers.push(ref.rows[0].id);
  const s=await req('POST','/auth/student/register',{name:`QRIS Student ${suffix}`,kelas:4,referral_code:refCode});check('student register',s.status===201,JSON.stringify(s.data));const sid=s.data.student_id,token=s.data.token;ids.students.push(sid);
  const q=await req('POST','/payments/qris',{package:'basic_single'},token);check('QRIS create',q.status===201&&q.data.order_id&&q.data.qr_string,JSON.stringify(q.data));
  const dup=await req('POST','/payments/qris',{package:'basic_single'},token);check('QRIS duplicate returns same order',dup.status===201&&dup.data.order_id===q.data.order_id,`${q.data.order_id}/${dup.data.order_id}`);
  const payload={order_id:q.data.order_id,status_code:'200',gross_amount:'40000.00',signature_key:sign(q.data.order_id,'200','40000.00'),transaction_status:'settlement',fraud_status:'accept',transaction_id:`trx-${suffix}`,payment_type:'qris'};
  const paid=await req('POST','/midtrans/webhook',payload);check('QRIS settlement',paid.status===200&&paid.data.activated===true,JSON.stringify(paid.data));
  const replay=await req('POST','/midtrans/webhook',payload);check('QRIS replay idempotent',replay.status===200&&replay.data.already===true,JSON.stringify(replay.data));
  const earnings=await db.query('SELECT SUM(commission_idr)::int n, COUNT(*)::int c FROM referrer_earnings WHERE student_id=$1',[sid]);check('core head fee 10%',Number(earnings.rows[0].n||0)===4000,JSON.stringify(earnings.rows[0]));
  const access=await req('GET',`/payments/status/${sid}`,undefined,token);check('scope pending before placement',access.status===200&&access.data.scope===null&&access.data.pending_levels===1,JSON.stringify(access.data));
  console.log(`\nQRIS LIVE REGRESSION: ${pass} pass, ${fail} fail`);if(fail)throw new Error('QRIS regression failures');
}
run().catch(e=>{console.error('QRIS LIVE ERROR:',e.message);fail++}).finally(async()=>{await cleanup();console.log('[cleanup] QRIS data removed');process.exit(fail?1:0)});

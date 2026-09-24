/** M1 marketing core fee v2 backtest; all test data cleaned in finally. */
process.env.NODE_ENV='test';
require('dotenv').config();
const db=require('../database/db');
const fee=require('../utils/fee-matrix-v2');
const RUN=`m1_${Date.now().toString(36)}`;
const ids={referrers:[],students:[]};
let pass=0,fail=0,seedSeq=0,partnerSeq=0; const failures=[];
const check=(label,ok,detail='')=>{if(ok){pass++;console.log(`[PASS] ${label}${detail?` — ${detail}`:''}`)}else{fail++;failures.push(label);console.error(`[FAIL] ${label}${detail?` — ${detail}`:''}`)}};
const makeCode=(prefix)=>`${prefix}-${RUN}-${++partnerSeq}`.slice(0,32).toUpperCase();
async function partner(type,parentId=null){
  const referralCode=makeCode(type);
  const r=await db.query(`INSERT INTO referrers(full_name,email,referral_code,referral_token,type,commission_rate,parent_referrer_id,status,is_active) VALUES ($1,$2,$3,$4,$5,10,$6,'approved',true) RETURNING *`,[`M1 ${type}`, `${RUN}.${type}.${partnerSeq}@test.local`, referralCode, `tok-${RUN}-${type}-${partnerSeq}`, type, parentId]);
  ids.referrers.push(r.rows[0].id); return r.rows[0];
}
async function paidStudents(p,count,when=new Date()){
  const seed=`${RUN}_${p.type}_${p.id.slice(0,8)}_${++seedSeq}`; const ins=await db.query(`INSERT INTO students(username,display_name,display_id,referred_by,created_at) SELECT $1||'_'||g,$1||' '||g,substr(md5($1||'_'||g),1,5),$2,$3 FROM generate_series(1,$4::int) g RETURNING id`,[seed,p.id,when,count]);
  ids.students.push(...ins.rows.map(r=>r.id));
  const pay=await db.query(`INSERT INTO payment_records(student_id,product_type,level_from,level_to,amount_idr,payment_method,referrer_code,is_confirmed,confirmed_by_admin_at) SELECT id,'basic_single',1,1,40000,'qris_midtrans',$1,TRUE,$2 FROM students WHERE id=ANY($3::uuid[]) RETURNING id,student_id,amount_idr`,[p.referral_code,when,ins.rows.map(r=>r.id)]);
  return {students:ins.rows.map(r=>r.id),payments:pay.rows};
}
async function cleanup(){
  if(ids.referrers.length){await db.query('DELETE FROM referrer_earnings WHERE referrer_id=ANY($1::uuid[])',[ids.referrers]).catch(()=>{});await db.query('DELETE FROM referrer_windows WHERE referrer_id=ANY($1::uuid[])',[ids.referrers]).catch(()=>{});await db.query('DELETE FROM school_marketing_links WHERE school_id=ANY($1::uuid[]) OR marketing_id=ANY($1::uuid[])',[ids.referrers]).catch(()=>{});}
  if(ids.students.length){await db.query('DELETE FROM payment_records WHERE student_id=ANY($1::uuid[])',[ids.students]).catch(()=>{});await db.query('DELETE FROM students WHERE id=ANY($1::uuid[])',[ids.students]).catch(()=>{});}
  if(ids.referrers.length)await db.query('DELETE FROM referrers WHERE id=ANY($1::uuid[])',[ids.referrers]).catch(()=>{});
}
async function run(){
  const s=await fee.getSettings(); check('settings v2 aktif',s.marketing_fee_v2_enabled==='true');
  const teacher=await partner('school'); const t1=await paidStudents(teacher,1);
  let tier=await fee.effectiveTier(teacher,s,t1.payments[0].id); check('guru 1 -> 5%',tier.paid===1&&tier.rate===5,`paid=${tier.paid} rate=${tier.rate}`);
  const t20=await paidStudents(teacher,19); tier=await fee.effectiveTier(teacher,s,t20.payments[18].id); check('guru 20 -> 10%',tier.paid===20&&tier.rate===10,`paid=${tier.paid} rate=${tier.rate}`);
  const t30=await paidStudents(teacher,10); tier=await fee.effectiveTier(teacher,s,t30.payments[9].id); check('guru 30 -> 15%',tier.paid===30&&tier.rate===15,`paid=${tier.paid} rate=${tier.rate}`);
  const t40=await paidStudents(teacher,10); tier=await fee.effectiveTier(teacher,s,t40.payments[9].id); check('guru 40 -> 20%',tier.paid===40&&tier.rate===20,`paid=${tier.paid} rate=${tier.rate}`);
  const head=await partner('marketing'); const sales=await partner('sales',head.id);
  const r9=await paidStudents(sales,9); let st=await fee.effectiveTier(sales,s,r9.payments[8].id); check('referrer 9 -> 0%',st.rate===0,`rate=${st.rate}`);
  const r10=await paidStudents(sales,1); st=await fee.effectiveTier(sales,s,r10.payments[0].id); check('referrer 10 -> 5%',st.paid===10&&st.rate===5,`paid=${st.paid} rate=${st.rate}`);
  const r20=await paidStudents(sales,10); st=await fee.effectiveTier(sales,s,r20.payments[9].id); check('referrer 20 -> 10%',st.paid===20&&st.rate===10,`paid=${st.paid} rate=${st.rate}`);
  const split=await fee.calcSplitFee(sales.referral_code,40000,s,{paymentRecordId:r20.payments[9].id}); check('sales + head 10%',split.some(r=>r.referrerId===head.id&&r.rate===10),JSON.stringify(split));
  const old=await partner('sales',head.id); const oldDate=new Date(Date.now()-100*86400000); const oldPay=await paidStudents(old,1,oldDate); const oldTier=await fee.effectiveTier(old,s,oldPay.payments[0].id); const newPay=await paidStudents(old,1); const newTier=await fee.effectiveTier(old,s,newPay.payments[0].id); check('window 90 hari expired',oldTier.window.status==='expired'&&newTier.window.id!==oldTier.window.id,`${oldTier.window.id}/${newTier.window.id}`);
  const a=await fee.saveEarnings(split,{paymentRecordId:r20.payments[9].id,studentId:r20.students[9],amountIdr:40000,status:'ready'}); const b=await fee.saveEarnings(split,{paymentRecordId:r20.payments[9].id,studentId:r20.students[9],amountIdr:40000,status:'ready'}); check('earning retry idempotent',a.length>0&&b.length===0,`first=${a.length} second=${b.length}`);
  console.log(`\nM1 CORE FEE BACKTEST: ${pass} pass, ${fail} fail`); if(fail)throw new Error(failures.join('; '));
}
run().catch(e=>{console.error('M1 BACKTEST ERROR:',e.message);fail++;}).finally(async()=>{await cleanup();console.log('[cleanup] M1 test data removed');process.exit(fail?1:0);});

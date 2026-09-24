// Verify boss tables exist in DB (temporary script)
const db = require('../database/db');
(async () => {
  const t = await db.query("SELECT table_name FROM information_schema.tables WHERE table_name IN ('boss_battles','boss_gate_status')");
  console.log('tables:', t.rows.map(r => r.table_name).join(', '));
  const c = await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='boss_battles' ORDER BY ordinal_position");
  console.log('boss_battles cols:', c.rows.map(r => r.column_name).join(','));
  const g = await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='boss_gate_status' ORDER BY ordinal_position");
  console.log('gate cols:', g.rows.map(r => r.column_name).join(','));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

const db = require('./src/database/db');
db.query("SELECT probes FROM placement_tests WHERE status='completed' AND student_id='system-generated' AND placed_level=8 LIMIT 1")
.then(r=>{var probes=r.rows[0].probes;console.log('Type:',typeof probes);console.log('Value:',JSON.stringify(probes).substring(0,300));return db.pool.end();})
.catch(e=>{console.error(e.message);return db.pool.end();});

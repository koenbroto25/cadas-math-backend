// Probe-raw: satu pertanyaan FRESH, dump full JSON response (keys + values)
require('dotenv').config({ path: 'D:/local-rag-voice-bot/cadas-app-backend/.env' });
const axios = require('axios');
const db = require('../database/db');

(async () => {
  const r = await db.query(
    `INSERT INTO students (username, display_name, current_level, paid_premium_up_to_level, premium_activated_at)
     VALUES ('g2_probe_raw', 'G.2 Probe Raw', 3, 15, NOW()) RETURNING id`);
  const sid = r.rows[0].id;
  const Q = 'Berapa dua ditambah tiga dikali sepuluh?';
  console.log('FRESH student:', sid, '| Q:', Q);
  try {
    const res = await axios.post('http://localhost:3000/api/rag/ask', {
      student_id: sid, question_text: Q, level: 3,
    }, { timeout: 180000 });
    console.log('HTTP', res.status);
    console.log('FULL JSON =', JSON.stringify(res.data).slice(0, 600));
  } catch (e) {
    console.log('HTTP ERROR:', e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 300)}` : e.message);
  }
  await db.pool.end();
  process.exit(0);
})();
// Probe: askKak in-process (tanpa HTTP) dengan student fresh → dump output shape
require('dotenv').config({ path: 'D:/local-rag-voice-bot/cadas-app-backend/.env' });
const { Pool } = require('pg');
const askKak = require('../rag/pipeline').askKak;

(async () => {
  const pool = new Pool({ host: 'localhost', port: 5432, user: 'postgres', password: 'postgres', database: 'cadas_app_dev' });
  const r = await pool.query(
    `INSERT INTO students (username, display_name, current_level, paid_premium_up_to_level, premium_activated_at)
     VALUES ('g2_probe_$$', 'G.2 Probe', 3, 15, NOW()) RETURNING id`);
  const sid = r.rows[0].id;

  const Q = 'Bagaimana cara menghitung pecahan?';
  const out = await askKak({ studentId: sid, questionText: Q, conceptId: null, level: 3, accessType: 'premium' });
  console.log('keys         =', Object.keys(out));
  console.log('tier         =', out.tier, '| source =', out.source, '| cached =', out.cached, '| ttsError =', out.ttsError);
  console.log('audioUrl     =', out.audioUrl ? `${out.audioUrl.slice(0, 46)}… len=${out.audioUrl.length}` : 'NULL');
  console.log('visemes      =', out.visemes && out.visemes.mouthCues ? `${out.visemes.mouthCues.length} cue` : 'NULL');
  console.log('answer head  =', (out.answer || '').replace(/\s+/g, ' ').slice(0, 70));

  await pool.query('DELETE FROM students WHERE id = $1', [sid]);
  await pool.end();
  process.exit(0);
})();
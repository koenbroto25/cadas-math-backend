// Probe cache: cek kenapa Q4-Q10 jawab cache (audio/viseme null)
require('dotenv').config({ path: 'D:/local-rag-voice-bot/cadas-app-backend/.env' });
const { Pool } = require('pg');
const pool = new Pool({ host: 'localhost', port: 5432, user: 'postgres', password: 'postgres', database: 'cadas_app_dev' });

(async () => {
  const r = await pool.query(
    `SELECT question_text, source, was_helpful, LEFT(answer_text, 40) AS ans
     FROM student_questions
     WHERE student_id = 'c77b2c1d-cc90-4431-8dbd-aa8bd250ba2b'
     ORDER BY created_at`);
  console.log('student_questions rows:', r.rowCount);
  r.rows.forEach((x, i) => console.log(`  ${i + 1}. [${x.source}] ${x.question_text} → "${x.ans}…" was_helpful=${x.was_helpful}`));
  await pool.end();
  process.exit(0);
})();
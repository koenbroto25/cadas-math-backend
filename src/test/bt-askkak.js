// Backtest AskKak detail — sesuai askkak_bug.md (patch 49d1865)
// Usage: node bt_askkak_tmp.js
require('dotenv').config();
const BASE = 'http://127.0.0.1:3000';
const { Pool } = require('pg');

const log = (...a) => console.log(...a);
const results = [];
const record = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  log(`${cond ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
};

(async () => {
  // 0) Health
  const h = await fetch(BASE + '/api/health').then(r => r.json()).catch(e => ({ err: e.message }));
  record('T0 health database=connected', h && h.database === 'connected', JSON.stringify(h).slice(0, 100));

  // 1) Pilih student uji dari Neon
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = `SELECT id, name, kelas, paid_premium_up_to_level AS prem, paid_basic_up_to_level AS bas, trial_level AS trial
             FROM students ORDER BY created_at DESC LIMIT 30`;
  const rows = (await pool.query(q)).rows;
  await pool.end();
  log(`students sample: ${rows.length}`);
  // trial: student dengan trial_level >= 1 (level uji = trial_level-nya)
  const trial = rows.find(x => x.trial !== null && x.trial >= 1);
  const trialLevel = trial ? trial.trial : null;
  // premium: student dengan paid_premium_up_to_level tertinggi; level uji = min(prem,15)
  const prem = rows.filter(x => x.prem !== null && x.prem >= 1).sort((a, b) => b.prem - a.prem)[0];
  const premLevel = prem ? Math.min(prem.prem, 15) : null;
  log(`trial : ${trial ? trial.id + ' (trial_level=' + trial.trial + ')' : 'NONE'}`);
  log(`premium: ${prem ? prem.id + ' (premium_up_to=' + prem.prem + ', uji level ' + premLevel + ')' : 'NONE'}`);

  const post = async (body) => {
    const t0 = Date.now();
    try {
      const res = await fetch(BASE + '/api/rag/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      return { status: res.status, ms: Date.now() - t0, j };
    } catch (e) {
      return { status: 0, ms: Date.now() - t0, err: e.message };
    }
  };

  // T1 UUID invalid -> 400 INVALID_STUDENT_ID
  let t = await post({ student_id: 'test-siswa-001', question_text: '1 tambah 2', level: 1 });
  record('T1 invalid UUID -> 400', t.status === 400 && t.j && t.j.error === 'INVALID_STUDENT_ID',
    `status=${t.status} error=${t.j && t.j.error}`);

  // T2/T2b trial — uji Layer 1 lexical dengan level yang sesuai materi (level 1, tambah)
  if (trial) {
    const uq = `Kakak, berapa 1 tambah 2? jelaskan ya [bt-${Date.now()}]`;
    t = await post({ student_id: trial.id, question_text: uq, level: 1 });
    record('T2 trial new -> 200, source != none-or-llm-fail',
      t.status === 200 && t.j.source && t.j.source !== 'none',
      `status=${t.status} ms=${t.ms} source=${t.j.source} cached=${t.j.cached} answer="${(t.j.answer || '').slice(0, 60)}"`);
    const t2b = await post({ student_id: trial.id, question_text: uq, level: trialLevel });
    record('T2b trial cache hit', t2b.status === 200 && t2b.j.cached === true,
      `status=${t2b.status} cached=${t2b.j.cached} ms=${t2b.ms}`);
  } else {
    log('SKIP T2/T2b (tidak ada student trial)');
  }

  // T3/T3b premium (TTS path)
  if (prem) {
    const pq = `Buatkan satu soal cerita perkalian 6 kali 7 untuk anak SD, lalu jawab [bt-${Date.now()}]`;
    t = await post({ student_id: prem.id, question_text: pq, level: premLevel });
    record('T3 premium new -> 200 <35s, audio ada atau ttsError',
      t.status === 200 && t.ms < 35000 && (t.j.audioUrl || t.j.ttsError === true),
      `status=${t.status} ms=${t.ms} source=${t.j.source} audioUrl=${t.j.audioUrl ? Math.round((t.j.audioUrl.length || 0)) + 'ch' : 'null'} ttsError=${t.j.ttsError}`);
    const t3b = await post({ student_id: prem.id, question_text: pq, level: premLevel });
    record('T3b premium cache + audioUrl persist',
      t3b.status === 200 && t3b.j.cached === true,
      `status=${t3b.status} cached=${t3b.j.cached} audioUrl=${t3b.j.audioUrl ? 'ada' : 'null'} ms=${t3b.ms}`);
  } else {
    log('SKIP T3/T3b (tidak ada student premium di sample 20 terakhir)');
  }

  // Ringkasan
  const fail = results.filter(r => !r.pass);
  log('===============================');
  log(`ASKKAK BACKTEST: ${results.length - fail.length}/${results.length} PASS`);
  log(fail.length === 0 ? 'ASKKAK_BACKTEST_PASSED' : 'ASKKAK_BACKTEST_FAILED: ' + fail.map(f => f.name).join(', '));
  process.exit(fail.length === 0 ? 0 : 1);
})().catch(e => { log('FATAL:', e.message); process.exit(2); });

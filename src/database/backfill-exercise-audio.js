/**
 * Fase voice 2 — Backfill cache TTS per-soal (BERTAHAP & RESUMABLE).
 *
 * Memindai audio/speech/cache/ di speed-math-master dan mencatat file
 * {source_id}_hint.wav / {source_id}_trick.wav yang SUDAH ada ke tabel
 * exercise_audio. Jalankan ulang kapan pun precache bertambah —
 * file baru akan tercakup, yang lama di-skip via upsert.
 *
 * Usage: node src/database/backfill-exercise-audio.js
 */
const fs = require('fs');
const path = require('path');
const DST = new (require('pg').Pool)({ user: 'postgres', password: 'postgres', database: 'cadas_app_dev' });

const CACHE_DIR = path.join('D:', 'local-rag-voice-bot', 'speed-math-master', 'audio', 'speech', 'cache');

async function main() {
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.wav'));
  let hint = 0, trick = 0;

  // kumpulkan pasangan per source_id, insert massal per chunk
  const rows = [];
  for (const f of files) {
    const m = /^(.+)_hint\.wav$/.exec(f);
    if (m) { rows.push([m[1], 'hint', `/audio/speech/cache/${f}`]); hint++; continue; }
    const t = /^(.+)_trick\.wav$/.exec(f);
    if (t) { rows.push([t[1], 'trick', `/audio/speech/cache/${f}`]); trick++; }
  }

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    let p = 0;
    for (const [sid, kind, url] of chunk) {
      values.push(`($${++p},$${++p},$${++p},TRUE)`);
      params.push(sid, kind, url);
    }
    await DST.query(
      `INSERT INTO exercise_audio (exercise_source_id, kind, audio_url, file_exists)
       VALUES ${values.join(',')}
       ON CONFLICT (exercise_source_id, kind) DO UPDATE SET
         audio_url = EXCLUDED.audio_url,
         file_exists = TRUE`,
      params
    );
  }

  // statistik cakupan vs total soal di cadas
  const tot = await DST.query('SELECT COUNT(*)::int AS n FROM exercises');
  const cov = await DST.query(
    `SELECT COUNT(DISTINCT exercise_source_id)::int AS n FROM exercise_audio ea
     JOIN exercises e ON e.source_id = ea.exercise_source_id`
  );
  console.log(`Dipindai: ${hint} hint + ${trick} trick = ${rows.length} file`);
  console.log(`Cakupan soal (hint atau trick): ${cov.rows[0].n}/${tot.rows[0].n}` +
    ` (${((cov.rows[0].n / tot.rows[0].n) * 100).toFixed(1)}%)`);
}

main()
  .then(() => DST.end())
  .catch((e) => { console.error('Backfill GAGAL:', e.message); DST.end(); process.exit(1); });

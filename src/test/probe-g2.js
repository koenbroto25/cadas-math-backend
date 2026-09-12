// Probe: raw response /api/rag/ask untuk teks panjang vs pendek — dump penuh
require('dotenv').config({ path: 'D:/local-rag-voice-bot/cadas-app-backend/.env' });
const axios = require('axios');
const db = require('../database/db');
const SID = 'c77b2c1d-cc90-4431-8dbd-aa8bd250ba2b';

const QS = [
  { label: 'SHORT', q: 'Berapa hasil dari 47 dikali 83?' },
  { label: 'LONG ', q: 'Baik, ayo kita belajar cara pengurangan bersusun! Pengurangan bersusun adalah cara untuk mengurangi angka yang dua digit atau lebih, ditulis vertikal sejajar. Kita mulai dari kolom paling kanan, yaitu kolom unit. Jika angka di atas lebih kecil dari angka di bawah, kita perlu burow dari kolom sebelah kiri. Terus, turun angka berpuluh dan ditambah sepuluh ke unit. Selesai, kita pengurangan dari kanan ke kiri sampai selesai semua kolom.' },
];

(async () => {
  for (const { label, q } of QS) {
    const t0 = Date.now();
    try {
      const res = await axios.post('http://localhost:3000/api/rag/ask', {
        student_id: SID, question_text: q, level: 3,
      }, { timeout: 120000 });
      const d = res.data;
      console.log(`\n### ${label} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      console.log('keys        =', Object.keys(d));
      console.log('tier        =', d.tier, '| source =', d.source, '| ttsError =', d.ttsError, '| cached =', d.cached);
      console.log('audioUrl    =', d.audioUrl ? `${d.audioUrl.slice(0, 40)}... len=${d.audioUrl.length}` : 'NULL');
      console.log('visemes     =', d.visemes && d.visemes.mouthCues ? `${d.visemes.mouthCues.length} cue` : 'NULL');
      console.log('answer head =', (d.answer || '').slice(0, 60));
    } catch (e) {
      console.log(`\n### ${label} ERROR ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      console.log('  ', e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}` : e.message);
    }
  }
  await db.pool.end();
  process.exit(0);
})();
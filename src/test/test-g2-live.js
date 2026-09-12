/**
 * Sprint G.2 — LIVE backtest premium lip-sync (Gemini 2.5 Flash Preview TTS).
 * Run (server harus jalan): node src/test/test-g2-live.js
 *
 * 10 pertanyaan, 3 kategori:
 *  - A. Terkait materi level   (4): diharap kena lexical/semantic cache materi
 *  - B. Soal matematika di luar materi (4): diharap OpenRouter LLM (premium)
 *  - C. Tidak relevan          (2): diharap LLM generik / fallback
 *
 * Setiap jawaban dicek: audio (data:audio/wav), visemes non-null,
 * mouthCues non-kosong, durasi viseme ≈ durasi audio, distribusi nilai.
 */

const axios = require('axios');
const db = require('../database/db');

const BASE = `http://localhost:${process.env.PORT || 3000}`;
let TEST_USER = 'g2_lip_sync_tester';
// Sprint G.2 — fresh student per run: cache/race tanga bisa pollutan hasil.
(() => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  TEST_USER = `g2_lip_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
})();
const LEVEL = 3;

const QUESTIONS = [
  // A. Terkait materi (Level 3: perkalian dasar, pembagian, pengurangan bertingkat, pecahan)
  { cat: 'A-materi',      q: 'Apa itu perkalian?' },
  { cat: 'A-materi',      q: 'Jelaskan cara pengurangan bersusun' },
  { cat: 'A-materi',      q: 'Apa itu pembagian?' },
  { cat: 'A-materi',      q: 'Bagaimana cara menghitung pecahan?' },
  // B. Soal matematika di luar materi (tidak ada di materi level manapun)
  { cat: 'B-luar-materi', q: 'Berapa hasil dari 47 dikali 83?' },
  { cat: 'B-luar-materi', q: 'Ibu membeli 3 kilogram gula seharga 42 ribu rupiah, berapa harga per kilogramnya?' },
  { cat: 'B-luar-materi', q: 'Jika x ditambah 7 sama dengan 15, berapa nilai x?' },
  { cat: 'B-luar-materi', q: 'Sebuah persegi panjang panjangnya 12 cm dan lebarnya 8 cm, berapa kelilingnya?' },
  // C. Tidak relevan
  { cat: 'C-relevan-no',  q: 'Siapa nama presiden pertama Indonesia?' },
  { cat: 'C-relevan-no',  q: 'Ceritakan dongeng tentang naga untukku!' },
];

async function ensurePremiumStudent() {
  // Dedicated test student dengan akses premium penuh (level 1-15)
  await db.query(
    `INSERT INTO students (username, display_name, current_level, paid_premium_up_to_level, premium_activated_at)
     VALUES ($1, $2, $3, 15, NOW())
     ON CONFLICT (username) DO UPDATE SET paid_premium_up_to_level = 15, premium_activated_at = NOW()`,
    [TEST_USER, 'G.2 Lip-Sync Tester', LEVEL]
  );
  const r = await db.query('SELECT id FROM students WHERE username = $1', [TEST_USER]);
  return r.rows[0].id;
}

function preview(s, n = 90) {
  if (!s) return '';
  return s.replace(/\s+/g, ' ').slice(0, n) + (s.length > n ? '…' : '');
}

// ── Clean state: purge cache jawaban lama agar 10/10 jalan penuh (audio+viseme)
(async () => {
  console.log(`Backend: ${BASE}`);
  const studentId = await ensurePremiumStudent();
  await db.query('DELETE FROM student_questions WHERE student_id = $1', [studentId]);
  await db.query('DELETE FROM student_level_quota WHERE student_id = $1', [studentId]);
  console.log(`Test student premium: ${TEST_USER} (${studentId}) — cache & quota terreset\n`);

  const results = [];
  let qi = 0;
  for (const { cat, q, conceptId } of QUESTIONS) {
    qi++;
    if (qi > 1) {
      // Sprint G.2 — throttle 8s: free-tier Gemini limiet ±10 TTS/min/key.
      await new Promise((r) => setTimeout(r, 8000));
    }
    const t0 = Date.now();
    let row = {};
    try {
      const res = await axios.post(`${BASE}/api/rag/ask`, {
        student_id: studentId,
        question_text: q,
        concept_id: conceptId,
        level: LEVEL,
      }, { timeout: 180000 });
      row = res.data || {};
    } catch (err) {
      row = { error: err.response?.data?.error || err.message };
    }
    const dt = ((Date.now() - t0) / 1000).toFixed(1);

    const vis = row.visemes || null;
    const cues = vis && Array.isArray(vis.mouthCues) ? vis.mouthCues : null;
    const durVis = cues && cues.length ? cues[cues.length - 1].end : 0;
    const isAudio = typeof row.audioUrl === 'string' && row.audioUrl.startsWith('data:audio/wav');
    const kbAudio = isAudio ? Math.round(row.audioUrl.length * 0.75 / 1024) : 0;

    // Distribusi durasi per nilai viseme
    const dist = {};
    if (cues) {
      for (const c of cues) dist[c.value] = +((dist[c.value] || 0) + (c.end - c.start)).toFixed(2);
    }

    results.push({
      cat, q, dt,
      ok: !!row.error ? false : true,
      error: row.error || null,
      source: row.source || null,
      tier: row.tier || null,
      ttsError: !!row.ttsError,
      audio: isAudio ? `${kbAudio} KB` : 'TIDAK',
      visemes: cues ? `${cues.length} cue` : 'null',
      durVis: +durVis.toFixed(2),
      dist,
      answer: preview(row.answer || ''),
    });

    console.log(`[${cat}] ${q}`);
    console.log(`  → source=${row.source || '-'} tier=${row.tier || '-'} ${dt}s | audio=${isAudio ? kbAudio + 'KB' : 'TIDAK'} | visemes=${cues ? cues.length + ' cue (≈' + durVis.toFixed(1) + 's)' : 'NULL'}${row.ttsError ? ' | ttsError' : ''}`);
    console.log(`  → "${preview(row.answer || row.error || '', 110)}"`);
    if (cues) console.log(`  → distribusi: ${JSON.stringify(dist)}`);
    console.log('');
  }

  // ── Ringkasan
  const noAudio = results.filter(r => r.audio === 'TIDAK').length;
  const noVis = results.filter(r => r.visemes === 'null').length;
  const ttsErr = results.filter(r => r.ttsError).length;
  console.log('════════ RINGKASAN BACKTEST ════════');
  console.log(`Total: ${results.length} | audio OK: ${results.length - noAudio} | visemes OK: ${results.length - noVis} | ttsError: ${ttsErr}`);

  const fs2 = require('fs');
  const out = 'D:\\local-rag-voice-bot\\cadas-app-backend\\src\\test\\backtest-g2-report.json';
  fs2.writeFileSync(out, JSON.stringify({ timestamp: new Date().toISOString(), model: 'gemini-2.5-flash-preview-tts', summary: { total: results.length, noAudio, noVis, ttsErr }, results }, null, 2));
  console.log(`Report JSON: ${out}`);

  process.exit(0);
})();
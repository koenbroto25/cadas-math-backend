#!/usr/bin/env node
/**
 * generate-visemes.js — batch Rhubarb lip-sync untuk semua .wav di audio/speech/cache
 *
 * Sumber:  speed-math-master/audio/speech/cache/{nama}.wav   (9.771 file hint/trick)
 * Output:  speed-math-master/audio/speech/cache/visemes/{nama}.json
 *          (format mouthCues Rhubarb — sama dengan gemini/visemes/, tersaji otomatis
 *           via static mount /audio di backend)
 *
 * Resume-able: JSON yang sudah ada dilewati — aman dijalankan ulang kapan saja.
 * Usage: node scripts/generate-visemes.js [concurrency=4]
 *
 * Estimasi: ~10 dtk/file per proses → ±7 jam pada concurrency 4 (sekali jalan saja,
 * file yang sudah jadi tidak diulang).
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const SPEED_MASTER = path.resolve(__dirname, '..', '..', 'speed-math-master');
const RHUBARB = path.join(
  SPEED_MASTER, 'tools', 'rhubarb', 'Rhubarb-Lip-Sync-1.14.0-Windows', 'rhubarb.exe'
);
const CACHE_DIR = path.join(SPEED_MASTER, 'audio', 'speech', 'cache');
const OUT_DIR = path.join(CACHE_DIR, 'visemes');
const CONCURRENCY = Math.max(1, parseInt(process.argv[2] || '6', 10));

if (!fs.existsSync(RHUBARB)) {
  console.error('[viseme] rhubarb.exe tidak ditemukan:', RHUBARB);
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

const wavs = fs.readdirSync(CACHE_DIR).filter((f) => f.toLowerCase().endsWith('.wav'));
const pending = wavs.filter((f) => {
  const out = path.join(OUT_DIR, f.replace(/\.wav$/i, '.json'));
  return !fs.existsSync(out);
});

console.log(
  `[viseme] total wav: ${wavs.length} | sudah ada: ${wavs.length - pending.length} | diproses: ${pending.length} | concurrency: ${CONCURRENCY}`
);

if (pending.length === 0) {
  console.log('[viseme] Semua viseme sudah ada — selesai.');
  process.exit(0);
}

let idx = 0;
let done = 0;
let fail = 0;
let active = 0;
const t0 = Date.now();

function next() {
  if (idx >= pending.length) {
    active -= 1;
    if (active === 0) {
      const mins = Math.round((Date.now() - t0) / 60000);
      console.log(`[viseme] SELESAI — ${done} ok, ${fail} gagal, ${mins} menit. Output: ${OUT_DIR}`);
    }
    return;
  }
  const file = pending[idx++];
  const out = path.join(OUT_DIR, file.replace(/\.wav$/i, '.json'));
  execFile(
    RHUBARB,
    ['-f', 'json', '--extendedShapes', 'GX', '--threads', '1', '-q', '-o', out, path.join(CACHE_DIR, file)],
    (err) => {
      if (err || !fs.existsSync(out)) {
        fail += 1;
        console.warn(`[viseme] GAGAL ${file}: ${(err && err.message) || 'output tidak dibuat'}`);
      } else {
        done += 1;
        if (done % 50 === 0) {
          const rate = done / ((Date.now() - t0) / 1000);
          const remaining = pending.length - done - fail;
          console.log(
            `[viseme] ${done}/${pending.length} ok | ${fail} gagal | ETA ~${Math.round(remaining / rate / 60)} menit`
          );
        }
      }
      next();
    }
  );
}

for (let i = 0; i < Math.min(CONCURRENCY, pending.length); i += 1) {
  active += 1;
  next();
}

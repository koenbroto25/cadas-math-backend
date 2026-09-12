#!/usr/bin/env node
/**
 * regen-corrupt44.js — Regenerasi 44 WAV corrupt (Invalid data) di speech/cache
 * via Gemini TTS + viseme, lalu verifikasi ffprobe otomatis.
 * Adaptasi dari run-gemini-regen.js (terbukti stabil), dengan:
 *  1. Target = daftar hardcoded 44 file corrupt (bukan wav-quality-report.json)
 *  2. FORCE overwrite: file corrupt dihapus dulu (tidak di-skip seperti resume mode)
 *  3. Verifikasi ffprobe + retry sekali utk transient error
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const db = require('../src/database/db');
const tts = require('../src/rag/gemini-tts');

const SPEED_ROOT = 'D:\\local-rag-voice-bot\\speed-math-master';
const CACHE = path.join(SPEED_ROOT, 'audio', 'speech', 'cache');
const VISEMES = path.join(CACHE, 'visemes');
const LOG_FILE = path.join(SPEED_ROOT, 'audio', 'speech', 'regen_corrupt44.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ffprobe exit code 0 = WAV valid
function ffprobeOk(wavPath) {
  try {
    execFileSync('ffprobe', ['-v', 'error', '-i', wavPath], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

// 44 file corrupt — di-parse jadi {src, kind}
const CORRUPT44 = [
  'L10_P2_023_hint','L10_P2_028_hint','L10_P2_045_hint','L10_P2_049_hint','L10_P2_050_hint',
  'L10_P2_059_hint','L10_P2_061_hint','L10_P2_062_hint','L10_P2_086_hint','L10_P2_087_hint',
  'L10_P2_098_hint','L10_P3_015_trick','L10_P3_073_trick','L10_P3_074_trick','L10_P3_080_trick',
  'L11_P2_039_trick','L11_P2_043_trick','L11_P2_054_trick','L11_P2_085_trick','L12_P1_072_hint',
  'L15_P4_035_hint','L15_P4_084_hint','L1_P1_075_hint','L1_P1_188_hint','L1_P1_190_hint',
  'L1_P1_224_hint','L1_P1_238_hint','L1_P1_239_hint','L1_P1_242_hint','l2_lvl2_020_hint',
  'L4_P1_033_hint','L4_P1_035_trick','L4_P1_038_hint','L4_P1_041_trick','L5_P1_041_trick',
  'L5_P1_066_trick','L5_P1_071_trick','L5_P1_080_trick','L5_P1_098_trick','L5_P1_099_trick',
  'L5_P4_068_hint','L6_P1_049_hint','L9_P5_052_hint','L9_P5_091_hint',
].map((name) => {
  const i = name.lastIndexOf('_');
  return { src: name.slice(0, i), kind: name.slice(i + 1) };
});

const TTS_TIMEOUT_MS = parseInt(process.env.TTS_TIMEOUT_MS || '180000', 10);
const REQUEST_DELAY_MS = parseInt(process.env.REQUEST_DELAY_MS || '3000', 10);

async function main() {
  log('=== Regenerasi 44 WAV Corrupt (FORCE MODE + ffprobe verify) ===');

  // Muat API key dari .env (pola sama dgn run-gemini-regen.js)
  const envPath = path.join(__dirname, '../.env');
  const envContent = fs.readFileSync(envPath, 'utf8');
  const manualKeys = [];
  for (let i = 1; i <= 250; i++) {
    const match = envContent.match(new RegExp(`GOOGLE_API_KEY_${i}="?([^"\\n]+)"?`));
    if (match) manualKeys.push(match[1].trim());
  }
  tts.apiKeys = manualKeys;
  log(`Model Gemini TTS: ${tts.model}`);
  log(`Jumlah API Key Gemini yang aktif: ${tts.apiKeys.length}`);

  const targets = CORRUPT44;
  log(`Total target: ${targets.length}`);

  const srcIds = [...new Set(targets.map((t) => t.src))];
  const exRes = await db.query(
    'SELECT source_id, hint_text, speech_text, quick_trick FROM exercises WHERE source_id = ANY($1)',
    [srcIds],
  );
  const exMap = {};
  exRes.rows.forEach((ex) => { exMap[ex.source_id] = ex; });
  log(`Berhasil memuat ${exRes.rows.length}/${srcIds.length} exercises dari database.`);

  let ok = 0;
  let fail = 0;
  let skip = 0;

  for (let i = 0; i < targets.length; i++) {
    const { src, kind } = targets[i];
    const baseName = `${src}_${kind}`;
    const wavPath = path.join(CACHE, `${baseName}.wav`);

    // FORCE: file sudah ada berarti pasti corrupt → hapus dulu
    if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);

    const ex = exMap[src];
    if (!ex) {
      skip++;
      log(`[${i + 1}/${targets.length}] SKIP ${baseName}: source_id tidak ada di DB`);
      continue;
    }
    const text = kind === 'hint'
      ? (ex.hint_text || ex.speech_text)
      : (ex.quick_trick || ex.speech_text);
    if (!text) {
      skip++;
      log(`[${i + 1}/${targets.length}] SKIP ${baseName}: teks kosong di DB`);
      continue;
    }

    log(`[${i + 1}/${targets.length}] START ${baseName}`);
    let success = false;
    for (let attempt = 1; attempt <= 2 && !success; attempt++) {
      try {
        const label = attempt === 1 ? baseName : `retry ${baseName}`;
        const result = await withTimeout(tts.synthesize(text), TTS_TIMEOUT_MS, `Gemini TTS ${label}`);
        const wav = tts.pcmToWav(result.audioBuffer, result.sampleRate);

        // Tulis lalu verifikasi dgn ffprobe SEBELUM dianggap sukses
        fs.writeFileSync(wavPath, wav);
        if (!ffprobeOk(wavPath)) {
          fs.unlinkSync(wavPath);
          log(`[${i + 1}/${targets.length}] FAIL ${label}: hasil masih corrupt menurut ffprobe`);
        } else {
          const visemes = tts.pcmToVisemes(result.audioBuffer, result.sampleRate) || { mouthCues: [] };
          fs.writeFileSync(path.join(VISEMES, `${baseName}.json`), JSON.stringify(visemes, null, 2));
          ok++;
          success = true;
          log(`[${i + 1}/${targets.length}] OK ${label} (${(wav.length / 1024).toFixed(1)} KB, ffprobe valid)`);
        }
      } catch (e) {
        log(`[${i + 1}/${targets.length}] FAIL attempt=${attempt} ${baseName}: ${e.message}`);
      }
    }
    if (!success) fail++;

    // Jeda antar request agar rate-limit tidak terpicu
    await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
  }

  log(`SELESAI: OK=${ok}, FAIL=${fail}, SKIP=${skip}`);
  if (db.pool && typeof db.pool.end === 'function') {
    await db.pool.end().catch(() => {});
  }
}

main().catch((e) => {
  log(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
const fs = require('fs');
const path = require('path');
const db = require('../src/database/db');
const tts = require('../src/rag/gemini-tts');

const SPEED_ROOT = 'D:\\local-rag-voice-bot\\speed-math-master';
const CACHE = path.join(SPEED_ROOT, 'audio', 'speech', 'cache');
const VISEMES = path.join(CACHE, 'visemes');
const REPORT_FILE = path.join(SPEED_ROOT, 'audio', 'speech', 'wav-quality-report.json');
const LOG_FILE = path.join(SPEED_ROOT, 'audio', 'speech', 'regenerate_gemini_stable.log');

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

const TTS_TIMEOUT_MS = parseInt(process.env.TTS_TIMEOUT_MS || '180000', 10);
const REQUEST_DELAY_MS = parseInt(process.env.REQUEST_DELAY_MS || '3000', 10);

async function main() {
  log('=== Memulai Regenerasi Audio & Viseme (RESUME MODE - FIXED) ===');

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

  const report = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
  const issues = [...(report.padding || []), ...(report.mismatch || [])];
  log(`Total target: ${issues.length}`);

  const exRes = await db.query('SELECT source_id, hint_text, speech_text, quick_trick FROM exercises');
  const exMap = {};
  exRes.rows.forEach((ex) => { exMap[ex.source_id] = ex; });
  log(`Berhasil memuat ${exRes.rows.length} exercises dari database.`);

  let ok = 0;
  let fail = 0;
  let skip = 0;

  for (let i = 0; i < issues.length; i++) {
    const item = issues[i];
    const src = item.src || item.sourceId;
    const kind = item.kind || (item.f.includes('_hint') ? 'hint' : 'trick');
    const baseName = `${src}_${kind}`;
    const wavPath = path.join(CACHE, `${baseName}.wav`);

    if (fs.existsSync(wavPath)) {
      skip++;
      continue;
    }

    const ex = exMap[src];
    if (!ex) {
      skip++;
      continue;
    }
    const text = kind === 'hint'
      ? (ex.hint_text || ex.speech_text)
      : (ex.quick_trick || ex.speech_text);
    if (!text) {
      skip++;
      continue;
    }

    log(`[${i + 1}/${issues.length}] START ${baseName}`);
    try {
      const result = await withTimeout(
        tts.synthesize(text),
        TTS_TIMEOUT_MS,
        `Gemini TTS ${baseName}`,
      );
      const wav = tts.pcmToWav(result.audioBuffer, result.sampleRate);
      fs.writeFileSync(wavPath, wav);
      const visemes = tts.pcmToVisemes(result.audioBuffer, result.sampleRate) || { mouthCues: [] };
      fs.writeFileSync(path.join(VISEMES, `${baseName}.json`), JSON.stringify(visemes, null, 2));
      ok++;
      log(`[${i + 1}/${issues.length}] OK ${baseName} (${(wav.length / 1024).toFixed(1)} KB)`);
    } catch (e) {
      fail++;
      log(`[${i + 1}/${issues.length}] FAIL ${baseName}: ${e.message}`);
    }

    // Jeda antar request agar rate-limit tidak terpicu.
    await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
  }

  log(`SELESAI: OK=${ok}, FAIL=${fail}, SKIP=${skip}`);
  // db.end is not called directly if pool doesn't support it or if pool.end is used
  if (typeof db.end === 'function') {
    await db.end().catch(() => {});
  } else if (db.pool && typeof db.pool.end === 'function') {
    await db.pool.end().catch(() => {});
  }
}

main().catch((e) => {
  log(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});

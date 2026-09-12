const fs = require('fs');
const path = require('path');
const db = require('../src/database/db');
const tts = require('../src/rag/gemini-tts');
const REPORT = 'D:\\local-rag-voice-bot\\speed-math-master\\audio\\speech\\wav-quality-report.json';
const CACHE = 'D:\\local-rag-voice-bot\\speed-math-master\\audio\\speech\\cache';
const VISEMES = 'D:\\local-rag-voice-bot\\speed-math-master\\audio\\speech\\cache\\visemes';

async function main() {
  console.log('=== Audio Regeneration ===');
  if (!tts.available) { console.error('No API keys!'); process.exit(1); }
  console.log('API keys:', tts.apiKeys.length);

  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  const padding = report.padding;
  const mismatch = report.mismatch;
  const allIssues = [...padding, ...mismatch];
  console.log('Issues:', allIssues.length, '(padded:', padding.length, 'mismatch:', mismatch.length, ')');

  const exRes = await db.query('SELECT source_id, hint_text, speech_text, quick_trick FROM exercises');
  const map = {};
  for (const ex of exRes.rows) map[ex.source_id] = ex;

  let ok = 0, fail = 0, skip = 0;
  for (let i = 0; i < allIssues.length; i++) {
    const item = allIssues[i];
    const src = item.src || item.sourceId;
    const kind = item.kind || (item.f.includes('_hint') ? 'hint' : 'trick');
    const baseName = src + '_' + kind;
    const ex = map[src];
    if (!ex) { skip++; continue; }
    const text = kind === 'hint' ? (ex.hint_text || ex.speech_text) : (ex.quick_trick || ex.speech_text);
    if (!text) { skip++; continue; }
    try {
      const { audioBuffer, sampleRate } = await tts.synthesize(text);
      const wav = tts.pcmToWav(audioBuffer, sampleRate);
      fs.writeFileSync(path.join(CACHE, baseName + '.wav'), wav);
      const vis = tts.pcmToVisemes(audioBuffer, sampleRate);
      if (vis) fs.writeFileSync(path.join(VISEMES, baseName + '.json'), JSON.stringify(vis));
      ok++;
      if (ok % 50 === 0) console.log('  Progress:', ok, 'ok', fail, 'fail', skip, 'skip');
    } catch (e) {
      fail++;
      console.log('  FAIL:', baseName, e.message.substring(0, 80));
    }
  }
  console.log('\n=== DONE ===');
  console.log('OK:', ok, 'FAIL:', fail, 'SKIP:', skip);
  await db.end().catch(() => {});
}
main().catch(e => { console.error(e); process.exit(1); });


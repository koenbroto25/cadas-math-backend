const fs = require('fs');
const path = require('path');
const { EdgeTTS } = require('edge-tts');
const db = require('../src/database/db');
const REPORT = 'D:\\local-rag-voice-bot\\speed-math-master\\audio\\speech\\wav-quality-report.json';
const CACHE = 'D:\\local-rag-voice-bot\\speed-math-master\\audio\\speech\\cache';
const VISEMES = 'D:\\local-rag-voice-bot\\speed-math-master\\audio\\speech\\cache\\visemes';

const VOICE = 'id-ID-GadisNeural';

async function main() {
  console.log('=== Audio Regeneration (edge-tts) ===');
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  const padding = report.padding || [];
  const mismatch = report.mismatch || [];
  const allIssues = [...padding, ...mismatch];
  console.log('Issues:', allIssues.length);

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
      const tts = new EdgeTTS({ voice: VOICE });
      const wavPath = path.join(CACHE, baseName + '.wav');
      await tts.save(text, wavPath);
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

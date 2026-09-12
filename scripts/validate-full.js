const fs = require('fs');
const path = require('path');
const db = require('../src/database/db');

const AUDIO_DIR = path.join(__dirname, '..', '..', 'speed-math-master', 'audio', 'speech', 'cache');
const REPORT = path.join(__dirname, '..', '..', 'speed-math-master', 'audio', 'speech', 'validation-report.json');
const CHARS_PER_SEC_MIN = 10;
const CHARS_PER_SEC_MAX = 18;

function readWavDuration(fp) {
  try {
    const buf = fs.readFileSync(fp);
    if (buf.length < 44) return null;
    const sr = buf.readUInt32LE(24);
    const ch = buf.readUInt16LE(22);
    const bits = buf.readUInt16LE(34);
    const dataSz = buf.readUInt32LE(40);
    if (!sr || !ch || !bits) return null;
    return dataSz / (sr * ch * (bits / 8));
  } catch (e) { return null; }
}
function estimate(text) {
  if (!text) return { min: 0, max: 0, chars: 0 };
  const c = text.length;
  return { min: c / CHARS_PER_SEC_MAX, max: c / CHARS_PER_SEC_MIN, chars: c };
}

async function main() {
  const exRes = await db.query('SELECT source_id, hint_text, speech_text, quick_trick FROM exercises');
  const map = {};
  for (const ex of exRes.rows) map[ex.source_id] = ex;
  console.log('DB exercises:', exRes.rows.length);
  const wavs = fs.readdirSync(AUDIO_DIR).filter(f => f.endsWith('.wav'));
  console.log('WAV files:', wavs.length);
  const issues = [];
  let ok = 0, checked = 0, missing = 0;
  for (const wav of wavs) {
    const m = wav.replace('.wav','').match(/^(.+)_(hint|trick)$/);
    if (!m) continue;
    const src = m[1], kind = m[2];
    const dur = readWavDuration(path.join(AUDIO_DIR, wav));
    if (dur === null) { issues.push({file:wav,issue:'CORRUPT'}); continue; }
    const ex = map[src];
    if (!ex) { missing++; continue; }
    const text = kind === 'hint' ? (ex.hint_text || ex.speech_text) : (ex.quick_trick || ex.speech_text);
    if (!text) { issues.push({file:wav,issue:'NO_TEXT'}); continue; }
    const est = estimate(text);
    checked++;
    const isPadded = dur > est.max * 2;
    const isTruncated = dur < est.min / 2;
    const inRange = dur >= est.min/1.5 && dur <= est.max*1.5;
    const status = isPadded ? 'PADDED' : isTruncated ? 'TRUNCATED' : inRange ? 'OK' : 'MISMATCH';
    if (status === 'OK') ok++;
    else issues.push({file:wav,sourceId:src,kind,issue:status,textLen:est.chars,expected:est.min.toFixed(1)+'-'+est.max.toFixed(1)+'s',actual:dur.toFixed(2)+'s',preview:text.substring(0,50)});
  }
  const padded = issues.filter(i=>i.issue==='PADDED');
  const truncated = issues.filter(i=>i.issue==='TRUNCATED');
  const corrupt = issues.filter(i=>i.issue==='CORRUPT');
  const mismatch = issues.filter(i=>i.issue==='MISMATCH');
  console.log('\n=== SUMMARY ===');
  console.log('Checked:', checked);
  console.log('OK:', ok);
  console.log('PADDED:', padded.length);
  console.log('TRUNCATED:', truncated.length);
  console.log('MISMATCH:', mismatch.length);
  console.log('CORRUPT:', corrupt.length);
  console.log('No DB entry:', missing);

  if (padded.length) {
    console.log('\nTOP 10 PADDED:');
    padded.sort((a,b)=>parseFloat(b.actual)-parseFloat(a.actual));
    for (const p of padded.slice(0,10)) console.log('  ', p.file, p.actual, '(exp', p.expected+')', p.preview);
  }
  if (truncated.length) {
    console.log('\nTOP 10 TRUNCATED:');
    truncated.sort((a,b)=>parseFloat(a.actual)-parseFloat(b.actual));
    for (const t of truncated.slice(0,10)) console.log('  ', t.file, t.actual, '(exp', t.expected+')', t.preview);
  }
  fs.writeFileSync(REPORT, JSON.stringify({summary:{total:wavs.length,checked,ok,padded:padded.length,truncated:truncated.length,mismatch:mismatch.length,corrupt:corrupt.length,missingText:missing,noText:issues.filter(i=>i.issue==='NO_TEXT').length},topPadded:padded.slice(0,50),topTruncated:truncated.slice(0,50),topMismatch:mismatch.slice(0,50)},null,2));
  console.log('\nReport saved:', REPORT);
  await db.end();
}

main().catch(e=>{console.error(e);process.exit(1);});



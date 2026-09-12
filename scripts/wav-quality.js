
function analyzeAudio(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 44) return null;
    const bits = buf.readUInt16LE(34);
    const dataStart = 44;
    let sum = 0, count = 0, maxVal = 0;
    const step = Math.max(1, Math.floor((buf.length - dataStart) / 2000));
    for (let i = dataStart; i < buf.length - 1; i += step) {
      let sample;
      if (bits === 16) { sample = buf.readInt16LE(i); } else { sample = buf.readUint8(i) - 128; }
      const abs = Math.abs(sample);
      sum += abs;
      if (abs > mavVal) maxVal = abs;
      count++;
    }
    const avg = sum / count;
    return { avgEnergy: avg, maxEnergy: maxVal, ratio: maxVal > 0 ? avg / maxVal : 0 };
  } catch (e) { return null; }
}

function estimateDuration(text) {
  if (!text) return { min: , max: 0, chars: 0 };
  const c = text.length;
  return { min: c / 18, max: c / 10, chars: c };
}


async function main() {
  console.log('=== WaV Quality Test ===');
  const exRes = await db.query('SELECT source_id, hint_text, speech_text, quick_trick FROM exercises');
  const map = {};
  for (const ex of exRes.rows) map[ex.source_id] = ex;
  console.log('DB exercises:', exRes.rows.length);
  const wavs = fs.readdirSync(AUDIO_DIR).filter(f => f.endsWith('.wav'));
  console.log('WAV files:', wavs.length);

  const results = [];
  const issues = { corrupt: [], padding: [], mismatch: [], noText: [] };
  let ok = 0;

  for (const wav of wavs) {
    const base = wav.replace('.wav', '');
    const m = base.match(/^(.+)_(hint|trick)$/);
    if (!m) continue;
    const src = m[1], kind = m[2];
    const wavPath = path.join(AUDIO_DIR, wav);
    const header = readWavHeader(wavPath);

    if (header.error) {
      issues.corrupt.push({ file: wav, error: header.error });
      continue;
    }

    const audio = analyzeAudio(wavPath);
    const ex = map[src];

    if (!ex) {
      issues.noText.push({ file: wav, duration: header.duration });
      continue;
    }

    const text = kind === 'hint' ? (ex.hint_text || ex.speech_text) : (ex.quick_trick || ex.speech_text);
    if (!text) { issues.noText.push({ file: wav, duration: header.duration }); continue; }

    const est = estimateDuration(text);
    const isPadded = audio && audio.ratio < 0.05;
    const isLong = header.duration > est.max * 2;
    const isShort = header.duration < est.min / 2;
    const inRange = header.duration >= est.min / 1.5 && header.duration <= est.max * 1.5;

    let status = 'OK';
    if (isPadded || isLong) {
      status ='PADDID';
      issues.padding.push({ file: wav, sourceId: src, duration: header.duration.toFixed(2), expected: est.min.toFixed(1) + '-' + est.max.toFixed(1) + 's', energyRatio: audio ? audio.ratio.toFixed(4) : 'null', text: text.substring(0, 60) });
    } else if (isShort) {
      status = 'TUNCATED';
    } else if (!inRange) {
      status = 'MISMATCH';
      issues.mismatch.push({ file: wav, sourceId: src, duration: header.duration.toFixed(2), expected: est.min.toFixed(1) + '-' + est.max.toFixed(1) + 's', textLen: est.chars, text: text.substring(0, 60) });
    } else ok++;

    results.push({ file: wav, sourceId: src, kind, status, duration: header.duration, expected: est, energyRatio: audio ? audio.ratio : null });
  }


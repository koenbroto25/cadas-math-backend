const fs = require('fs');
const path = require('path');
const axios = require('axios');
const db = require('../src/database/db');

const SPEED_ROOT = 'D:\\local-rag-voice-bot\\speed-math-master';
const CACHE = SPEED_ROOT + '\\audio\\speech\\cache';
const VISEMES = CACHE + '\\visemes';
const REPORT = SPEED_ROOT + '\\audio\\speech\\wav-quality-report.json';
const EXERCISES_FILE = SPEED_ROOT + '\\tmp-exercises.json';

const MODEL = 'gemini-3.1-flash-tts-preview';
const VOICE = 'Kore';

function loadKeys() {
  const env = fs.readFileSync(SPEED_ROOT + '\\.env', 'utf8');
  const keys = env.split('\n').filter(l => l.match(/^GOOGLE_API_KEY_\d+=/)).map(l => l.split('=')[1].trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  return keys;
}

let keyIndex = 0;
function nextKey(keys) { return keys[keyIndex++ % keys.length]; }

async function synthesize(text, apiKey) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent?key=' + apiKey;
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['audio'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } }
    }
  };
  const r = await axios.post(url, body, { timeout: 120000 });
  const part = r.data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!part?.inlineData?.data) throw new Error('No audio data');
  return Buffer.from(part.inlineData.data, 'base64');
}

function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function main() {
  console.log('=== Gemini TTS Regenerate ===');
  const keys = loadKeys();
  console.log('Keys:', keys.length);
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  const exercises = JSON.parse(fs.readFileSync(EXERCISES_FILE, 'utf8'));
  const mp = {}; exercises.forEach(e => mp[e.source_id] = e);
  const issues = [...(report.padding || []), ...(report.mismatch || [])];
  console.log('Issues:', issues.length);

  let ok = 0, fail = 0, skip = 0;
  for (let i = 0; i < issues.length; i++) {
    const item = issues[i];
    const src = item.src || item.sourceId;
    const kind = item.kind || (item.f.includes('_hint') ? 'hint' : 'trick');
    const base = src + '_' + kind;
    const ex = mp[src];
    if (!ex) { skip++; continue; }
    const text = kind === 'hint' ? (ex.hint_text || ex.speech_text) : (ex.quick_trick || ex.speech_text);
    if (!text) { skip++; continue; }
    try {
      const pcm = await synthesize(text, nextKey(keys));
      const wav = pcmToWav(pcm, 24000);
      fs.writeFileSync(path.join(CACHE, base + '.wav'), wav);
      ok++;
      if (ok % 25 === 0) console.log('  Progress:', ok, 'ok', fail, 'fail', skip, 'skip');
    } catch (e) {
      fail++;
      if (fail <= 3) console.log('  FAIL:', base, e.message.substring(0, 80));
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.log('\n=== DONE ===');
  console.log('OK:', ok, 'FAIL:', fail, 'SKIP:', skip);
}
main().catch(e => { console.error(e); process.exit(1); });


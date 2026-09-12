/**
 * Sprint G.2 — Unit test offline pcmToVisemes (tanpa API key / tanpa server).
 * Run: node src/test/test-pcm-visemes.js
 *
 * Verifikasi:
 *  1. PCM sintetis (diam → burst keras → sedang → diam) → viseme sesuai energi
 *  2. Nilai cue hanya alfabet Rhubarb {X,B,C,D,A,O}
 *  3. Boundary kontinu: cue[0].start = 0, end[n-1] = durasi, tanpa gap/overlap
 *  4. Jumlah frame 40ms benar; tanpa NaN
 *  5. Edge case: buffer kosong, buffer diam → null (frontend fallback aman)
 */

const geminiTTS = require('../rag/gemini-tts');

const SR = 24000;
const FRAME_MS = 40;

function makeSine(freq, seconds, amplitude) {
  const n = Math.round(SR * seconds);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin(2 * Math.PI * freq * i / SR) * amplitude * 32767);
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else      { fail++; console.log(`  [FAIL] ${name}`); }
}

// ── Skenario 1: 0.5s diam + 0.5s keras (440Hz full) + 0.5s sedang (0.35) + 0.5s diam
console.log('Skenario 1: diam → keras → sedang → diam (2 detik, 50 frame)');
const pcm = Buffer.concat([
  makeSine(440, 0.5, 0.0),    // diam      → frame 0-11  → X
  makeSine(440, 0.5, 0.95),   // keras     → frame 12-24 → O/A
  makeSine(440, 0.5, 0.30),   // sedang    → frame 25-37 → C/D
  makeSine(440, 0.5, 0.0),    // diam      → frame 38-49 → X
]);
const r1 = geminiTTS.pcmToVisemes(pcm, SR, FRAME_MS);

assert(r1 !== null, 'hasil non-null');
assert(r1 && Array.isArray(r1.mouthCues) && r1.mouthCues.length > 0, 'mouthCues non-kosong');

const cues = r1.mouthCues;
const validSet = new Set(['X', 'B', 'C', 'D', 'A', 'O']);
assert(cues.every(c => validSet.has(c.value)), 'nilai cue hanya {X,B,C,D,A,O}');
assert(cues.every(c => Number.isFinite(c.start) && Number.isFinite(c.end) && !Number.isNaN(c.start + c.end)), 'tanpa NaN');
assert(cues[0].start === 0, 'cue pertama mulai 0.00');
assert(Math.abs(cues[cues.length - 1].end - 2.0) < FRAME_MS / 1000 + 1e-9, 'cue terakhir = durasi total (2.0s)');

let kontinu = true;
for (let i = 1; i < cues.length; i++) {
  if (Math.abs(cues[i].start - cues[i - 1].end) > 1e-9) { kontinu = false; break; }
}
assert(kontinu, 'boundary antar-cue kontinu (tanpa gap/overlap)');
assert(cues.every(c => c.end > c.start), 'setiap cue durasi > 0');

// Cek urutan makro: frame diam awal → X; bagian keras → O atau A; sedang → C/D; akhir X
const valAt = (t) => {
  const c = cues.find(c => t >= c.start && t < c.end);
  return c ? c.value : '?';
};
assert(valAt(0.2) === 'X', 't=0.2s (diam) → X');
assert(['O', 'A'].includes(valAt(0.75)), `t=0.75s (keras, tengah segmen) → O/A (got ${valAt(0.75)})`);
assert(['C', 'D'].includes(valAt(1.25)), `t=1.25s (sedang, tengah segmen) → C/D (got ${valAt(1.25)})`);
assert(valAt(1.9) === 'X', 't=1.9s (diam) → X');

// Distribusi viseme (info)
const dist = {};
cues.forEach(c => { dist[c.value] = (dist[c.value] || 0) + (c.end - c.start); });
console.log('  Distribusi durasi viseme:', Object.fromEntries(Object.entries(dist).map(([k, v]) => [k, `${v.toFixed(2)}s`])));

// ── Skenario 2: edge cases
console.log('Skenario 2: edge cases');
assert(geminiTTS.pcmToVisemes(Buffer.alloc(0)) === null, 'buffer kosong → null');
assert(geminiTTS.pcmToVisemes(Buffer.alloc(2 * SR * 2)) === null, 'buffer diam total → null');
assert(geminiTTS.pcmToVisemes(null) === null, 'null input → null');
const tiny = makeSine(440, 0.01, 0.5); // < 1 frame
assert(geminiTTS.pcmToVisemes(tiny, SR, FRAME_MS) === null, 'buffer < 1 frame → null');

// ── Skenario 3: pcmToWav dengan sample rate non-default
console.log('Skenario 3: pcmToWav sample rate');
const wav = geminiTTS.pcmToWav(pcm, 48000);
assert(wav.readUInt32LE(24) === 48000, 'WAV header sample rate 48000 tersimpan benar');
const wav24 = geminiTTS.pcmToWav(pcm, 24000);
assert(wav24.readUInt32LE(24) === 24000, 'WAV header sample rate 24000 tersimpan benar');

// ── Skenario 4: parseSampleRate
console.log('Skenario 4: parseSampleRate');
assert(GeminiTTS_parse('audio/L16;codec=pcm;rate=24000') === 24000, 'parse rate=24000');
assert(GeminiTTS_parse('audio/L16;rate=44100') === 44100, 'parse rate=44100');
assert(GeminiTTS_parse('audio/pcm') === null, 'tanpa rate → null');
assert(GeminiTTS_parse(undefined) === null, 'undefined → null');

function GeminiTTS_parse(m) { return geminiTTS.constructor.parseSampleRate(m); }

console.log(`\n=== HASIL: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail > 0 ? 1 : 0);
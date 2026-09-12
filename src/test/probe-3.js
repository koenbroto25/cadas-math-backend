// Probe-3: isolate — synthesize direct dengan teks pendek vs panjang
require('dotenv').config({ path: 'D:/local-rag-voice-bot/cadas-app-backend/.env' });
const t = require('../rag/gemini-tts');
const pipeline = require('../rag/pipeline');
const { normalizeSpeech } = require('../rag/normalizer');

const LONG = 'Tentu! Mari kita belajar tentang cara menghitung pecahan. Ada beberapa hal yang perlu kita tahu. Pertama, pecahan terdiri dari dua bagian: angka di atas yang disebut numerator, dan angka di bawah yang disebut denominator. Numerator menunjukkan berapa bagian yang kita ambil. Denominator menunjukkan berapa bagian total. Kedua, untuk menghitung pecahan, kita perlu tahu apakah denominator sama atau tidak. Jika sama, kita hanya tambah atau pengurangan numerator. Jika tidak sama, kita perlu mencari common denominator terlebih dahulu. Terus, ada beberapa jenis pecahan: pecahan biasa, pecahan campuran, dan pecahan desimal. Untuk pecahan campuran, kita perlu konvertir menjadi pecahan biasa sebelum menghitung.';
const SHORT = 'Oke, tujuh dikali delapan sama dengan lima puluh enam. Gitu deh!';

(async () => {
  console.log('normalizeSpeech LONG len =', normalizeSpeech(LONG).length);
  console.log('normalizeSpeech SHORT len =', normalizeSpeech(SHORT).length);

  for (const [label, text] of [['SHORT', SHORT], ['LONG', LONG]]) {
    try {
      const r = await t.synthesize(text);
      console.log(`${label}: synthesize OK rate=${r.sampleRate} bytes=${r.audioBuffer.length} dur=${(r.audioBuffer.length / 2 / r.sampleRate).toFixed(1)}s`);
    } catch (e) {
      console.log(`${label}: synthesize FAIL → ${e.message}`);
    }
  }

  // generateOutput direct untuk LONG
  try {
    const out = await pipeline.generateOutput(LONG, 3, 'premium', null);
    console.log('generateOutput LONG: audioUrl=', out.audioUrl ? `set len=${out.audioUrl.length}` : 'NULL', '| visemes=', out.visemes ? `${out.visemes.mouthCues.length} cue` : 'NULL', '| ttsError=', out.ttsError);
  } catch (e) {
    console.log('generateOutput LONG THROW:', e.message);
  }
  process.exit(0);
})();
// Sprint G.2 — diagnostik cepat: synthesize + pcmToVisemes direct (tanpa HTTP)
// Run: node src/test/diag-g2.js
require('dotenv').config({ path: 'D:/local-rag-voice-bot/cadas-app-backend/.env' });
const t = require('../rag/gemini-tts');
const db = require('../database/db');

(async () => {
  console.log('available =', t.available);
  console.log('model     =', t.model);
  console.log('voice     =', t.voiceName);
  console.log('health    =', await t.healthCheck());

  try {
    const r = await t.synthesize('Halo anak, ini test lip sync dong');
    const dur = r.audioBuffer.length / 2 / r.sampleRate;
    console.log('synthesize OK  mime=', r.mimeType, 'rate=', r.sampleRate, `dur=${dur.toFixed(2)}s`);
    const v = t.pcmToVisemes(r.audioBuffer, r.sampleRate);
    if (!v) { console.log('pcmToVisemes = NULL'); return; }
    console.log('visemes cue   =', v.mouthCues.length);
    console.log('first 5       =', JSON.stringify(v.mouthCues.slice(0, 5)));
    console.log('last          =', JSON.stringify(v.mouthCues.slice(-1)));
    const dist = {};
    v.mouthCues.forEach(c => { dist[c.value] = +((dist[c.value] || 0) + (c.end - c.start)).toFixed(2); });
    console.log('distribusi    =', JSON.stringify(dist));

    // End-to-end generateOutput premium (via pipeline)
    const pipeline = require('../rag/pipeline');
    const out = await pipeline.generateOutput('Oke, tujuh dikali delapan sama dengan lima puluh enam. Gitu deh!', 3, 'premium', null);
    const isUri = typeof out.audioUrl === 'string' && out.audioUrl.startsWith('data:audio/wav');
    console.log('generateOutput premium: audio=' + (isUri ? out.audioUrl.length + ' chars' : String(out.audioUrl)) + ' | visemes=' + (out.visemes ? out.visemes.mouthCues.length + ' cue' : String(out.visemes)) + ' | ttsError=' + out.ttsError);
  } catch (e) {
    console.log('synthesize FAIL:', e.message);
  } finally {
    await db.pool.end();
    process.exit(0);
  }
})();
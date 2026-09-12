require('dotenv').config({ path: 'D:/local-rag-voice-bot/cadas-app-backend/.env' });
const axios = require('axios');

async function main() {
  console.log('=== HEALTH CHECK ===');

  // Check 1: Check env variables
  console.log('\n[Check 1] Environment variables:');
  console.log('  GEMINI_TTS_MODEL:', process.env.GEMINI_TTS_MODEL || '(default)');
  console.log('  GEMINI_TTS_VOICE:', process.env.GEMINI_TTS_VOICE || '(default)');
  console.log('  GEMINI_TTS_MAX_TRIES:', process.env.GEMINI_TTS_MAX_TRIES || '(default)');
  console.log('  GOOGLE_API_KEY_1:', process.env.GOOGLE_API_KEY_1 ? process.env.GOOGLE_API_KEY_1.slice(0, 15) + '...' : 'NOT SET');
  console.log('  OPENROUTER_API_KEY_1:', process.env.OPENROUTER_API_KEY_1 ? process.env.OPENROUTER_API_KEY_1.slice(0, 15) + '...' : 'NOT SET');

  // Check 2: Direct Gemini API health check (minimal quota usage)
  console.log('\n[Check 2] Gemini API health check (models endpoint):');
  try {
    const key = process.env.GOOGLE_API_KEY_1 || process.env.GEMINI_API_KEY;
    if (!key) { console.log('  SKIP: no API key found'); return; }
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=1`;
    const startTime = Date.now();
    const res = await axios.get(url, { timeout: 15000 });
    console.log('  OK:', Date.now() - startTime, 'ms');
    const models = res.data.models || [];
    const ttsModels = models.filter(m => m.name && m.name.includes('2.5-flash'));
    console.log('  Available 2.5-flash models:', ttsModels.map(m => m.name).join(', ') || 'NONE FOUND');
  } catch (err) {
    console.log('  FAIL:', err.response ? `${err.response.status}: ${err.response.data?.error?.message || JSON.stringify(err.response.data)}` : err.message);
  }

  // Check 3: Direct Gemini TTS call (short text, minimal quota)
  console.log('\n[Check 3] Gemini TTS direct call (short text "Halo"):');
  try {
    const key = process.env.GOOGLE_API_KEY_1 || process.env.GEMINI_API_KEY;
    if (!key) { console.log('  SKIP: no API key found'); return; }
    const body = {
      contents: [{ parts: [{ text: 'Halo.' }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
        },
      },
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview:generateContent?key=${key}`;
    const startTime = Date.now();
    const res = await axios.post(url, body, { timeout: 30000 });
    const audio = res.data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (audio) {
      console.log('  OK:', Date.now() - startTime, 'ms | audio:', audio.mimeType, '| bytes:', audio.data?.length || 0);
    } else {
      console.log('  NO AUDIO:', JSON.stringify(res.data).slice(0, 300));
    }
  } catch (err) {
    console.log('  FAIL:', err.response ? `${err.response.status}: ${err.response.data?.error?.message || JSON.stringify(err.response.data)}` : err.message);
  }

  // Check 4: OpenRouter health check
  console.log('\n[Check 4] OpenRouter health check:');
  try {
    const key = process.env.OPENROUTER_API_KEY_1;
    if (!key) { console.log('  SKIP: no API key found'); return; }
    const startTime = Date.now();
    const res = await axios.get('https://openrouter.ai/api/v1/auth/key', {
      headers: { Authorization: `Bearer ${key}` },
      timeout: 15000,
    });
    console.log('  OK:', Date.now() - startTime, 'ms | credit:', res.data.data?.credit ?? 'unknown');
  } catch (err) {
    console.log('  FAIL:', err.response ? `${err.response.status}: ${err.response.data?.error?.message || JSON.stringify(err.response.data)}` : err.message);
  }

  // Check 5: Backend health check
  console.log('\n[Check 5] Backend health:');
  try {
    const res = await axios.get('http://localhost:3000/api/health', { timeout: 10000 });
    console.log('  OK:', JSON.stringify(res.data));
  } catch (err) {
    console.log('  FAIL:', err.message);
  }
}

main().finally(() => process.exit(0));
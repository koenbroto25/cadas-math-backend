/**
 * Google Gemini TTS client — adapted from speed-math-master/gemini-client.js
 * for use in cadas-app-backend RAG pipeline.
 *
 * Features:
 *  - Key rotation across 250 GOOGLE_API_KEY_1..250
 *  - Automatic retry on 429
 *  - PCM → WAV conversion for audio output
 *  - pcmToVisemes lip-sync (Sprint G.2)
 */

const axios = require('axios');
const { normalizeSpeech } = require('./normalizer');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

class GeminiTTSClient {
  constructor() {
    // Baca semua key: GEMINI_API_KEY(S) koma-separated,
    // GEMINI_API_KEY_1..5, dan GOOGLE_API_KEY_1..250 (nama di .env aktual).
    const keys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
      .split(',')
      .map(k => k.trim())
      .filter(Boolean);

    // GEMINI_API_KEY_1..5
    for (let i = 1; i <= 5; i++) {
      const g = process.env[`GEMINI_API_KEY_${i}`];
      if (g && g.trim() && !keys.includes(g.trim())) keys.push(g.trim());
    }

    // GOOGLE_API_KEY_1..250 — baca semua yang tersedia
    for (let i = 1; i <= 250; i++) {
      const goog = process.env[`GOOGLE_API_KEY_${i}`];
      if (goog && goog.trim() && !goog.includes('replace_with_real') && !keys.includes(goog.trim())) {
        keys.push(goog.trim());
      }
    }

    this.apiKeys = keys;
    // Model TTS — bisa dioverride via GEMINI_TTS_MODEL; default preview (aktif Sep 2026).
    // Rantai fallback model disiapkan di synthesize() karena Google bisa mem-rotasi
    // model berlabel preview (HTTP 4xx/5xx mendadak) tanpa pengumuman shutdown
    // — varian GA 'gemini-2.5-flash-tts' dipakai sebagai cadangan.
    this.model     = process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview';
    this.voiceName = process.env.GEMINI_TTS_VOICE || 'Kore';
    this._keyIndex = 0;
    this._deadKeys = new Set(); // key yang ditolak 401/403 → dilewati rotasi

    console.log(`[GeminiTTS] ${this.apiKeys.length} key(s) loaded, model: ${this.model}`);
  }

  get available() { return this.apiKeys.length > 0; }

  _nextKey() {
    const n = this.apiKeys.length;
    for (let i = 0; i < n; i++) {
      const key = this.apiKeys[this._keyIndex % n];
      this._keyIndex++;
      if (!this._deadKeys.has(key)) return key;
    }
    return null; // semua key mati
  }

  /**
   * Generate TTS audio from text.
   * @param {string} text
   * @param {object} options - { voiceName }
   * @returns {Promise<{audioBuffer:Buffer, mimeType:string, sampleRate:number}>}
   */
  async synthesize(text, options = {}) {
    if (!this.available) {
      throw new Error('No Gemini API keys configured (GOOGLE_API_KEY_1..250 atau GEMINI_API_KEY)');
    }

    const spokenText = normalizeSpeech(text);

    // Patch 20 Sep 2026: batasi panjang teks TTS. Hasil ukur latensi:
    // 200 ch ≈ 13s; teks 650+ ch > 25s (timeout). Jawaban untuk anak SD tidak
    // perlu selengkap itu — potong di batas kalimat (default 400 karakter).
    const MAX_TTS_CHARS = parseInt(process.env.GEMINI_TTS_MAX_CHARS || '400', 10);
    let ttsInput = spokenText;
    if (spokenText.length > MAX_TTS_CHARS) {
      const cut = spokenText.slice(0, MAX_TTS_CHARS);
      const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
      ttsInput = lastStop > 80 ? cut.slice(0, lastStop + 1) : cut;
      console.log(`[GeminiTTS] teks dipotong ${spokenText.length} → ${ttsInput.length} karakter (batas ${MAX_TTS_CHARS})`);
    }

    const body = {
      contents: [{ parts: [{ text: ttsInput }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: options.voiceName || this.voiceName,
            },
          },
        },
      },
    };

    const maxAttempts = parseInt(process.env.GEMINI_TTS_MAX_TRIES || '5', 10);

    // Rantai fallback model (patch 20 Sep 2026, diperkaya masukan user):
    // kuota gratis Gemini per-model INDEPENDEN — jika 1 model habis kuota (429),
    // pindah ke model berikutnya = kuota baru. Urutan:
    //  utama (env/kode) → flash GA → flash-lite preview → pro.
    // Bisa dioverride via GEMINI_TTS_MODELS (koma-separated).
    const envModels = (process.env.GEMINI_TTS_MODELS || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const modelChain = [];
    for (const m of [
      ...envModels,
      this.model,
      'gemini-2.5-flash-tts',
      'gemini-2.5-flash-lite-preview-tts',
      'gemini-2.5-pro-tts',
    ]) {
      if (m && !modelChain.includes(m)) modelChain.push(m);
    }

    let lastErr = null;
    for (const model of modelChain) {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const key = this._nextKey();
        if (!key) break; // semua key mati
        const url = `${BASE_URL}/models/${model}:generateContent?key=${key}`;
        try {
          const response = await axios.post(url, body, {
            timeout:      parseInt(process.env.GEMINI_TTS_TIMEOUT_MS || '120000', 10),
            responseType: 'json',
          });

          const candidate = response.data.candidates?.[0];
          const part      = candidate?.content?.parts?.find(p => p.inlineData);
          if (!part?.inlineData?.data) {
            throw Object.assign(new Error('No audio data in Gemini response'), { response: { status: 502 } });
          }

          const audioBuffer = Buffer.from(part.inlineData.data, 'base64');
          const mimeType    = part.inlineData.mimeType || 'audio/pcm';
          return {
            audioBuffer,
            mimeType,
            sampleRate: GeminiTTSClient.parseSampleRate(mimeType) || 24000,
          };

        } catch (error) {
          const status = error.response?.status;
          const detail = error.response?.data?.error?.message || error.message;
          lastErr = new Error(`Gemini TTS error (${model}) (${status}): ${detail}`);

          if (/timeout/i.test(error.message || '') || error.code === 'ECONNABORTED') {
            console.warn(`[GeminiTTS] timeout → rotasi key/model (model ${model}, attempt ${attempt + 2}/${maxAttempts})`);
            continue;
          }

          if (status === 429 && attempt < maxAttempts - 1) {
            // Kuota model ini habis untuk key ini → pindah MODEL berikutnya
            // (kuota gratis per-model independen), bukan hanya ganti key.
            console.warn(`[GeminiTTS] 429 kuota habis (model ${model}) → pindah model berikutnya`);
            break;
          }
          if (status === 401 || status === 403) {
            this._deadKeys.add(key);
            console.warn(`[GeminiTTS] key ditolak (${status}) → tandai mati & rotasi (total mati: ${this._deadKeys.size}/${this.apiKeys.length})`);
            continue;
          }
          if (status === 404 || /not found|not supported|does not exist/i.test(detail || '')) {
            console.warn(`[GeminiTTS] model ${model} tidak tersedia (${detail}) → fallback ke model berikutnya`);
            break; // keluar loop attempt → model berikutnya
          }
          // 5xx / 400 lain: coba key berikutnya (bisa key/konteks spesifik)
          console.warn(`[GeminiTTS] error ${status} → coba key berikutnya (model ${model}, attempt ${attempt + 2}/${maxAttempts}): ${detail}`);
          continue;
        }
      }
    }
    throw lastErr || new Error('Gemini TTS error: all attempts exhausted');
  }

  /**
   * pcmToVisemes — analisis energi RMS per frame 40ms dari PCM buffer
   * → mouthCues format identik Rhubarb [{start,end,value}]
   * Dikalibrasi 12 Sep 2026.
   */
  pcmToVisemes(pcmBuffer, sampleRate = 24000, frameMs = 40) {
    try {
      if (!pcmBuffer || pcmBuffer.length < 2) return null;
      const sampleCount  = Math.floor(pcmBuffer.length / 2);
      const samples      = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, sampleCount);
      const frameSamples = Math.max(1, Math.round(sampleRate * frameMs / 1000));
      const frameCount   = Math.floor(sampleCount / frameSamples);
      if (frameCount < 1) return null;

      const rms = new Float64Array(frameCount);
      let peak  = 0;
      for (let f = 0; f < frameCount; f++) {
        let sum = 0;
        const off = f * frameSamples;
        for (let i = 0; i < frameSamples; i++) {
          const s = samples[off + i] / 32768;
          sum += s * s;
        }
        rms[f] = Math.sqrt(sum / frameSamples);
        if (rms[f] > peak) peak = rms[f];
      }
      if (peak <= 0) return null;

      const TH = [0.036, 0.119, 0.261, 0.473, 0.708];
      const mapViseme = n =>
        n < TH[0] ? 'X' : n < TH[1] ? 'B' : n < TH[2] ? 'C' :
        n < TH[3] ? 'D' : n < TH[4] ? 'A' : 'O';

      const frameDur = frameMs / 1000;
      const cues     = [];
      let cur        = null;
      for (let f = 0; f < frameCount; f++) {
        const v  = mapViseme(rms[f] / peak);
        const t0 = f * frameDur;
        if (cur && cur.value === v) {
          cur.end = t0 + frameDur;
        } else {
          cur = { start: t0, end: t0 + frameDur, value: v };
          cues.push(cur);
        }
      }
      return { mouthCues: cues };
    } catch (err) {
      console.warn('[GeminiTTS] pcmToVisemes failed:', err.message);
      return null;
    }
  }

  static parseSampleRate(mimeType) {
    if (!mimeType) return null;
    const m = /rate=(\d+)/i.exec(String(mimeType));
    return m ? parseInt(m[1], 10) : null;
  }

  pcmToWav(pcmBuffer, sampleRate = 24000, channels = 1) {
    const bitsPerSample = 16;
    const byteRate      = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign    = channels * (bitsPerSample / 8);
    const dataSize      = pcmBuffer.length;
    const wavBuffer     = Buffer.alloc(44 + dataSize);

    wavBuffer.write('RIFF', 0);
    wavBuffer.writeUInt32LE(36 + dataSize, 4);
    wavBuffer.write('WAVE', 8);
    wavBuffer.write('fmt ', 12);
    wavBuffer.writeUInt32LE(16, 16);
    wavBuffer.writeUInt16LE(1, 20);
    wavBuffer.writeUInt16LE(channels, 22);
    wavBuffer.writeUInt32LE(sampleRate, 24);
    wavBuffer.writeUInt32LE(byteRate, 28);
    wavBuffer.writeUInt16LE(blockAlign, 32);
    wavBuffer.writeUInt16LE(bitsPerSample, 34);
    wavBuffer.write('data', 36);
    wavBuffer.writeUInt32LE(dataSize, 40);
    pcmBuffer.copy(wavBuffer, 44);

    return wavBuffer;
  }

  async healthCheck() {
    if (!this.available) return false;
    try {
      const key = this._nextKey();
      await axios.get(`${BASE_URL}/models?key=${key}&pageSize=1`, { timeout: 10000 });
      return true;
    } catch { return false; }
  }
}

module.exports = new GeminiTTSClient();

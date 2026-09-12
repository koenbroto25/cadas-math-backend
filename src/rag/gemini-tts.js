/**
 * Google Gemini TTS client — adapted from speed-math-master/gemini-client.js
 * for use in cadas-app-backend RAG pipeline.
 *
 * Features:
 *  - Key rotation across multiple API keys
 *  - Automatic retry on 429
 *  - PCM → WAV conversion for audio output
 */

const axios = require('axios');
const { normalizeSpeech } = require('./normalizer');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

class GeminiTTSClient {
  constructor() {
    // Sprint G.2 — dukung semua variasi env key: GEMINI_API_KEY(S) koma-separated,
    // GEMINI_API_KEY_1..5, dan GOOGLE_API_KEY_1..5 (nama yang dipakai .env aktual).
    const keys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
      .split(',')
      .map(k => k.trim())
      .filter(Boolean);
    for (let i = 1; i <= 5; i++) {
      const g = process.env[`GEMINI_API_KEY_${i}`];
      if (g && !keys.includes(g.trim())) keys.push(g.trim());
      const goog = process.env[`GOOGLE_API_KEY_${i}`];
      if (goog && !keys.includes(goog.trim())) keys.push(goog.trim());
    }
    this.apiKeys = keys;
    // Sprint G.2 — default model: Gemini 2.5 Flash Preview TTS (TTS native multimodal).
    this.model = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
    // Sprint G.2 — voice prebuilt Gemini TTS (bukan nama Cloud TTS). 'Kore' = firm.
    this.voiceName = process.env.GEMINI_TTS_VOICE || 'Kore';
    this._keyIndex = 0;
  }

  get available() {
    return this.apiKeys.length > 0;
  }

  _nextKey() {
    if (this.apiKeys.length === 0) return null;
    const key = this.apiKeys[this._keyIndex % this.apiKeys.length];
    this._keyIndex++;
    return key;
  }

  /**
   * Generate TTS audio from text.
   * @param {string} text - text to speak
   * @param {object} options - { voiceName, languageCode }
   * @returns Promise<{audioBuffer:Buffer, mimeType:string, sampleRate:number}>}
   */
  async synthesize(text, options = {}) {
    if (!this.available) {
      throw new Error('No Gemini API keys configured (GEMINI_API_KEY, GEMINI_API_KEYS, GOOGLE_API_KEY_1..5)');
    }

    // Normalize text before TTS
    const spokenText = normalizeSpeech(text);

    const body = {
      contents: [{ parts: [{ text: spokenText }] }],
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

    // Sprint G.2 — 429 retry: free-tier Gemini heeft limiet ±10 TTS/min/key.
    // Parse "Please retry in Xs" → backoff, rotate key, max 3 attempt.
    const maxAttempts = parseInt(process.env.GEMINI_TTS_MAX_TRIES || '3', 10);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const key = this._nextKey();
      const url = `${BASE_URL}/models/${this.model}:generateContent?key=${key}`;
      try {
        // Sprint G.2 — timeout 120s: teks jawaban panjang (multi-pesan) bisa
        // membuat TTS 2.5-preview >60s. Versi lama 60s sering timeout.
        const response = await axios.post(url, body, {
          timeout: parseInt(process.env.GEMINI_TTS_TIMEOUT_MS || '120000', 10),
          responseType: 'json',
        });

        const candidate = response.data.candidates?.[0];
        const part = candidate?.content?.parts?.find(p => p.inlineData);
        if (!part?.inlineData?.data) {
          throw new Error('No audio data in Gemini response');
        }

        const audioBuffer = Buffer.from(part.inlineData.data, 'base64');
        const mimeType = part.inlineData.mimeType || 'audio/pcm';
        // Sprint G.2 — sample rate aktual dari response (mis. "audio/L16;codec=pcm;rate=24000")
        // agar WAV & viseme tidak salah kecepatan jika model mengembalikan rate lain.
        return {
          audioBuffer,
          mimeType,
          sampleRate: GeminiTTSClient.parseSampleRate(mimeType) || 24000,
        };
      } catch (error) {
        const status = error.response?.status;
        const detail = error.response?.data?.error?.message || error.message;
        if (status === 429 && attempt < maxAttempts - 1) {
          const m = /retry in ([\d.]+)s/i.exec(detail);
          const wait = m ? parseFloat(m[1]) : 30;
          console.warn(`[GeminiTTS] 429 quota → retry in ${wait.toFixed(0)}s (attempt ${attempt + 2}/${maxAttempts})`);
          await new Promise((r) => setTimeout(r, wait * 1000 + 800));
          continue;
        }
        throw new Error(`Gemini TTS error (${status}): ${detail}`);
      }
    }
    // Unreachable (loop always throws or returns) — guard untuk static analyzers.
    throw new Error('Gemini TTS error: all attempts exhausted');
  }

  /**
   * Sprint G.2 — pcmToVisemes: analisis energi RMS per frame 40ms dari PCM buffer
   * (output TTS Gemini) → mouthCues format identik Rhubarb [{start,end,value}]
   * (start/end dalam detik, value alfabet Rhubarb: X B C D A O — semuanya punya
   * SVG di frontend, BotCharacter.jsx:21-37).
   * Frontend tick 40ms (BotCharacter.jsx:195) → frame 40ms = 1:1 tanpa gap.
   * @param {Buffer} pcmBuffer - raw PCM 16-bit signed LE mono
   * @param {number} sampleRate - default 24000 (Gemini TTS)
   * @param {number} frameMs - default 40
   * @returns {object|null} { mouthCues: [{start,end,value}] } — null jika error
   *          (frontend aman fallback ke loop bibir)
   */
  pcmToVisemes(pcmBuffer, sampleRate = 24000, frameMs = 40) {
    try {
      if (!pcmBuffer || pcmBuffer.length < 2) return null;
      const sampleCount = Math.floor(pcmBuffer.length / 2);
      const samples = new Int16Array(
        pcmBuffer.buffer, pcmBuffer.byteOffset, sampleCount
      );
      const frameSamples = Math.max(1, Math.round(sampleRate * frameMs / 1000));
      const frameCount = Math.floor(sampleCount / frameSamples);
      if (frameCount < 1) return null;

      // RMS per frame + peak untuk normalisasi
      const rms = new Float64Array(frameCount);
      let peak = 0;
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
      if (peak <= 0) return null; // buffer diam total → tidak ada lip-sync

      // Threshold map (normalisasi vs peak): X <0.05 | B <0.15 | C <0.30 | D <0.50 | A <0.70 | else O
      const TH = [0.036, 0.119, 0.261, 0.473, 0.708]; // dikalibrasi 12 Sep 2026 dari RMS sine wave normalized
      const mapViseme = (n) =>
        n < TH[0] ? 'X' : n < TH[1] ? 'B' : n < TH[2] ? 'C' :
        n < TH[3] ? 'D' : n < TH[4] ? 'A' : 'O';

      const frameDur = frameMs / 1000;
      const cues = [];
      let cur = null;
      for (let f = 0; f < frameCount; f++) {
        const v = mapViseme(rms[f] / peak);
        const t0 = f * frameDur;
        if (cur && cur.value === v) {
          cur.end = t0 + frameDur;   // merge cue adjacent same-value
        } else {
          cur = { start: t0, end: t0 + frameDur, value: v };
          cues.push(cur);
        }
      }
      return { mouthCues: cues };
    } catch (err) {
      console.warn('[GeminiTTS] pcmToVisemes failed:', err.message);
      return null; // frontend fallback ke loop bibir — tidak pernah throw
    }
  }

  /** Parse "rate=" dari mimeType (mis. "audio/L16;codec=pcm;rate=24000") */
  static parseSampleRate(mimeType) {
    if (!mimeType) return null;
    const m = /rate=(\d+)/i.exec(String(mimeType));
    return m ? parseInt(m[1], 10) : null;
  }

  /**
   * Convert PCM buffer to WAV format.
   * @param {Buffer} pcmBuffer
   * @param {number} sampleRate - default 24000
   * @param {number} channels - default 1 (mono)
   * @returns {Buffer} WAV formatted buffer
   */
  pcmToWav(pcmBuffer, sampleRate = 24000, channels = 1) {
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = pcmBuffer.length;

    const wavBuffer = Buffer.alloc(44 + dataSize);

    // RIFF header
    wavBuffer.write('RIFF', 0);
    wavBuffer.writeUInt32LE(36 + dataSize, 4);
    wavBuffer.write('WAVE', 8);

    // fmt chunk
    wavBuffer.write('fmt ', 12);
    wavBuffer.writeUInt32LE(16, 16); // chunk size
    wavBuffer.writeUInt16LE(1, 20); // PCM format
    wavBuffer.writeUInt16LE(channels, 22);
    wavBuffer.writeUInt32LE(sampleRate, 24);
    wavBuffer.writeUInt32LE(byteRate, 28);
    wavBuffer.writeUInt16LE(blockAlign, 32);
    wavBuffer.writeUInt16LE(bitsPerSample, 34);

    // data chunk
    wavBuffer.write('data', 36);
    wavBuffer.writeUInt32LE(dataSize, 40);
    pcmBuffer.copy(wavBuffer, 44);

    return wavBuffer;
  }

  /**
   * Health check — verify at least one key works.
   */
  async healthCheck() {
    if (!this.available) return false;
    try {
      const key = this._nextKey();
      await axios.get(`${BASE_URL}/models?key=${key}&pageSize=1`, { timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = new GeminiTTSClient();

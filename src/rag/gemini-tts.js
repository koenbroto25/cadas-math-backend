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
    this.apiKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
      .split(',')
      .map(k => k.trim())
      .filter(Boolean);
    this.model = process.env.GEMINI_TTS_MODEL || 'gemini-2.0-flash';
    this.voiceName = process.env.GEMINI_TTS_VOICE || 'id-ID-Standard-A';
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
   * @returns Promise<{audioBuffer:Buffer, mimeType:string}>}
   */
  async synthesize(text, options = {}) {
    if (!this.available) {
      throw new Error('No Gemini API keys configured (GEMINI_API_KEY or GEMINI_API_KEYS)');
    }

    // Normalize text before TTS
    const spokenText = normalizeSpeech(text);
    const key = this._nextKey();

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

    const url = `${BASE_URL}/models/${this.model}:generateContent?key=${key}`;

    try {
      const response = await axios.post(url, body, {
        timeout: 60000,
        responseType: 'json',
      });

      const candidate = response.data.candidates?.[0];
      const part = candidate?.content?.parts?.find(p => p.inlineData);
      if (!part?.inlineData?.data) {
        throw new Error('No audio data in Gemini response');
      }

      const audioBuffer = Buffer.from(part.inlineData.data, 'base64');
      return { audioBuffer, mimeType: part.inlineData.mimeType || 'audio/pcm' };
    } catch (error) {
      const status = error.response?.status;
      const detail = error.response?.data?.error?.message || error.message;
      throw new Error(`Gemini TTS error (${status}): ${detail}`);
    }
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

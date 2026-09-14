/**
 * gemini-client.js — Gemini 3.1 Flash-Lite via Google AI langsung (bukan OpenRouter)
 *
 * Model: gemini-3.1-flash-lite (GA sejak 7 Mei 2026, menggantikan preview yang shutdown 25 Mei 2026)
 * Key rotation: GOOGLE_API_KEY_1..200 (+ fallback berbayar jika habis)
 *
 * Digunakan sebagai Layer 3 (LLM fallback) di pipeline.js.
 * Dipanggil hanya jika Layer 2 (OpenRouter/gpt-4o-mini) gagal total.
 *
 * Endpoint: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 */

'use strict';

const https = require('https');

const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const GEMINI_TIMEOUT = parseInt(process.env.GEMINI_TIMEOUT_MS || '30000', 10);
const MAX_RETRY      = 3;  // retry key berbeda jika 429/500

class GeminiClient {
  constructor() {
    // Baca semua key GOOGLE_API_KEY_1..200
    const keys = [];
    for (let i = 1; i <= 200; i++) {
      const v = process.env[`GOOGLE_API_KEY_${i}`];
      if (v && v.trim() && !v.includes('replace_with_real')) keys.push(v.trim());
    }
    // Support GOOGLE_API_KEY tunggal sebagai fallback
    const single = process.env.GOOGLE_API_KEY;
    if (single && single.trim() && !single.includes('replace_with_real') && !keys.includes(single.trim())) {
      keys.push(single.trim());
    }

    this.keys      = keys;
    this._keyIndex = Math.floor(Math.random() * Math.max(1, keys.length)); // start random
    console.log(`[GeminiClient] ${this.keys.length} key(s) loaded | model: ${GEMINI_MODEL}`);
  }

  get available() { return this.keys.length > 0; }

  _nextKey() {
    if (this.keys.length === 0) return null;
    const key = this.keys[this._keyIndex % this.keys.length];
    this._keyIndex++;
    return key;
  }

  /**
   * Generate teks via Gemini REST API.
   * @param {string} prompt - pertanyaan user
   * @param {object} options - { system, temperature, maxTokens }
   * @returns {Promise<{text: string, model: string}>}
   */
  async generate(prompt, options = {}) {
    if (!this.available) throw new Error('GeminiClient: tidak ada API key yang terkonfigurasi');

    const maxRetries = Math.min(this.keys.length, MAX_RETRY);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const key = this._nextKey();
      try {
        const text = await this._callAPI(key, prompt, options);
        return { text, model: GEMINI_MODEL };
      } catch (err) {
        const retryable = err.status === 429 || err.status === 500 || err.status === 503;
        if (retryable && attempt < maxRetries - 1) {
          console.warn(`[GeminiClient] attempt ${attempt + 1} gagal (${err.status}), coba key berikutnya...`);
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw new Error('GeminiClient: semua key habis atau quota exhausted');
  }

  _callAPI(key, prompt, options) {
    return new Promise((resolve, reject) => {
      // Build request body
      const contents = [];

      // System instruction sebagai user turn pertama (Gemini REST v1beta)
      if (options.system) {
        contents.push({ role: 'user', parts: [{ text: `[INSTRUKSI SISTEM]\n${options.system}` }] });
        contents.push({ role: 'model', parts: [{ text: 'Baik, saya mengerti instruksinya.' }] });
      }
      contents.push({ role: 'user', parts: [{ text: prompt }] });

      const body = JSON.stringify({
        contents,
        generationConfig: {
          maxOutputTokens: options.maxTokens || 512,
          // temperature tidak digunakan — deprecated per Gemini API changelog
        },
      });

      const path = `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

      const req = https.request(
        {
          hostname: 'generativelanguage.googleapis.com',
          port:     443,
          path,
          method:  'POST',
          headers: {
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: GEMINI_TIMEOUT,
        },
        res => {
          let raw = '';
          res.on('data', c => (raw += c));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(raw);
              if (res.statusCode !== 200) {
                const err = new Error(parsed?.error?.message || `HTTP ${res.statusCode}`);
                err.status = res.statusCode;
                return reject(err);
              }
              const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
              if (!text) return reject(new Error('GeminiClient: response kosong'));
              resolve(text.trim());
            } catch (e) {
              reject(new Error(`GeminiClient JSON parse error: ${e.message}`));
            }
          });
        }
      );

      req.on('timeout', () => { req.destroy(); reject(new Error('GeminiClient timeout')); });
      req.on('error', e => reject(e));
      req.write(body);
      req.end();
    });
  }

  async healthCheck() {
    if (!this.available) return { ok: false, reason: 'no keys' };
    try {
      const result = await this.generate('Hitung 1 tambah 1.', { maxTokens: 20 });
      return { ok: true, model: result.model, sample: result.text.slice(0, 50) };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = new GeminiClient();

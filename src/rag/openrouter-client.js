/**
 * OpenRouter API client — replaces Ollama untuk FASE 8.
 * Key rotation: 93 key bernomor (OPENROUTER_API_KEY_1..93)
 *
 * Dual model strategy:
 *   Layer 3 (primary)  = openai/gpt-4o-mini
 *                        $0.15/M in · $0.60/M out
 *   Layer 4 (fallback) = google/gemini-3.1-flash-lite-preview
 *                        $0.10/M in · $0.40/M out
 *                        MATH 88.5% · #1 math word problems benchmark Aug 2026
 *                        Distilasi Gemini 3 Pro · Elo 1432
 *
 * Catatan model:
 *   gemini-2.5-flash — DEPRECATED/mati per Sep 2026, jangan dipakai
 *   gemini-3-flash-preview — tersedia tapi lebih mahal dari lite-preview
 *   gemini-3.1-flash-lite-preview — PILIHAN: lebih murah, akurasi math lebih tinggi
 */

const axios = require('axios');

const BASE_URL = 'https://openrouter.ai/api/v1';

// Layer 3: primary (93 key rotasi)
const MODEL_PRIMARY  = process.env.OPENROUTER_MODEL          || 'openai/gpt-4o-mini';
// Layer 4: fallback — gemini-3.1-flash-lite (#1 math word problems, Aug 2026)
const MODEL_FALLBACK = process.env.OPENROUTER_MODEL_FALLBACK || 'google/gemini-3.1-flash-lite';

class OpenRouterClient {
  constructor() {
    // Baca semua key bernomor 1..93
    const numbered = [];
    for (let i = 1; i <= 93; i++) {
      const v = process.env[`OPENROUTER_API_KEY_${i}`];
      if (v && v.trim() && !v.includes('ganti_key')) numbered.push(v.trim());
    }
    // Support OPENROUTER_API_KEYS (comma-separated) atau OPENROUTER_API_KEY tunggal
    const base = (process.env.OPENROUTER_API_KEYS || process.env.OPENROUTER_API_KEY || '')
      .split(',')
      .map(k => k.trim())
      .filter(k => k && !k.includes('ganti'));

    // Gabung, deduplikasi
    const all = [...base, ...numbered.filter(k => !base.includes(k))];
    this.apiKeys   = all;
    this.timeoutMs = parseInt(process.env.OPENROUTER_TIMEOUT_MS || '30000', 10);
    this._keyIndex = 0;

    console.log(`[OpenRouter] ${this.apiKeys.length} key(s) loaded | primary: ${MODEL_PRIMARY} | fallback: ${MODEL_FALLBACK}`);
  }

  get available() { return this.apiKeys.length > 0; }

  _nextKey() {
    if (this.apiKeys.length === 0) return null;
    const key = this.apiKeys[this._keyIndex % this.apiKeys.length];
    this._keyIndex++;
    return key;
  }

  /**
   * Generate via OpenRouter dengan key rotation.
   * Retry semua key yang tersedia (max 5 attempt) pada 401/402/429.
   * @param {string} prompt
   * @param {object} options - { system, temperature, maxTokens, model }
   * @returns {Promise<{text:string, model:string, usage?:object}>}
   */
  async generate(prompt, options = {}) {
    if (!this.available) {
      throw new Error('No OpenRouter API keys configured');
    }

    const model      = options.model || MODEL_PRIMARY;
    const maxRetries = Math.min(this.apiKeys.length, 5);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const key = this._nextKey();

      const body = {
        model,
        messages: [
          ...(options.system ? [{ role: 'system', content: options.system }] : []),
          { role: 'user', content: prompt },
        ],
        temperature: options.temperature ?? 0.4,
        max_tokens:  options.maxTokens  || 512,
      };

      try {
        const response = await axios.post(
          `${BASE_URL}/chat/completions`,
          body,
          {
            headers: {
              'Authorization': `Bearer ${key}`,
              'Content-Type':  'application/json',
              'HTTP-Referer':  process.env.APP_REFERER || 'http://localhost:3000',
              'X-Title':       process.env.APP_TITLE   || 'Cadas App',
            },
            timeout: this.timeoutMs,
          }
        );

        const text = response.data.choices?.[0]?.message?.content || '';
        return { text, model, usage: response.data.usage };

      } catch (error) {
        const status = error.response?.status;
        const detail = error.response?.data?.error?.message || error.message;

        if ([401, 402, 429].includes(status) && attempt < maxRetries - 1) {
          console.warn(`[OpenRouter] Key attempt ${attempt + 1} failed (${status}): ${detail}. Trying next key...`);
          continue;
        }
        throw new Error(`OpenRouter error (${status}): ${detail}`);
      }
    }
    throw new Error('OpenRouter: semua key habis atau quota exhausted');
  }

  /**
   * generateWithFallback — coba MODEL_PRIMARY dulu, jika gagal coba MODEL_FALLBACK.
   * Layer 3 (gpt-4o-mini) → Layer 4 (gemini-3.1-flash-lite-preview).
   * @returns {Promise<{text, model, layer, usage?}>}
   */
  async generateWithFallback(prompt, options = {}) {
    // Layer 3: primary (gpt-4o-mini)
    try {
      const result = await this.generate(prompt, { ...options, model: MODEL_PRIMARY });
      return { ...result, layer: 3 };
    } catch (err) {
      console.warn(`[OpenRouter] Layer 3 (${MODEL_PRIMARY}) gagal: ${err.message}. Coba Layer 4...`);
    }

    // Layer 4: fallback (gemini-3.1-flash-lite-preview)
    try {
      const result = await this.generate(prompt, { ...options, model: MODEL_FALLBACK });
      return { ...result, layer: 4 };
    } catch (err) {
      throw new Error(`[OpenRouter] Layer 3 & 4 keduanya gagal: ${err.message}`);
    }
  }

  /**
   * Health check — verifikasi satu key bekerja.
   */
  async healthCheck() {
    if (!this.available) return { ok: false, reason: 'no keys' };
    try {
      const key = this._nextKey();
      const res = await axios.get(`${BASE_URL}/auth/key`, {
        headers: { 'Authorization': `Bearer ${key}` },
        timeout: 10000,
      });
      return { ok: true, label: res.data?.data?.label };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }
}

module.exports = new OpenRouterClient();

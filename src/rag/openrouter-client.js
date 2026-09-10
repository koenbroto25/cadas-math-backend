/**
 * OpenRouter API client — replaces Ollama for FASE 8.
 * Simple HTTP calls to OpenRouter with key rotation support.
 */

const axios = require('axios');

const BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

class OpenRouterClient {
  constructor() {
    // Priority: OPENROUTER_API_KEYS (comma-separated) > OPENROUTER_API_KEY (single)
    // > OPENROUTER_API_KEY_1.._5 (numbered individual keys).
    const numbered = [];
    for (let i = 1; i <= 5; i++) {
      const v = process.env[`OPENROUTER_API_KEY_${i}`];
      if (v) numbered.push(v.trim());
    }
    const base = (process.env.OPENROUTER_API_KEYS || process.env.OPENROUTER_API_KEY || '')
      .split(',')
      .map(k => k.trim())
      .filter(Boolean);
    this.apiKeys = base.length > 0
      ? base.concat(numbered.filter(k => !base.includes(k)))
      : numbered;
    this.model = DEFAULT_MODEL;
    this.timeoutMs = parseInt(process.env.OPENROUTER_TIMEOUT_MS || '30000', 10);
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
   * Generate a completion via OpenRouter.
   * @param {string} prompt - user message
   * @param {object} options - { system, temperature, maxTokens, model }
   * @returns {Promise<{text:string, model:string}>}
   */
  async generate(prompt, options = {}) {
    if (!this.available) {
      throw new Error('No OpenRouter API keys configured (OPENROUTER_API_KEY, OPENROUTER_API_KEYS, or OPENROUTER_API_KEY_1.._5)');
    }

    const model = options.model || this.model;
    const maxRetries = Math.min(this.apiKeys.length, 3);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const key = this._nextKey();

      const body = {
        model,
        messages: [
          ...(options.system ? [{ role: 'system', content: options.system }] : []),
          { role: 'user', content: prompt },
        ],
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens || 1024,
      };

      try {
        const response = await axios.post(
          `${BASE_URL}/chat/completions`,
          body,
          {
            headers: {
              'Authorization': `Bearer ${key}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': process.env.APP_REFERER || 'http://localhost:3000',
              'X-Title': process.env.APP_TITLE || 'Cadas App',
            },
            timeout: this.timeoutMs,
          }
        );

        const text = response.data.choices?.[0]?.message?.content || '';
        return { text, model, usage: response.data.usage };
      } catch (error) {
        const status = error.response?.status;
        const detail = error.response?.data?.error?.message || error.message;
        // Retry on auth/credit/rate-limit errors with next key
        if ([401, 402, 429].includes(status) && attempt < maxRetries - 1) {
          console.warn(`[OpenRouter] Key failed (${status}): ${detail}. Trying next key...`);
          continue;
        }
        throw new Error(`OpenRouter error (${status}): ${detail}`);
      }
    }
    throw new Error('OpenRouter error: all keys exhausted');
  }

  /**
   * Health check — verify at least one key works.
   */
  async healthCheck() {
    if (!this.available) return false;
    try {
      const key = this._nextKey();
      await axios.get(`${BASE_URL}/auth/key`, {
        headers: { 'Authorization': `Bearer ${key}` },
        timeout: 10000,
      });
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = new OpenRouterClient();

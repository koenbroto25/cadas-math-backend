/**
 * OpenRouter API client — replaces Ollama for FASE 8.
 * Simple HTTP calls to OpenRouter with key rotation support.
 */

const axios = require('axios');

const BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001';

class OpenRouterClient {
  constructor() {
    this.apiKeys = (process.env.OPENROUTER_API_KEYS || process.env.OPENROUTER_API_KEY || '')
      .split(',')
      .map(k => k.trim())
      .filter(Boolean);
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
      throw new Error('No OpenRouter API keys configured (OPENROUTER_API_KEY or OPENROUTER_API_KEYS)');
    }

    const key = this._nextKey();
    const model = options.model || this.model;

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
      throw new Error(`OpenRouter error (${status}): ${detail}`);
    }
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

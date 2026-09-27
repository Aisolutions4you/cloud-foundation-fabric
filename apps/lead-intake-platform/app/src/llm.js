// Portable LLM router. Every provider is OpenAI-compatible, tried in order
// (LLM_PROVIDER_ORDER) with a timeout; first success wins. If none is
// configured or all fail, callers get `null` and fall back to deterministic
// logic, so the intake funnel never goes down because a model did.

import { llmProviders, settings } from './config.js';

export class LLMRouter {
  constructor({ providers = llmProviders(), timeoutMs = settings.llmTimeoutMs, fetchImpl = fetch } = {}) {
    this.providers = providers;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.health = Object.fromEntries(providers.map((p) => [p.name, { ok: null, lastError: null }]));
  }

  get enabled() {
    return this.providers.length > 0;
  }

  async chat(messages, { json = false, temperature = 0.4, maxTokens = 600 } = {}) {
    for (const p of this.providers) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const body = { model: p.model, messages, temperature, max_tokens: maxTokens };
        if (json) body.response_format = { type: 'json_object' };
        const res = await this.fetch(`${p.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          signal: ctrl.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p.apiKey}`,
            ...p.headers,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content ?? '';
        this.health[p.name] = { ok: true, lastError: null };
        return { text, provider: p.name, model: p.model };
      } catch (err) {
        this.health[p.name] = { ok: false, lastError: String(err.message ?? err) };
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  async chatJson(messages, opts = {}) {
    const r = await this.chat(messages, { ...opts, json: true });
    if (!r) return null;
    try {
      const m = r.text.match(/\{[\s\S]*\}/);
      return { ...r, data: JSON.parse(m ? m[0] : r.text) };
    } catch {
      return null;
    }
  }
}

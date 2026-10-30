'use strict';
/**
 * Capa opcional de LLM (compatible OpenAI /chat/completions).
 * Si no está configurada o falla, el agente usa sus generadores deterministas.
 */
async function complete(settings, system, user, { timeout = 20000 } = {}) {
  const cfg = settings && settings.llm;
  if (!cfg || !cfg.apiKey || !cfg.baseUrl || !cfg.model) return null;
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.4,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

module.exports = { complete };

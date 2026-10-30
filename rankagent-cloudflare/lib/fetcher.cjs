'use strict';
/**
 * Cliente HTTP seguro con timeout, redirecciones y medición de tiempos.
 */
const UA = 'RankAgentBot/1.0 (+https://rankagent.local/bot; auditoria SEO)';

async function fetchResource(url, opts = {}) {
  const timeout = opts.timeout || 12000;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-CL,es;q=0.9,en;q=0.6',
      },
    });
    const body = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      finalUrl: res.url,
      headers: Object.fromEntries(res.headers.entries()),
      body,
      bytes: new TextEncoder().encode(body).length,
      timeMs: Date.now() - started,
      error: null,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      headers: {},
      body: '',
      bytes: 0,
      timeMs: Date.now() - started,
      error: e.name === 'AbortError' ? `timeout ${timeout}ms` : String(e.message || e),
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchResource, UA };

/**
 * Entrada del Worker RankAgent para Cloudflare.
 * - /api/*  → API (Workers, D1, auth, streaming del agente)
 * *         → assets estáticos (SPA) desde [assets] en wrangler.toml
 * - scheduled() → cron: recuperación de corridas + re-check autónomo
 */
import { handleApi } from './api.js';
import { cronSweep } from './runner.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event, env, ctx) {
    const job = (async () => {
      try {
        console.log('[cron] entrando; cronSweep =', typeof cronSweep);
        await cronSweep(env);
        console.log('[cron] completado OK');
      } catch (e) {
        console.error('[cron] ERROR:', e && (e.stack || e.message) ? String(e.stack || e.message) : String(e));
      }
    })();
    ctx.waitUntil(job);
  },
};

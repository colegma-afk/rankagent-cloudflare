/**
 * Ejecución del agente en el Worker:
 * - startStreamRun: POST /api/clients/:id/run → ejecuta y transmite eventos (SSE por el cuerpo).
 * - runSilently: para el cron (re-check autónomo).
 * - cronSweep: recuperación de corridas huérfanas + re-ejecución programada.
 */
import agent from '../lib/agent.cjs';
import store from './store.cjs';

const active = new Set(); // clientIds en corrida (por isolate)

async function ensureFresh(env) {
  store.init(env.DB);
  await store.sweepStaleRuns();
}

async function latestActiveRun(clientId) {
  const runs = await store.getRuns(clientId);
  const now = Date.now();
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    if (r.status === 'running' || r.status === 'queued') {
      const at = r.startedAt ? Date.parse(r.startedAt) : 0;
      if (now - at < 10 * 60 * 1000) return r;
    }
  }
  return null;
}

function sseWriter() {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  return {
    readable,
    emit(type, payload) {
      try {
        writer.write(enc.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)).catch(() => {});
      } catch { /* cliente desconectado */ }
    },
    close() { try { writer.close(); } catch { /* ya cerrado */ } },
  };
}

/**
 * Crea la corrida y la ejecuta transmitiendo eventos SSE en el cuerpo de la respuesta.
 * ctx.waitUntil mantiene el Worker vivo hasta terminar.
 */
export async function startStreamRun(clientId, env, ctx) {
  await ensureFresh(env);
  const client = await store.getClient(clientId);
  if (!client) { const e = new Error('Cliente no encontrado'); e.status = 404; throw e; }
  if (!client.url) { const e = new Error('El cliente no tiene URL'); e.status = 400; throw e; }
  if (active.has(clientId)) { const e = new Error('El agente ya está corriendo para este cliente'); e.status = 409; throw e; }
  const inflight = await latestActiveRun(clientId);
  if (inflight) { const e = new Error('El agente ya está corriendo para este cliente'); e.status = 409; throw e; }

  active.add(clientId);
  const run = agent.newRun(clientId);
  run.status = 'running';
  run.startedAt = new Date().toISOString();
  await store.upsertRun(run);

  const chan = sseWriter();
  const task = (async () => {
    try {
      await agent.runAgent(run, client, chan.emit);
    } catch (err) {
      run.status = 'error';
      run.finishedAt = new Date().toISOString();
      run.error = String((err && err.message) || err);
      chan.emit('done', { runId: run.id, status: 'error', error: run.error });
      try { await store.upsertRun(run); } catch { /* noop */ }
    } finally {
      chan.close();
      active.delete(clientId);
    }
  })();
  ctx.waitUntil(task);

  return new Response(chan.readable, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

/** Ejecución silenciosa (cron). */
export async function runSilently(clientId, env) {
  await ensureFresh(env);
  const client = await store.getClient(clientId);
  if (!client || !client.url || active.has(clientId)) return;
  const inflight = await latestActiveRun(clientId);
  if (inflight) return;
  active.add(clientId);
  const run = agent.newRun(clientId);
  run.status = 'running';
  run.startedAt = new Date().toISOString();
  await store.upsertRun(run);
  try {
    await agent.runAgent(run, client, () => {});
  } catch (err) {
    run.status = 'error';
    run.finishedAt = new Date().toISOString();
    run.error = String((err && err.message) || err);
    try { await store.upsertRun(run); } catch { /* noop */ }
  } finally {
    active.delete(clientId);
  }
}

/** Cron: recuperación + re-ejecución autónoma si `recheckHours` lo pide. */
export async function cronSweep(env) {
  store.init(env.DB);
  await store.sweepStaleRuns();
  const settings = await store.getSettings();
  if (!settings.recheckHours) return;
  const maxAge = settings.recheckHours * 3600 * 1000;
  const clients = await store.getClients();
  for (const c of clients) {
    if (!c.url) continue;
    const lastAt = c.lastRunAt ? Date.parse(c.lastRunAt) : 0;
    if (Date.now() - lastAt > maxAge) {
      await runSilently(c.id, env);
    }
  }
}

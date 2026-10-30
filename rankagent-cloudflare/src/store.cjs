'use strict';
/**
 * Adaptador de persistencia sobre Cloudflare D1 (SQLite).
 * Misma API que el store JSON de la versión Node, pero asíncrona.
 * init(env.DB) se llama al inicio de cada request/cron.
 */

let DB = null;
function init(db) { DB = db; }
function need() { if (!DB) throw new Error('D1 no inicializado (falta store.init(env.DB))'); }

function uid(prefix) {
  const rnd = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return prefix + '_' + Date.now().toString(36) + rnd;
}

const DEFAULT_SETTINGS = {
  agencyName: 'Mi Agencia',
  autonomous: true,
  recheckHours: 24,
  llm: { baseUrl: '', apiKey: '', model: '' },
};

function normalizeUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    return parsed.origin + (parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/$/, ''));
  } catch { return u; }
}

/* ---------------- settings (fila única 'app') ---------------- */

async function getSettings() {
  need();
  try {
    const row = await DB.prepare('SELECT value FROM settings WHERE key = ?').bind('app').first();
    if (!row) return { ...DEFAULT_SETTINGS, llm: { ...DEFAULT_SETTINGS.llm } };
    const saved = JSON.parse(row.value);
    return Object.assign({}, DEFAULT_SETTINGS, saved, {
      llm: Object.assign({}, DEFAULT_SETTINGS.llm, saved.llm || {}),
    });
  } catch {
    return { ...DEFAULT_SETTINGS, llm: { ...DEFAULT_SETTINGS.llm } };
  }
}

async function updateSettings(patch) {
  need();
  const s = await getSettings();
  if (typeof patch.agencyName === 'string') s.agencyName = patch.agencyName.slice(0, 120);
  if (typeof patch.autonomous === 'boolean') s.autonomous = patch.autonomous;
  if (typeof patch.recheckHours === 'number' && Number.isFinite(patch.recheckHours)) {
    s.recheckHours = Math.max(0, Math.min(720, patch.recheckHours));
  }
  if (patch.llm && typeof patch.llm === 'object') {
    s.llm = {
      baseUrl: String(patch.llm.baseUrl || '').slice(0, 300),
      apiKey: String(patch.llm.apiKey || '').slice(0, 300),
      model: String(patch.llm.model || '').slice(0, 120),
    };
  }
  await DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind('app', JSON.stringify(s)).run();
  return s;
}

/* ---------------- clientes ---------------- */

function rowToClient(r) {
  if (!r) return null;
  let keywords = [];
  try { keywords = JSON.parse(r.keywords || '[]'); } catch {}
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    niche: r.niche,
    market: r.market,
    type: r.type,
    keywords,
    competitors: r.competitors || '',
    notes: r.notes || '',
    autoRun: !!r.auto_run,
    indexnowKey: r.indexnow_key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastRunId: r.last_run_id || null,
    lastScore: r.last_score == null ? null : r.last_score,
    lastCriticals: r.last_criticals == null ? null : r.last_criticals,
    lastRunAt: r.last_run_at || null,
  };
}

async function getClients() {
  need();
  const res = await DB.prepare('SELECT * FROM clients ORDER BY rowid ASC').all();
  return res.results.map(rowToClient);
}

async function getClient(id) {
  need();
  return rowToClient(await DB.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first());
}

async function createClient(data) {
  need();
  const now = new Date().toISOString();
  const c = {
    id: uid('c'),
    name: String(data.name || 'Sin nombre').slice(0, 120),
    url: normalizeUrl(data.url || ''),
    niche: String(data.niche || '').slice(0, 160),
    market: data.market || 'es-CL',
    type: data.type || 'servicios',
    keywords: (Array.isArray(data.keywords) ? data.keywords : String(data.keywords || '').split(','))
      .map((k) => String(k).trim()).filter(Boolean).slice(0, 20),
    competitors: String(data.competitors || '').slice(0, 400),
    notes: String(data.notes || '').slice(0, 2000),
    autoRun: data.autoRun !== false,
    indexnowKey: globalThis.crypto.randomUUID().replace(/-/g, ''),
    createdAt: now,
    updatedAt: now,
  };
  await DB.prepare(
    `INSERT INTO clients (id, name, url, niche, market, type, keywords, competitors, notes, auto_run, indexnow_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(c.id, c.name, c.url, c.niche, c.market, c.type, JSON.stringify(c.keywords),
    c.competitors, c.notes, c.autoRun ? 1 : 0, c.indexnowKey, c.createdAt, c.updatedAt).run();
  return c;
}

const CLIENT_FIELDS = {
  name: 'name', url: 'url', niche: 'niche', market: 'market', type: 'type',
  competitors: 'competitors', notes: 'notes',
};

async function updateClient(id, patch) {
  need();
  const existing = await getClient(id);
  if (!existing) return null;
  const sets = [];
  const binds = [];
  for (const [key, col] of Object.entries(CLIENT_FIELDS)) {
    if (key in patch) {
      let v = String(patch[key] == null ? '' : patch[key]);
      if (key === 'url') v = normalizeUrl(v);
      sets.push(`${col} = ?`); binds.push(v.slice(0, key === 'notes' ? 2000 : 400));
    }
  }
  if ('keywords' in patch) {
    const kws = (Array.isArray(patch.keywords) ? patch.keywords : String(patch.keywords || '').split(','))
      .map((k) => String(k).trim()).filter(Boolean).slice(0, 20);
    sets.push('keywords = ?'); binds.push(JSON.stringify(kws));
  }
  if ('autoRun' in patch) { sets.push('auto_run = ?'); binds.push(patch.autoRun ? 1 : 0); }
  sets.push('updated_at = ?'); binds.push(new Date().toISOString());
  binds.push(id);
  await DB.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return getClient(id);
}

async function updateClientMeta(id, patch) {
  need();
  const map = {
    lastRunId: ['last_run_id', (v) => (v == null ? null : String(v))],
    lastScore: ['last_score', (v) => (v == null ? null : Number(v))],
    lastCriticals: ['last_criticals', (v) => (v == null ? null : Number(v))],
    lastRunAt: ['last_run_at', (v) => (v == null ? null : String(v))],
  };
  const sets = [];
  const binds = [];
  for (const [k, [col, fn]] of Object.entries(map)) {
    if (k in patch) { sets.push(`${col} = ?`); binds.push(fn(patch[k])); }
  }
  if (!sets.length) return getClient(id);
  binds.push(id);
  await DB.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return getClient(id);
}

async function deleteClient(id) {
  need();
  await DB.prepare('DELETE FROM runs WHERE client_id = ?').bind(id).run();
  await DB.prepare('UPDATE users SET client_id = NULL WHERE client_id = ?').bind(id).run();
  const res = await DB.prepare('DELETE FROM clients WHERE id = ?').bind(id).run();
  return (res.meta && res.meta.changes) > 0;
}

/* ---------------- corridas ---------------- */

function rowToRun(r) {
  if (!r) return null;
  const parse = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
  return {
    id: r.id,
    clientId: r.client_id,
    status: r.status,
    currentStep: r.current_step || null,
    startedAt: r.started_at || null,
    finishedAt: r.finished_at || null,
    log: parse(r.log, []),
    steps: parse(r.steps, []),
    result: r.result ? parse(r.result, null) : null,
    error: r.error || null,
  };
}

function trimResult(result) {
  if (!result) return null;
  const c = JSON.parse(JSON.stringify(result));
  if (c.audit && c.audit.homepage) {
    delete c.audit.homepage.text;
    delete c.audit.homepage.wordList;
  }
  return c;
}

async function getRuns(clientId) {
  need();
  const res = clientId
    ? await DB.prepare('SELECT * FROM runs WHERE client_id = ? ORDER BY rowid ASC').bind(clientId).all()
    : await DB.prepare('SELECT * FROM runs ORDER BY rowid ASC').all();
  return res.results.map(rowToRun);
}

async function getRun(id) {
  need();
  return rowToRun(await DB.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first());
}

async function upsertRun(run) {
  need();
  const log = JSON.stringify((run.log || []).slice(-400));
  const steps = JSON.stringify(run.steps || []);
  const result = run.result ? JSON.stringify(trimResult(run.result)) : null;
  const b = [run.clientId, run.status, run.currentStep || null, run.startedAt || null,
    run.finishedAt || null, log, steps, result, run.error || null];
  const upd = await DB.prepare(
    `UPDATE runs SET client_id = ?, status = ?, current_step = ?, started_at = ?, finished_at = ?,
     log = ?, steps = ?, result = ?, error = ? WHERE id = ?`
  ).bind(...b, run.id).run();
  if (!upd.meta || !upd.meta.changes) {
    await DB.prepare(
      `INSERT INTO runs (id, client_id, status, current_step, started_at, finished_at, log, steps, result, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(run.id, ...b).run();
  }
  // mantener solo las últimas 40 corridas por cliente
  await DB.prepare(
    `DELETE FROM runs WHERE client_id = ? AND id NOT IN (
       SELECT id FROM runs WHERE client_id = ? ORDER BY rowid DESC LIMIT 40)`
  ).bind(run.clientId, run.clientId).run();
  return run;
}

/** Corridas marcadas como activas hace >10 min → interrumpidas (recuperación). */
async function sweepStaleRuns() {
  need();
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await DB.prepare(
    `UPDATE runs SET status = 'error', finished_at = ?, error = 'Corrida interrumpida'
     WHERE status IN ('running', 'queued') AND COALESCE(started_at, '') < ?`
  ).bind(new Date().toISOString(), cutoff).run();
}

module.exports = {
  init, uid,
  getSettings, updateSettings,
  getClients, getClient, createClient, updateClient, updateClientMeta, deleteClient,
  getRuns, getRun, upsertRun, sweepStaleRuns,
  normalizeUrl,
};

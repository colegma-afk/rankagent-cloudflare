/**
 * API RankAgent sobre Cloudflare Workers + D1.
 * Roles: "admin" (agencia, acceso total) · "cliente" (solo su cliente, lectura + re-ejecución).
 */
import store from './store.cjs';
import * as auth from './auth.js';
import { startStreamRun, cronSweep } from './runner.js';
import indexing from '../lib/indexing.cjs';
import reportLayer from '../lib/report.cjs';

const { indexnowPayload, safeOrigin } = indexing;
const { buildReport } = reportLayer;

class HttpError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

async function readBody(request) {
  try {
    const t = await request.text();
    return t ? JSON.parse(t) : {};
  } catch {
    throw new HttpError('JSON inválido', 400);
  }
}

function requireAdmin(user) {
  if (!user || user.role !== 'admin') throw new HttpError('Requiere cuenta de administrador', 403);
}

async function loadClientFor(user, id) {
  const c = await store.getClient(id);
  if (!c) throw new HttpError('Cliente no encontrado', 404);
  if (user.role !== 'admin' && user.clientId !== id) throw new HttpError('Sin acceso a este cliente', 403);
  return c;
}

async function latestResult(clientId) {
  const c = await store.getClient(clientId);
  if (!c) return null;
  let run = c.lastRunId ? await store.getRun(c.lastRunId) : null;
  if (!run || !run.result || !run.result.audit) {
    const runs = await store.getRuns(clientId);
    const done = runs.filter((r) => r.status === 'done' && r.result && r.result.audit)
      .sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')));
    run = done[0] || null;
  }
  return run && run.result && run.result.audit ? run.result : null;
}

/* ---- control de login (simple, por isolate) ---- */
const attempts = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.reset) { attempts.set(ip, { n: 1, reset: now + 60000 }); return true; }
  rec.n++;
  return rec.n <= 12;
}

const loginAttempts = new Map();
function loginRate(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now > rec.reset) { loginAttempts.set(ip, { n: 1, reset: now + 15 * 60000 }); return true; }
  rec.n++;
  return rec.n <= 15;
}

export async function handleApi(request, env, ctx) {
  store.init(env.DB);
  const url = new URL(request.url);
  const method = request.method;
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';

  try {
    /* ================= rutas públicas ================= */

    if (parts[0] === 'health') return json({ ok: true, ts: Date.now() });

    if (parts[0] === 'auth' && parts[1] === 'status' && method === 'GET') {
      const n = await auth.userCount(env);
      return json({ needsSetup: n === 0 });
    }

    if (parts[0] === 'setup' && method === 'POST') {
      if (!rateLimit(ip)) throw new HttpError('Demasiados intentos', 429);
      if ((await auth.userCount(env)) > 0) throw new HttpError('La configuración inicial ya se completó', 403);
      const b = await readBody(request);
      if (!auth.validEmail(b.email)) throw new HttpError('Email inválido', 400);
      if (!auth.validPassword(b.password)) throw new HttpError('La contraseña debe tener al menos 8 caracteres', 400);
      if (!String(b.name || '').trim()) throw new HttpError('Nombre requerido', 400);
      const user = await auth.createUser(env, {
        email: b.email, name: b.name, password: b.password, role: 'admin', clientId: null,
      });
      const token = await auth.createSession(env, user.id);
      return json({ user }, 201, { 'Set-Cookie': auth.sessionCookie(token, request) });
    }

    if (parts[0] === 'auth' && parts[1] === 'login' && method === 'POST') {
      if (!loginRate(ip)) throw new HttpError('Demasiados intentos. Espera unos minutos.', 429);
      const b = await readBody(request);
      const row = await auth.findUserByEmail(env, b.email);
      const ok = row && (await auth.verifyPassword(String(b.password || ''), row.password_hash));
      if (!ok) throw new HttpError('Email o contraseña incorrectos', 401);
      const token = await auth.createSession(env, row.id);
      return json({ user: auth.rowToUser(row) }, 200, { 'Set-Cookie': auth.sessionCookie(token, request) });
    }

    if (parts[0] === 'auth' && parts[1] === 'logout' && method === 'POST') {
      await auth.destroySession(env, request);
      return json({ ok: true }, 200, { 'Set-Cookie': auth.sessionCookie('', request, { clear: true }) });
    }

    if (parts[0] === 'auth' && parts[1] === 'me' && method === 'GET') {
      const user = await auth.getUserFromRequest(env, request);
      if (!user) throw new HttpError('Sesión requerida', 401);
      return json({ user });
    }

    /* ================= autenticación obligatoria ================= */

    const user = await auth.getUserFromRequest(env, request);
    if (!user) throw new HttpError('Sesión requerida', 401);

    /* ---- cron manual (admin) — el cron automático corre en el edge ---- */
    if (parts[0] === 'admin' && parts[1] === 'run-cron' && method === 'POST') {
      requireAdmin(user);
      await cronSweep(env);
      return json({ ok: true, message: 'Cron ejecutado: barrido de corridas + re-check autónomo' });
    }

    /* ---- ajustes ---- */
    if (parts[0] === 'settings') {      requireAdmin(user);
      if (method === 'GET') return json(await store.getSettings());
      if (method === 'PUT') return json(await store.updateSettings(await readBody(request)));
      throw new HttpError('Método no permitido', 405);
    }

    /* ---- usuarios (solo admin) ---- */
    if (parts[0] === 'users') {
      requireAdmin(user);
      if (parts[1] && method === 'POST' && parts[2] === 'password') {
        const b = await readBody(request);
        if (!auth.validPassword(b.password)) throw new HttpError('La contraseña debe tener al menos 8 caracteres', 400);
        const exists = await auth.getUserById(env, parts[1]);
        if (!exists) throw new HttpError('Usuario no encontrado', 404);
        await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
          .bind(await auth.hashPassword(b.password), new Date().toISOString(), parts[1]).run();
        await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(parts[1]).run();
        return json({ ok: true, message: 'Contraseña actualizada (las sesiones se cerraron)' });
      }
      if (parts[1] && method === 'DELETE') {
        if (parts[1] === user.id) throw new HttpError('No puedes eliminar tu propia cuenta', 400);
        await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(parts[1]).run();
        const res = await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(parts[1]).run();
        if (!res.meta || !res.meta.changes) throw new HttpError('Usuario no encontrado', 404);
        return json({ ok: true });
      }
      if (!parts[1] && method === 'GET') return json({ users: await auth.listUsers(env) });
      if (!parts[1] && method === 'POST') {
        const b = await readBody(request);
        if (!auth.validEmail(b.email)) throw new HttpError('Email inválido', 400);
        if (!auth.validPassword(b.password)) throw new HttpError('La contraseña debe tener al menos 8 caracteres', 400);
        if (!String(b.name || '').trim()) throw new HttpError('Nombre requerido', 400);
        const role = b.role === 'admin' ? 'admin' : 'cliente';
        if (role === 'admin' && b.clientId) throw new HttpError('El rol admin no se asocia a un cliente', 400);
        if (role === 'cliente' && b.clientId) {
          const c = await store.getClient(b.clientId);
          if (!c) throw new HttpError('Cliente asignado inexistente', 400);
        }
        const dup = await auth.findUserByEmail(env, b.email);
        if (dup) throw new HttpError('Ese email ya está registrado', 409);
        const created = await auth.createUser(env, { ...b, role });
        return json({ user: created }, 201);
      }
      throw new HttpError('Método no permitido', 405);
    }

    /* ---- clientes ---- */
    if (parts[0] === 'clients') {
      if (!parts[1] && method === 'GET') {
        const all = await store.getClients();
        const list = user.role === 'admin' ? all : all.filter((c) => c.id === user.clientId);
        return json(list);
      }
      if (!parts[1] && method === 'POST') {
        requireAdmin(user);
        const b = await readBody(request);
        if (!b.url || !b.name) throw new HttpError('nombre y url son obligatorios', 400);
        return json({ client: await store.createClient(b) }, 201);
      }

      const id = parts[1];

      if (parts[2] === 'run' && method === 'POST') {
        const client = await loadClientFor(user, id);
        try {
          return await startStreamRun(client.id, env, ctx);
        } catch (e) {
          throw new HttpError(e.message || 'Error al ejecutar', e.status || 500);
        }
      }

      if (parts[2] === 'indexnow' && method === 'POST') {
        const client = await loadClientFor(user, id);
        const result = await latestResult(id);
        const urls = [client.url];
        for (const c of (result && result.audit.crawled) || []) if (c.status === 200) urls.push(c.url);
        const payload = indexnowPayload(client, urls);
        let last = null;
        for (const ep of ['https://api.indexnow.org/indexnow', 'https://www.bing.com/indexnow']) {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 12000);
          try {
            const r = await fetch(ep, {
              method: 'POST', signal: ctrl.signal,
              headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: payload,
            });
            last = { endpoint: ep, status: r.status, body: (await r.text()).slice(0, 500), ok: r.ok || r.status === 202 };
            if (r.ok || r.status === 202) break;
          } catch (e) {
            last = { endpoint: ep, status: 0, body: String(e.message || e), ok: false };
          } finally { clearTimeout(t); }
        }
        return json({
          sent: urls.length,
          host: safeOrigin(client.url).replace(/^https?:\/\//, ''),
          key: client.indexnowKey,
          reminder: `Antes de enviar, publica la clave en ${safeOrigin(client.url)}/${client.indexnowKey}.txt (la verifica IndexNow).`,
          result: last,
        });
      }

      if (parts[2] === 'files' && parts[3] && method === 'GET') {
        await loadClientFor(user, id);
        const client = await store.getClient(id);
        const result = await latestResult(id);
        if (!result) throw new HttpError('Ejecuta el agente primero para generar los archivos', 400);
        const name = parts[3];
        const want = url.searchParams.get('dl');
        if (name === 'sitemap.xml') return new Response(result.artifacts.sitemapXml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
        if (name === 'robots.txt') return new Response(result.artifacts.robotsTxt, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        if (name === 'llms.txt') return new Response(result.artifacts.llmsTxt, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        if (name === 'report.md') {
          return new Response(result.reportMd, {
            headers: {
              'Content-Type': 'text/markdown; charset=utf-8',
              ...(want ? { 'Content-Disposition': `attachment; filename="informe-${client.name.replace(/[^\w-]+/g, '_')}.md"` } : {}),
            },
          });
        }
        if (name === 'result.json') {
          return new Response(JSON.stringify({ client, result }, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
        }
        throw new HttpError('Archivo no encontrado', 404);
      }

      if (parts[2] === 'files' && !parts[3] && method === 'GET') {
        await loadClientFor(user, id);
        const result = await latestResult(id);
        return json({ available: !!result, files: result ? ['sitemap.xml', 'robots.txt', 'llms.txt', 'report.md', 'result.json'] : [] });
      }

      if (!parts[2] && method === 'GET') {
        const client = await loadClientFor(user, id);
        const runs = (await store.getRuns(id)).map((r) => ({
          id: r.id, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt,
          score: r.result && r.result.audit ? r.result.audit.score.total : null,
          steps: (r.steps || []).map((s) => ({ id: s.id, status: s.status })),
        })).reverse();
        return json({ client, runs, result: await latestResult(id) });
      }

      if (!parts[2] && method === 'PUT') {
        requireAdmin(user);
        const client = await store.updateClient(id, await readBody(request));
        if (!client) throw new HttpError('Cliente no encontrado', 404);
        return json({ client });
      }

      if (!parts[2] && method === 'DELETE') {
        requireAdmin(user);
        const ok = await store.deleteClient(id);
        if (!ok) throw new HttpError('Cliente no encontrado', 404);
        return json({ ok: true });
      }
    }

    /* ---- corridas ---- */
    if (parts[0] === 'runs') {
      if (!parts[1] && method === 'GET') {
        const clientId = url.searchParams.get('clientId');
        let list = await store.getRuns(clientId || undefined);
        if (user.role !== 'admin') list = list.filter((r) => r.clientId === user.clientId);
        const out = list.map((r) => ({
          id: r.id, clientId: r.clientId, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt,
          score: r.result && r.result.audit ? r.result.audit.score.total : null,
          grade: r.result && r.result.audit ? r.result.audit.score.grade : null,
        })).reverse();
        return json(out);
      }
      if (parts[1] && method === 'GET') {
        const run = await store.getRun(parts[1]);
        if (!run) throw new HttpError('Ejecución no encontrada', 404);
        if (user.role !== 'admin' && run.clientId !== user.clientId) throw new HttpError('Sin acceso', 403);
        const light = url.searchParams.get('light') === '1';
        return json(light ? { ...run, result: run.result ? { ready: true } : null } : run);
      }
      throw new HttpError('Método no permitido', 405);
    }

    throw new HttpError('Ruta no encontrada', 404);
  } catch (e) {
    const status = e.status || (e instanceof HttpError ? e.status : 500);
    if (!(e instanceof HttpError)) console.error('[api]', e);
    return json({ error: e.message || 'Error interno' }, status || 500);
  }
}

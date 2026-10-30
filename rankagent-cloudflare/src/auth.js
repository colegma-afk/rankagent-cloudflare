/**
 * Autenticación: usuarios (admin / cliente), contraseñas PBKDF2 (WebCrypto)
 * y sesiones con cookie HttpOnly almacenadas en D1.
 */

const COOKIE = 'ra_sess';
const SESSION_DAYS = 30;
const ITERATIONS = 100000;

function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function hashPassword(password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, key, 256));
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(bits)}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [algo, iterStr, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'pbkdf2') return false;
    const iterations = parseInt(iterStr, 10);
    const salt = unb64(saltB64);
    const expected = unb64(hashB64);
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, expected.length * 8));
    let diff = 0;
    for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}

export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSecure(request) {
  const url = new URL(request.url);
  if (url.protocol === 'https:') return true;
  const xf = request.headers.get('X-Forwarded-Proto');
  return xf === 'https';
}

export function sessionCookie(token, request, { clear = false } = {}) {
  const parts = [`${COOKIE}=${clear ? '' : encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  parts.push(`Max-Age=${clear ? 0 : SESSION_DAYS * 86400}`);
  if (isSecure(request)) parts.push('Secure');
  return parts.join('; ');
}

export async function createSession(env, userId) {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(token, userId, now + SESSION_DAYS * 86400 * 1000, new Date(now).toISOString()).run();
  return token;
}

export async function destroySession(env, request) {
  const tok = parseCookies(request)[COOKIE];
  if (tok) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(tok).run();
}

export function rowToUser(r) {
  if (!r) return null;
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    clientId: r.client_id || null,
    createdAt: r.created_at,
  };
}

export async function getUserFromRequest(env, request) {
  const tok = parseCookies(request)[COOKIE];
  if (!tok) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT s.token AS stoken, s.expires_at AS sexp, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    ).bind(tok).first();
    if (!row) return null;
    if (row.sexp < Date.now()) {
      await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(tok).run();
      return null;
    }
    const { stoken, sexp, ...user } = row;
    return rowToUser(user);
  } catch {
    return null;
  }
}

export async function userCount(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  return row ? row.n : 0;
}

export async function findUserByEmail(env, email) {
  return env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(String(email || '').trim().toLowerCase()).first();
}

export async function getUserById(env, id) {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
}

export async function listUsers(env) {
  const res = await env.DB.prepare('SELECT * FROM users ORDER BY rowid ASC').all();
  return res.results.map(rowToUser);
}

export async function createUser(env, { email, name, password, role = 'cliente', clientId = null }) {
  const id = 'u_' + Date.now().toString(36) + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const now = new Date().toISOString();
  const hash = await hashPassword(password);
  await env.DB.prepare(
    'INSERT INTO users (id, email, name, password_hash, role, client_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, String(email).trim().toLowerCase(), String(name).slice(0, 120), hash, role, clientId, now, now).run();
  return { id, email: String(email).trim().toLowerCase(), name, role, clientId, createdAt: now };
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 200;
}

export function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizeEmail(email));
}

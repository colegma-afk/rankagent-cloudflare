'use strict';
/* RankAgent v2 — SPA con usuarios (agencia/cliente), D1 y ejecución por streaming */

/* ================= helpers ================= */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    if (res.status === 401 && !opts.noAuthRedirect) {
      state.user = null;
      const rn = route().name;
      if (rn !== 'login' && rn !== 'setup') location.hash = '#/login';
    }
    throw err;
  }
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 450); }, 4200);
}

function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('es-CL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}
function fmtTime(ts) { return new Date(ts).toLocaleTimeString('es-CL', { hour12: false }); }
function scoreColor(n) { return n >= 75 ? 'var(--ok)' : n >= 60 ? 'var(--warn)' : 'var(--bad)'; }

function ringSVG(score, grade, small) {
  const r = 38, c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score || 0));
  const dash = (pct / 100) * c;
  return `<div class="ring ${small ? 'sm' : ''}">
    <svg width="100%" height="100%" viewBox="0 0 92 92">
      <circle class="ring-bg" cx="46" cy="46" r="${r}"></circle>
      <circle class="ring-fg" cx="46" cy="46" r="${r}" stroke="${scoreColor(pct)}"
        stroke-dasharray="${dash} ${c - dash}"></circle>
    </svg>
    <div class="ring-txt"><span class="ring-num">${score == null ? '–' : score}</span><span class="ring-grade">Grado ${grade || '–'}</span></div>
  </div>`;
}

function catsHTML(cats) {
  if (!cats) return '';
  return `<div class="cats">${Object.entries(cats).map(([k, v]) => `
    <div class="cat-row">
      <span class="cat-name">${esc(k)}</span>
      <div class="bar"><i style="width:${(v.got / v.max) * 100}%"></i></div>
      <span class="cat-val">${v.got}/${v.max}</span>
    </div>`).join('')}</div>`;
}

const sevPill = (s) => `<span class="sev sev-${esc(s)}">${esc(s)}</span>`;
function statusPill(st) {
  const map = { done: ['g', 'completado'], running: ['y', 'en curso'], warn: ['y', 'avisos'], error: ['r', 'error'], queued: ['n', 'en cola'] };
  const [cls, txt] = map[st] || ['n', st];
  return `<span class="chip ${cls}">${txt}</span>`;
}
const isAdmin = () => state.user && state.user.role === 'admin';

/* ================= estado ================= */
const state = {
  user: null,
  needsSetup: false,
  clients: [],
  settings: {},
  tab: 'resumen',
  tabClient: null,
  agent: { runId: null, clientId: null, poll: null, done: false },
};
const runsCache = {};

/* ================= auth / boot ================= */
async function refreshAuth() {
  try {
    const me = await api('/api/auth/me', { noAuthRedirect: true });
    state.user = me.user;
  } catch (e) {
    state.user = null;
    if (e.status === 401) {
      try {
        const st = await api('/api/auth/status', { noAuthRedirect: true });
        state.needsSetup = !!st.needsSetup;
      } catch { state.needsSetup = false; }
    } else throw e;
  }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST', noAuthRedirect: true }); } catch { /* noop */ }
  state.user = null;
  location.hash = '#/login';
}

function renderUserBox() {
  const box = $('#userBox');
  if (!state.user) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = '';
  const u = state.user;
  box.innerHTML = `
    <div class="u-row">
      <span class="avatar">${esc((u.name || u.email || '?')[0].toUpperCase())}</span>
      <div style="min-width:0">
        <div class="u-name">${esc(u.name)}</div>
        <div class="u-mail">${esc(u.email)}</div>
      </div>
    </div>
    <div class="u-row" style="justify-content:space-between">
      <span class="badge-role ${u.role}">${u.role === 'admin' ? 'Agencia' : 'Cliente'}</span>
      <button class="btn btn-sm btn-ghost" onclick="logout()">Salir</button>
    </div>`;
}

function updateNav(activeRoute) {
  $$('#nav a').forEach((a) => {
    const needAdmin = a.hasAttribute('data-admin');
    a.style.display = (needAdmin && !isAdmin()) ? 'none' : '';
    a.classList.toggle('active', a.dataset.route === activeRoute);
  });
}

/* ================= router ================= */
function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { name: parts[0] || 'panel', a: parts[1] || null, b: parts[2] || null };
}

async function render() {
  const r = route();
  const main = $('#main');

  /* --- guardas de sesión --- */
  if (!state.user) {
    updateNav(null); renderUserBox();
    if (state.needsSetup) {
      if (r.name !== 'setup') { location.hash = '#/setup'; return; }
      return viewSetup(main);
    }
    if (r.name !== 'login') { location.hash = '#/login'; return; }
    return viewLogin(main);
  }
  if (r.name === 'login' || r.name === 'setup') { location.hash = '#/panel'; return; }
  if (!isAdmin() && (r.name === 'ajustes' || r.name === 'usuarios')) { location.hash = '#/panel'; return; }

  updateNav(r.name);
  renderUserBox();
  stopAgentStreamIfLeaving(r);

  try {
    if (r.name === 'panel') await viewPanel(main);
    else if (r.name === 'clientes') await viewClientes(main);
    else if (r.name === 'cliente') await viewCliente(main, r.a, r.b);
    else if (r.name === 'agente') await viewAgente(main, r.a, r.b);
    else if (r.name === 'usuarios') await viewUsuarios(main);
    else if (r.name === 'ajustes') await viewAjustes(main);
    else location.hash = '#/panel';
  } catch (e) {
    if (e.status === 403) { toast(e.message, 'err'); location.hash = '#/panel'; return; }
    main.innerHTML = `<div class="empty"><div class="big">⚠</div><h2>No se pudo cargar la vista</h2><p class="mono">${esc(e.message)}</p></div>`;
  }
}

function stopAgentStreamIfLeaving(r) {
  if (r.name !== 'agente' && state.agent.poll) {
    clearInterval(state.agent.poll);
    state.agent.poll = null;
  }
}

/* ================= LOGIN / SETUP ================= */
function authLogo() {
  return `<span class="logo-mark"><svg viewBox="0 0 32 32" width="34" height="34"><rect width="32" height="32" rx="8" fill="url(#g1)"/><path d="M8 22 L14 14 L18 18 L24 9" stroke="white" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/><defs><linearGradient id="g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs></svg></span><span class="logo-text">Rank<strong>Agent</strong></span>`;
}

async function viewLogin(main) {
  main.innerHTML = `<div class="auth-wrap"><div class="auth-card">
    <div class="auth-logo">${authLogo()}</div>
    <h1>Iniciar sesión</h1>
    <p class="sub">Agente IA de SEO — acceso para la agencia y sus clientes</p>
    <form id="loginForm">
      <div class="field"><label>Email</label><input class="input" type="email" name="email" required autocomplete="email" placeholder="tu@email.com"></div>
      <div class="field"><label>Contraseña</label><input class="input" type="password" name="password" required autocomplete="current-password" placeholder="••••••••"></div>
      <div id="authErr" class="hint" style="color:var(--bad);min-height:18px"></div>
      <button class="btn btn-primary" type="submit">Ingresar</button>
    </form>
    <div class="auth-foot">¿Primera vez? La cuenta de administrador se crea en la configuración inicial.</div>
  </div></div>`;
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const out = await api('/api/auth/login', {
        method: 'POST',
        body: { email: fd.get('email'), password: fd.get('password') },
      });
      state.user = out.user;
      if (out.user.role === 'admin') api('/api/settings').then((s) => { state.settings = s; }).catch(() => {});
      toast(`Hola, ${out.user.name} 👋`, 'ok');
      location.hash = '#/panel';
      render();
    } catch (err) {
      $('#authErr').textContent = err.message;
    }
  });
  setTimeout(() => { const el = $('#loginForm [name=email]'); if (el) el.focus(); }, 60);
}

async function viewSetup(main) {
  main.innerHTML = `<div class="auth-wrap"><div class="auth-card">
    <div class="auth-logo">${authLogo()}</div>
    <h1>Configuración inicial</h1>
    <p class="sub">Crea la cuenta <strong>administradora de la agencia</strong>. Después podrás dar acceso a usuarios clientes.</p>
    <form id="setupForm">
      <div class="field"><label>Tu nombre</label><input class="input" name="name" required placeholder="Ej: Ana Pérez"></div>
      <div class="field"><label>Email</label><input class="input" type="email" name="email" required placeholder="ana@agencia.com"></div>
      <div class="field"><label>Contraseña</label><input class="input" type="password" name="password" required minlength="8" placeholder="mínimo 8 caracteres"></div>
      <div id="authErr" class="hint" style="color:var(--bad);min-height:18px"></div>
      <button class="btn btn-primary" type="submit">Crear cuenta admin</button>
    </form>
  </div></div>`;
  $('#setupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const out = await api('/api/setup', {
        method: 'POST',
        body: { name: fd.get('name'), email: fd.get('email'), password: fd.get('password') },
      });
      state.user = out.user;
      state.needsSetup = false;
      state.settings = await api('/api/settings').catch(() => ({ autonomous: true }));
      toast('Cuenta administradora creada', 'ok');
      location.hash = '#/panel';
      render();
    } catch (err) {
      $('#authErr').textContent = err.message;
    }
  });
}

/* ================= PANEL ================= */
async function viewPanel(main) {
  const [clients, runs] = await Promise.all([api('/api/clients'), api('/api/runs')]);
  state.clients = clients;
  const withScore = clients.filter((c) => c.lastScore != null);
  const avg = withScore.length ? Math.round(withScore.reduce((s, c) => s + c.lastScore, 0) / withScore.length) : null;
  const critTotal = clients.reduce((s, c) => s + (c.lastCriticals || 0), 0);
  const unevaluated = clients.length - withScore.length;

  const headBtns = isAdmin()
    ? `<div class="btn-row"><button class="btn" onclick="createDemo()">⚡ Ejemplo</button><button class="btn btn-primary" onclick="openClientModal()">＋ Nuevo cliente</button></div>`
    : '';

  if (!clients.length) {
    main.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">Panel</h1><p class="page-sub">Hola ${esc(state.user.name)} — ${isAdmin() ? 'agente autónomo de SEO orgánico' : 'tus informes SEO'}</p></div>${headBtns}</div>
      <div class="empty">
        <div class="big">✦</div>
        ${isAdmin()
          ? `<h2>Crea tu primer cliente y deja que el agente trabaje</h2>
             <p>Auditoría, estrategia de 90 días, briefs de contenido, indexación (GSC/Bing/IndexNow) y optimización para buscadores IA — en una sola corrida autónoma.</p>
             <div class="btn-row" style="justify-content:center">
               <button class="btn btn-primary" onclick="openClientModal()">＋ Nuevo cliente</button>
               <button class="btn" onclick="createDemo()">⚡ Cargar cliente de ejemplo</button>
             </div>`
          : `<h2>Tu cuenta aún no tiene un cliente asignado</h2>
             <p>Pide a la agencia que asigne un cliente a tu usuario para ver aquí la auditoría, la estrategia y el informe.</p>`}
      </div>`;
    return;
  }

  main.innerHTML = `
    <div class="page-head">
      <div><h1 class="page-title">Panel</h1><p class="page-sub">${isAdmin() ? 'Estado de tus clientes y última actividad del agente' : 'Tu cliente y su evolución SEO'}</p></div>
      ${headBtns}
    </div>
    <div class="grid grid-4 mb">
      <div class="card stat"><div class="label">${isAdmin() ? 'Clientes' : 'Mi cliente'}</div><div class="value">${clients.length}</div><div class="delta">${withScore.length} con score</div></div>
      <div class="card stat"><div class="label">Corridas del agente</div><div class="value">${runs.length}</div><div class="delta">${runs.filter((r) => r.status === 'done').length} completadas</div></div>
      <div class="card stat"><div class="label">Score promedio</div><div class="value" style="color:${scoreColor(avg || 0)}">${avg == null ? '–' : avg}</div><div class="delta">sobre 100</div></div>
      <div class="card stat"><div class="label">Críticos abiertos</div><div class="value" style="color:var(--bad)">${critTotal}</div><div class="delta">${unevaluated ? unevaluated + ' sin evaluar' : 'prioridad inmediata'}</div></div>
    </div>
    <div class="grid grid-3">${clients.map((c) => clientCard(c)).join('')}</div>`;
}

function clientCard(c) {
  return `<div class="card client-card">
    <div class="client-top">
      <div>
        <h3 class="client-name">${esc(c.name)}</h3>
        <div class="client-url">${esc(c.url)}</div>
      </div>
      ${ringSVG(c.lastScore, null, true)}
    </div>
    <div class="client-meta">
      <span class="chip n">${esc(c.market)}</span>
      ${c.niche ? `<span class="chip">${esc(c.niche)}</span>` : ''}
      ${(c.keywords || []).slice(0, 2).map((k) => `<span class="chip g">${esc(k)}</span>`).join('')}
      ${(c.keywords || []).length > 2 ? `<span class="chip n">+${c.keywords.length - 2}</span>` : ''}
    </div>
    <div class="small muted">Última corrida: ${fmtDate(c.lastRunAt || (c.lastRunId ? (runsCache[c.lastRunId] || {}).finishedAt : null))}</div>
    <div class="btn-row">
      <a class="btn btn-sm btn-primary" href="#/agente/${c.id}/run">✦ ${c.lastRunId ? 'Re-ejecutar' : 'Ejecutar'} agente</a>
      <a class="btn btn-sm" href="#/cliente/${c.id}">Ver informe</a>
      ${isAdmin() ? `<button class="btn btn-sm btn-ghost" onclick="openClientModal('${c.id}')">Editar</button>` : ''}
    </div>
  </div>`;
}

/* ================= CLIENTES ================= */
async function viewClientes(main) {
  const clients = await api('/api/clients');
  state.clients = clients;
  const admin = isAdmin();
  main.innerHTML = `
    <div class="page-head">
      <div><h1 class="page-title">Clientes</h1><p class="page-sub">${clients.length} cuenta(s) · el agente trabaja en paralelo por cliente</p></div>
      ${admin ? `<button class="btn btn-primary" onclick="openClientModal()">＋ Nuevo cliente</button>` : ''}
    </div>
    ${clients.length ? `
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>Cliente</th><th>URL</th><th>Mercado</th><th>Keywords</th><th class="num">Score</th><th>Última corrida</th><th></th></tr></thead>
      <tbody>
      ${clients.map((c) => `<tr>
        <td><strong>${esc(c.name)}</strong><div class="small muted">${esc(c.niche || c.type)}</div></td>
        <td class="mono small">${esc(c.url)}</td>
        <td><span class="chip n">${esc(c.market)}</span></td>
        <td class="num">${(c.keywords || []).length}</td>
        <td class="num" style="color:${scoreColor(c.lastScore || 0)};font-weight:700">${c.lastScore == null ? '–' : c.lastScore}</td>
        <td class="small muted">${fmtDate(c.lastRunAt)}</td>
        <td><div class="btn-row" style="flex-wrap:nowrap">
          <a class="btn btn-sm btn-primary" href="#/agente/${c.id}/run">Correr</a>
          <a class="btn btn-sm" href="#/cliente/${c.id}">Informe</a>
          ${admin ? `<button class="btn btn-sm btn-ghost" onclick="openClientModal('${c.id}')">✎</button>
          <button class="btn btn-sm btn-danger btn-ghost" onclick="removeClient('${c.id}')">✕</button>` : ''}
        </div></td>
      </tr>`).join('')}
      </tbody></table></div>` : `
      <div class="empty"><div class="big">◉</div><h2>Sin clientes</h2><p>${admin ? 'Agrega un cliente con su URL, rubro y keywords objetivo.' : 'Todavía no tienes un cliente asignado.'}</p>
      ${admin ? `<button class="btn btn-primary" onclick="openClientModal()">＋ Crear cliente</button>` : ''}</div>`}`;
}

async function removeClient(id) {
  if (!confirm('¿Eliminar este cliente, sus corridas y desvincular su usuario?')) return;
  await api('/api/clients/' + id, { method: 'DELETE' });
  toast('Cliente eliminado', 'ok');
  render();
}

async function createDemo() {
  const out = await api('/api/clients', {
    method: 'POST',
    body: {
      name: 'Café Puerto Norte',
      url: 'https://example.com',
      niche: 'Cafetería de especialidad',
      type: 'local',
      market: 'es-CL',
      keywords: 'café de especialidad santiago, cafetería con wifi, café granel santiago',
      competitors: 'cafeterias-ejemplo.cl, starbucks.cl',
      autoRun: true,
    },
  });
  toast('Cliente de ejemplo creado. El agente arranca…', 'ok');
  location.hash = `#/agente/${out.client.id}/run`;
}

/* ================= MODAL CLIENTE ================= */
function openClientModal(id) {
  if (!isAdmin()) { toast('Solo la agencia puede editar clientes', 'err'); return; }
  const c = id ? state.clients.find((x) => x.id === id) : null;
  const markets = ['es-CL', 'es', 'es-MX', 'es-AR', 'es-PE', 'es-CO', 'en', 'en-US'];
  const types = [['servicios', 'Servicios B2B/B2C'], ['local', 'Negocio local'], ['ecommerce', 'E-commerce'], ['contenido', 'Medio / Blog'], ['otro', 'Otro']];
  $('#modal-root').innerHTML = `
  <div class="modal-backdrop" id="modalBackdrop">
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>${c ? 'Editar cliente' : 'Nuevo cliente'}</h2>
        <button class="x-btn" onclick="closeModal()">✕</button>
      </div>
      <form id="clientForm">
        <div class="form-row">
          <div class="field"><label>Nombre <span class="req">*</span></label>
            <input class="input" name="name" required value="${esc(c ? c.name : '')}" placeholder="Ej: Panadería Los Aromos" /></div>
          <div class="field"><label>URL <span class="req">*</span></label>
            <input class="input" name="url" required value="${esc(c ? c.url : '')}" placeholder="https://tusitio.cl" /></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Rubro</label>
            <input class="input" name="niche" value="${esc(c ? c.niche : '')}" placeholder="Ej: panadería artesanal" /></div>
          <div class="field"><label>Tipo de negocio</label>
            <select class="input" name="type">${types.map(([v, l]) => `<option value="${v}" ${c && c.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Mercado / idioma</label>
            <select class="input" name="market">${markets.map((m) => `<option ${c && c.market === m ? 'selected' : (!c && m === 'es-CL' ? 'selected' : '')}>${m}</option>`).join('')}</select></div>
          <div class="field"><label>Competidores (opcional)</label>
            <input class="input" name="competitors" value="${esc(c ? c.competitors : '')}" placeholder="otro.cl, otro2.cl" /></div>
        </div>
        <div class="field"><label>Keywords objetivo (separadas por coma)</label>
          <textarea class="input" name="keywords" placeholder="panadería santiago, pan integral, tortas a medida">${esc(c ? (c.keywords || []).join(', ') : '')}</textarea>
          <span class="hint">3–8 keywords principales con las que los clientes buscan este negocio.</span></div>
        <div class="field"><label>Notas internas</label>
          <textarea class="input" name="notes" style="min-height:60px">${esc(c ? c.notes : '')}</textarea></div>
        <div class="switch-row">
          <div><div class="sw-title">Ejecutar agente automáticamente</div><div class="sw-desc">Al guardar, el agente corre la auditoría + estrategia completa.</div></div>
          <label class="switch"><input type="checkbox" name="autoRun" ${!c || c.autoRun ? 'checked' : ''}><i></i></label>
        </div>
        <div class="btn-row mt" style="justify-content:flex-end">
          <button type="button" class="btn" onclick="closeModal()">Cancelar</button>
          <button type="submit" class="btn btn-primary">${c ? 'Guardar cambios' : 'Crear y ejecutar'}</button>
        </div>
      </form>
    </div>
  </div>`;

  $('#modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') closeModal(); });
  $('#clientForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      name: fd.get('name'), url: fd.get('url'), niche: fd.get('niche'),
      type: fd.get('type'), market: fd.get('market'), competitors: fd.get('competitors'),
      keywords: String(fd.get('keywords') || '').split(',').map((s) => s.trim()).filter(Boolean),
      notes: fd.get('notes'), autoRun: fd.get('autoRun') === 'on',
    };
    try {
      const autonomous = !!(state.settings && state.settings.autonomous);
      if (c) {
        await api('/api/clients/' + c.id, { method: 'PUT', body });
        toast('Cliente actualizado', 'ok');
        closeModal();
        if (autonomous && body.autoRun) location.hash = `#/agente/${c.id}/run`;
        else render();
      } else {
        const out = await api('/api/clients', { method: 'POST', body });
        toast('Cliente creado', 'ok');
        closeModal();
        location.hash = (autonomous && body.autoRun) ? `#/agente/${out.client.id}/run` : `#/cliente/${out.client.id}`;
      }
    } catch (err) { toast(err.message, 'err'); }
  });
  setTimeout(() => { const el = $('#clientForm [name=name]'); if (el) el.focus(); }, 50);
}
function closeModal() { $('#modal-root').innerHTML = ''; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

/* ================= USUARIOS (admin) ================= */
async function viewUsuarios(main) {
  requireAdminView(main);
  const [usersRes, clients] = await Promise.all([api('/api/users'), api('/api/clients')]);
  state.clients = clients;
  const clientName = (id) => (clients.find((c) => c.id === id) || {}).name || '—';
  main.innerHTML = `
    <div class="page-head">
      <div><h1 class="page-title">Usuarios</h1><p class="page-sub">Cuentas de la agencia (admin) y de clientes finales (acceso a su informe)</p></div>
      <button class="btn btn-primary" onclick="openUserModal()">＋ Nuevo usuario</button>
    </div>
    <div class="banner-info">Los usuarios <strong>cliente</strong> inician sesión con su email y ven <em>solo</em> su cliente asignado: auditoría, estrategia, contenido, GEO, indexación e historial — y pueden re-ejecutar el agente.</div>
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>Usuario</th><th>Email</th><th>Rol</th><th>Cliente asignado</th><th>Creado</th><th></th></tr></thead>
      <tbody>${usersRes.users.map((u) => `<tr>
        <td><div style="display:flex;gap:10px;align-items:center"><span class="avatar" style="width:30px;height:30px;font-size:12px">${esc((u.name || '?')[0].toUpperCase())}</span><strong>${esc(u.name)}</strong></div></td>
        <td class="mono small">${esc(u.email)}</td>
        <td><span class="badge-role ${u.role}">${u.role === 'admin' ? 'Agencia' : 'Cliente'}</span></td>
        <td>${u.role === 'cliente' ? esc(clientName(u.clientId)) : '—'}</td>
        <td class="small muted">${fmtDate(u.createdAt)}</td>
        <td><div class="btn-row" style="flex-wrap:nowrap">
          <button class="btn btn-sm" onclick="openPasswordModal('${u.id}', '${esc(u.email)}')">Contraseña</button>
          ${u.id !== state.user.id ? `<button class="btn btn-sm btn-danger btn-ghost" onclick="removeUser('${u.id}')">✕</button>` : ''}
        </div></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

function requireAdminView(main) {
  if (!isAdmin()) {
    main.innerHTML = `<div class="empty"><div class="big">🔒</div><h2>Solo administradores</h2></div>`;
    throw Object.assign(new Error('Requiere administrador'), { status: 403 });
  }
}

function openUserModal() {
  const clients = state.clients;
  $('#modal-root').innerHTML = `
  <div class="modal-backdrop" id="modalBackdrop">
    <div class="modal">
      <div class="modal-head"><h2>Nuevo usuario</h2><button class="x-btn" onclick="closeModal()">✕</button></div>
      <form id="userForm">
        <div class="form-row">
          <div class="field"><label>Nombre <span class="req">*</span></label><input class="input" name="name" required placeholder="Juan Pérez"></div>
          <div class="field"><label>Email <span class="req">*</span></label><input class="input" type="email" name="email" required placeholder="cliente@email.com"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Contraseña <span class="req">*</span></label><input class="input" type="password" name="password" required minlength="8" placeholder="mínimo 8 caracteres"></div>
          <div class="field"><label>Rol</label>
            <select class="input" name="role" id="userRole">
              <option value="cliente">Cliente (ve su informe)</option>
              <option value="admin">Agencia / administrador</option>
            </select></div>
        </div>
        <div class="field" id="clientAssignField">
          <label>Cliente asignado</label>
          <select class="input" name="clientId">
            <option value="">— sin asignar —</option>
            ${clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
          </select>
          <span class="hint">El usuario cliente solo verá este cliente.</span>
        </div>
        <div class="btn-row mt" style="justify-content:flex-end">
          <button type="button" class="btn" onclick="closeModal()">Cancelar</button>
          <button type="submit" class="btn btn-primary">Crear usuario</button>
        </div>
      </form>
    </div>
  </div>`;
  const roleSel = $('#userRole');
  const assignField = $('#clientAssignField');
  roleSel.addEventListener('change', () => {
    assignField.style.display = roleSel.value === 'cliente' ? '' : 'none';
  });
  $('#modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') closeModal(); });
  $('#userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/users', {
        method: 'POST',
        body: {
          name: fd.get('name'), email: fd.get('email'), password: fd.get('password'),
          role: fd.get('role'), clientId: fd.get('role') === 'cliente' ? (fd.get('clientId') || null) : null,
        },
      });
      toast('Usuario creado', 'ok');
      closeModal();
      render();
    } catch (err) { toast(err.message, 'err'); }
  });
}

function openPasswordModal(userId, email) {
  $('#modal-root').innerHTML = `
  <div class="modal-backdrop" id="modalBackdrop">
    <div class="modal" style="max-width:440px">
      <div class="modal-head"><h2>Nueva contraseña</h2><button class="x-btn" onclick="closeModal()">✕</button></div>
      <p class="small muted">Para <strong>${esc(email)}</strong>. Las sesiones abiertas se cerrarán.</p>
      <form id="pwForm">
        <div class="field"><label>Contraseña</label><input class="input" type="password" name="password" required minlength="8" placeholder="mínimo 8 caracteres"></div>
        <div class="btn-row mt" style="justify-content:flex-end">
          <button type="button" class="btn" onclick="closeModal()">Cancelar</button>
          <button type="submit" class="btn btn-primary">Guardar</button>
        </div>
      </form>
    </div>
  </div>`;
  $('#modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') closeModal(); });
  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const out = await api(`/api/users/${userId}/password`, { method: 'POST', body: { password: new FormData(e.target).get('password') } });
      toast(out.message || 'Contraseña actualizada', 'ok');
      closeModal();
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function removeUser(id) {
  if (!confirm('¿Eliminar este usuario?')) return;
  try {
    await api('/api/users/' + id, { method: 'DELETE' });
    toast('Usuario eliminado', 'ok');
    render();
  } catch (e) { toast(e.message, 'err'); }
}

/* ================= DETALLE DE CLIENTE ================= */
async function viewCliente(main, id, tab) {
  const data = await api('/api/clients/' + id);
  if (state.tabClient !== id) { state.tab = 'resumen'; state.tabClient = id; }
  if (tab) state.tab = tab;
  const { client: c, runs, result } = data;
  const t = state.tab;
  const admin = isAdmin();

  const tabs = [['resumen', 'Resumen'], ['auditoria', 'Auditoría'], ['estrategia', 'Estrategia'], ['contenido', 'Contenido'], ['geo', 'GEO / IA'], ['indexacion', 'Indexación'], ['historial', 'Historial']];

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">${esc(c.name)}</h1>
        <p class="page-sub"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a> · ${esc(c.niche || c.type)} · ${esc(c.market)}</p>
      </div>
      <div class="btn-row">
        <a class="btn btn-primary" href="#/agente/${c.id}/run">✦ ${result ? 'Re-ejecutar agente' : 'Ejecutar agente'}</a>
        ${result ? `<a class="btn" href="/api/clients/${c.id}/files/report.md?dl=1">⬇ Informe .md</a>` : ''}
        ${admin ? `<button class="btn btn-ghost" onclick="openClientModal('${c.id}')">Editar</button>` : ''}
      </div>
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${t === k ? 'active' : ''}" onclick="goTab('${k}')">${l}</button>`).join('')}</div>
    <div id="tabBody">${tabBody(c, runs, result, t)}</div>`;
}

function goTab(k) {
  state.tab = k;
  const r = route();
  location.hash = `#/cliente/${r.a}/${k}`;
}

function tabBody(c, runs, result, t) {
  if (t !== 'historial' && !result) {
    return `<div class="empty"><div class="big">✦</div><h2>Aún no hay corrida del agente</h2>
      <p>Ejecuta el agente para generar la auditoría en vivo, la estrategia de 90 días, los briefs de contenido, el plan GEO y los archivos de indexación.</p>
      <a class="btn btn-primary" href="#/agente/${c.id}/run">▶ Ejecutar agente ahora</a></div>`;
  }
  if (t === 'resumen') return tabResumen(c, result);
  if (t === 'auditoria') return tabAuditoria(result);
  if (t === 'estrategia') return tabEstrategia(result);
  if (t === 'contenido') return tabContenido(result);
  if (t === 'geo') return tabGeo(c, result);
  if (t === 'indexacion') return tabIndexacion(c, result);
  if (t === 'historial') return tabHistorial(runs);
  return '';
}

function tabResumen(c, result) {
  const s = result.audit.score;
  const quick = result.strategy.quickWins;
  return `
  <div class="grid grid-2">
    <div class="card">
      <h3>Score SEO global</h3>
      <div class="run-hero">
        ${ringSVG(s.total, s.grade)}
        <div style="flex:1;min-width:220px">${catsHTML(s.categories)}</div>
      </div>
      <div class="small muted mt">HTTP ${result.audit.fetch.status} · ${Math.round(result.audit.fetch.bytes / 1024)} KB · ${result.audit.fetch.timeMs} ms · ${result.audit.crawled.length} URLs rastreadas</div>
    </div>
    <div class="card">
      <h3>Resumen ejecutivo ${result.llmUsed ? '<span class="chip g">LLM</span>' : '<span class="chip n">motor determinista</span>'}</h3>
      <p style="margin:0;font-size:14px">${esc(result.strategy.executiveSummary)}</p>
    </div>
    <div class="card">
      <h3>Quick wins <span class="sub">mayor impacto / menor esfuerzo</span></h3>
      ${quick.length ? quick.map((w, i) => `<div class="phase" style="margin-bottom:8px;padding:11px 14px">
        <div style="display:flex;gap:8px"><span class="prompt-n">${i + 1}</span><div>
          <strong style="font-size:13.5px">${esc(w.title)}</strong>
          <div class="small muted">${esc(w.fix)}</div>
        </div></div></div>`).join('') : '<p class="muted">Sin quick wins críticos — mantener monitoreo.</p>'}
    </div>
    <div class="card">
      <h3>GEO — buscadores IA <span class="sub">${result.geo.readiness}% listo</span></h3>
      ${result.geo.checks.slice(0, 6).map((ck) => `<div class="small" style="padding:4px 0">
        <span class="geo-status geo-${ck.status}">${ck.status === 'pass' ? '✓' : ck.status === 'fail' ? '✗' : ck.status === 'warn' ? '!' : 'i'}</span>
        ${esc(ck.title)}</div>`).join('')}
      <a class="btn btn-sm mt" href="#/cliente/${c.id}/geo">Ver plan GEO completo</a>
    </div>
  </div>`;
}

function tabAuditoria(result) {
  const a = result.audit;
  const page = a.homepage;
  return `
  <div class="grid grid-2 mb">
    <div class="card">
      <h3>Score y categorías</h3>
      <div class="run-hero">${ringSVG(a.score.total, a.score.grade)}<div style="flex:1;min-width:200px">${catsHTML(a.score.categories)}</div></div>
    </div>
    <div class="card">
      <h3>Señales de la página</h3>
      ${page ? `<dl class="kv">
        <dt>Title</dt><dd>${esc(page.title || '—')} <span class="muted mono">(${page.titleLength})</span></dd>
        <dt>Meta description</dt><dd>${esc(page.metaDescription || '—')} <span class="muted mono">(${page.metaDescLength})</span></dd>
        <dt>H1</dt><dd>${page.h1Count}× ${esc(page.h1)}</dd>
        <dt>Canonical</dt><dd class="mono small">${esc(page.canonical || 'ausente')}</dd>
        <dt>Idioma</dt><dd>${esc(page.lang || '—')}</dd>
        <dt>Palabras</dt><dd>${page.wordCount}</dd>
        <dt>Imágenes sin alt</dt><dd>${page.imgNoAlt}/${page.imgTotal}</dd>
        <dt>JSON-LD</dt><dd>${page.jsonldTypes.length ? esc(page.jsonldTypes.join(', ')) : 'ninguno'}</dd>
        <dt>Enlaces int/ext</dt><dd>${page.internalLinks} / ${page.externalLinks}</dd>
      </dl>` : '<p class="muted">Sin HTML: la descarga falló.</p>'}
    </div>
  </div>

  <div class="card mb">
    <h3>Hallazgos (${a.issues.length}) <span class="sub">ordenados por severidad</span></h3>
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>Sev.</th><th>Área</th><th>Hallazgo</th><th>Recomendación</th></tr></thead>
      <tbody>${a.issues.map((i) => `<tr>
        <td>${sevPill(i.severity)}</td><td class="small">${esc(i.area)}</td>
        <td><strong>${esc(i.title)}</strong><div class="small muted">${esc(i.detail)}</div></td>
        <td class="small">${esc(i.fix)}</td></tr>`).join('')}
      </tbody></table></div>
  </div>

  ${a.keywordAnalysis.length ? `<div class="card mb">
    <h3>Cobertura de keywords objetivo</h3>
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>Keyword</th><th>Title</th><th>H1</th><th>Meta</th><th class="num">Ocurrencias</th><th class="num">Cobertura</th></tr></thead>
      <tbody>${a.keywordAnalysis.map((k) => `<tr>
        <td>${esc(k.keyword)}</td>
        <td>${k.inTitle ? '✅' : '❌'}</td><td>${k.inH1 ? '✅' : '❌'}</td><td>${k.inDescription ? '✅' : '❌'}</td>
        <td class="num">${k.occurrences}</td><td class="num">${k.coverage}%</td></tr>`).join('')}
      </tbody></table></div>
  </div>` : ''}

  <div class="card">
    <h3>URLs rastreadas <span class="sub">descubiertas en enlaces internos</span></h3>
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>URL</th><th>Status</th><th>Title</th><th class="num">Palabras</th><th>Schema</th></tr></thead>
      <tbody>${a.crawled.length ? a.crawled.map((u) => `<tr>
        <td class="mono small">${esc(u.url.replace(/^https?:\/\/[^/]+/, ''))}</td>
        <td>${u.status === 200 ? '<span class="chip g">200</span>' : `<span class="chip r">${u.status}</span>`}</td>
        <td class="small">${esc(u.title || '—')}</td><td class="num">${u.words}</td>
        <td>${u.hasSchema ? '✅' : '—'}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">Sin URLs rastreadas</td></tr>'}
      </tbody></table></div>
  </div>`;
}

function tabEstrategia(result) {
  const st = result.strategy;
  return `
  <div class="card mb">
    <h3>Resumen ejecutivo</h3>
    <p style="margin:0">${esc(st.executiveSummary)}</p>
  </div>
  ${st.phases.map((ph, pi) => `
    <div class="phase">
      <h4>${esc(ph.name)}</h4>
      <div class="goal">Objetivo: ${esc(ph.goal)}</div>
      ${ph.tasks.map((t, i) => `<div class="task">
        <span class="n">${pi + 1}.${i + 1}</span>
        <div><strong>${esc(t.task)}</strong>
          <div class="why">${esc(t.why)} → <span style="color:var(--acc2)">${esc(t.fix)}</span></div>
        </div></div>`).join('')}
    </div>`).join('')}

  <div class="grid grid-2 mt">
    <div class="card">
      <h3>Mapa de keywords <span class="sub">validar volúmenes en GSC/Keyword Planner</span></h3>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Pri.</th><th>Keyword</th><th>Intención</th><th>Contenido</th></tr></thead>
        <tbody>${st.keywordPlan.map((k) => `<tr>
          <td><span class="chip ${k.priority === 'P1' ? 'g' : k.priority === 'P2' ? 'y' : 'n'}">${k.priority}</span></td>
          <td>${esc(k.keyword)}</td><td class="small">${esc(k.intent)}</td>
          <td class="small muted">${esc(k.contentType)}</td></tr>`).join('')}
        </tbody></table></div>
    </div>
    <div class="card">
      <h3>KPIs y cadencia</h3>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>KPI</th><th>Meta</th><th>Frec.</th></tr></thead>
        <tbody>${st.kpis.map((k) => `<tr><td>${esc(k.kpi)}</td><td class="small">${esc(k.meta)}</td><td class="small muted">${esc(k.cadence)}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="small muted mt">Cadencia de contenido: ${esc(st.contentCadence)}</p>
    </div>
  </div>`;
}

function tabContenido(result) {
  return `
  <p class="muted small mb">Briefs listos para tu redactor o para copiar al portapapeles. Cada brief incluye title, meta, slug, esquema H2/H3, FAQ y schema recomendado.</p>
  ${result.content.map((b) => `
    <details class="brief">
      <summary>
        <span class="prompt-n">${b.priority}</span>
        <span>${esc(b.keyword)}</span>
        <span class="chip n">${esc(b.intentLabel)}</span>
        <span class="chip ${b.priority === 'P1' ? 'g' : 'y'}">${esc(b.publishBy)}</span>
      </summary>
      <div class="brief-body">
        <dl class="kv">
          <dt>Title (${b.titleLength})</dt><dd>${esc(b.title)}</dd>
          <dt>Meta (${b.metaLength})</dt><dd>${esc(b.meta)}</dd>
          <dt>Slug</dt><dd class="mono">${esc(b.slug)}</dd>
          <dt>H1</dt><dd>${esc(b.h1)}</dd>
          <dt>Extensión</dt><dd>${esc(b.wordTarget)} palabras · Schema: ${esc(b.schema)}</dd>
          <dt>Enlaces internos</dt><dd>${esc(b.internalLinks)}</dd>
          <dt>CTA</dt><dd>${esc(b.cta)}</dd>
        </dl>
        <ul style="margin-top:10px">
          ${b.outline.map((sec) => `<li><strong>${esc(sec.h2)}</strong><ul>${sec.bullets.map((x) => `<li class="muted">${esc(x)}</li>`).join('')}</ul></li>`).join('')}
        </ul>
        <p class="small"><strong>FAQ a incluir:</strong> ${b.questions.map(esc).join(' · ')}</p>
        <button class="btn btn-sm" onclick='copyBrief(${JSON.stringify(JSON.stringify(b)).replace(/'/g, "&#39;")})'>⧉ Copiar brief</button>
      </div>
    </details>`).join('')}`;
}

function copyBrief(jsonStr) {
  const b = JSON.parse(jsonStr);
  const md = `# Brief: ${b.keyword}\n\n- Title: ${b.title}\n- Meta: ${b.meta}\n- Slug: ${b.slug}\n- H1: ${b.h1}\n- Extension: ${b.wordTarget} palabras\n- Schema: ${b.schema}\n\n## Esquema\n` +
    b.outline.map((s) => `### ${s.h2}\n` + s.bullets.map((x) => `- ${x}`).join('\n')).join('\n\n') +
    `\n\n## FAQ\n` + b.questions.map((q) => `- ${q}`).join('\n');
  navigator.clipboard.writeText(md).then(() => toast('Brief copiado al portapapeles', 'ok')).catch(() => toast('No se pudo copiar', 'err'));
}

function tabGeo(c, result) {
  const g = result.geo;
  return `
  <div class="grid grid-2 mb">
    <div class="card">
      <h3>Readiness GEO <span class="sub">visibilidad en buscadores IA</span></h3>
      <div style="font-size:44px;font-weight:800;color:${scoreColor(g.readiness)}">${g.readiness}%</div>
      <div class="small muted">Controles pass: ${g.checks.filter((x) => x.status === 'pass').length}/${g.checks.filter((x) => x.status !== 'info').length}</div>
    </div>
    <div class="card">
      <h3>Motores y cómo aparecer</h3>
      ${g.engines.map((e) => `<div class="small" style="padding:5px 0"><strong>${esc(e.name)}</strong><div class="muted">${esc(e.how)}</div></div>`).join('')}
    </div>
  </div>

  <div class="card mb">
    <h3>Controles GEO</h3>
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>Estado</th><th>Control</th><th>Por qué</th><th>Cómo</th></tr></thead>
      <tbody>${g.checks.map((ck) => `<tr>
        <td><span class="geo-status geo-${ck.status}">${ck.status.toUpperCase()}</span></td>
        <td><strong>${esc(ck.title)}</strong></td><td class="small muted">${esc(ck.why)}</td><td class="small">${esc(ck.how)}</td></tr>`).join('')}
      </tbody></table></div>
  </div>

  <div class="grid grid-2">
    <div class="card">
      <h3>Prompts de prueba <span class="sub">ejecutar quincenalmente</span></h3>
      ${g.prompts.map((p) => `<div class="prompt-row"><span class="prompt-n">${p.n}</span>
        <div><div>${esc(p.prompt)}</div><div class="small muted">${esc(p.where)} — ${esc(p.how)}</div></div></div>`).join('')}
    </div>
    <div class="card">
      <h3>Tácticas GEO priorizadas</h3>
      <ul style="margin:0;padding-left:18px;font-size:13.5px">${g.tactics.map((t) => `<li style="margin:5px 0">${esc(t)}</li>`).join('')}</ul>
    </div>
  </div>`;
}

function tabIndexacion(c, result) {
  const ix = result.indexing;
  const done = ix.items.filter((i) => i.done).length;
  return `
  <div class="grid grid-2 mb">
    <div class="card">
      <h3>Artefactos listos para publicar <span class="sub">${done}/${ix.items.length} pasos hechos</span></h3>
      <div class="grid" style="gap:8px">
        <div class="artifact"><span class="fname">/sitemap.xml</span>
          <div class="small muted">${(result.artifacts.sitemapXml.match(/<url>/g) || []).length} URLs · para Search Console / Bing</div>
          <div class="btn-row"><a class="btn btn-sm" target="_blank" href="/api/clients/${c.id}/files/sitemap.xml">Ver</a>
          <a class="btn btn-sm" href="/api/clients/${c.id}/files/sitemap.xml?dl=1">⬇ Descargar</a></div></div>
        <div class="artifact"><span class="fname">/robots.txt</span>
          <div class="small muted">Allow + sitemap declarado</div>
          <div class="btn-row"><a class="btn btn-sm" target="_blank" href="/api/clients/${c.id}/files/robots.txt">Ver</a>
          <a class="btn btn-sm" href="/api/clients/${c.id}/files/robots.txt?dl=1">⬇ Descargar</a></div></div>
        <div class="artifact"><span class="fname">/llms.txt</span>
          <div class="small muted">Mapa legible para ChatGPT, Perplexity, Gemini…</div>
          <div class="btn-row"><a class="btn btn-sm" target="_blank" href="/api/clients/${c.id}/files/llms.txt">Ver</a>
          <a class="btn btn-sm" href="/api/clients/${c.id}/files/llms.txt?dl=1">⬇ Descargar</a></div></div>
      </div>
    </div>
    <div class="card">
      <h3>Envío a buscadores</h3>
      <div class="field"><label>Clave IndexNow</label>
        <input class="input mono" readonly value="${esc(c.indexnowKey)}" onclick="this.select()" />
        <span class="hint">Sube esta clave como <span class="mono">${esc(c.indexnowKey)}.txt</span> a la raíz del sitio (la exige Bing/Yandex para validar), y luego envía la URL.</span>
      </div>
      <button class="btn btn-primary" id="indexnowBtn" onclick="sendIndexNow('${c.id}')">🚀 Enviar a IndexNow</button>
      <div id="indexnowResult" class="mt"></div>
      <hr style="border-color:var(--border);margin:16px 0" />
      <div class="small muted">Google no ofrece envío abierto: usa Search Console → Inspección de URL → Solicitar indexación (checklist de la izquierda).</div>
    </div>
  </div>

  <div class="card">
    <h3>Checklist de indexación</h3>
    <div class="checklist">
      ${ix.items.map((it) => `<div class="ck ${it.done ? 'done' : ''}">
        <span class="box"></span>
        <div><div class="ck-title">${esc(it.step)}</div><div class="ck-detail">${esc(it.detail)}</div></div>
        <span class="chip n ck-group">${esc(it.group)}</span>
      </div>`).join('')}
    </div>
    <div class="btn-row mt">
      <a class="btn btn-sm" href="/api/clients/${c.id}/files/report.md?dl=1">⬇ Informe completo (.md)</a>
      <a class="btn btn-sm" href="/api/clients/${c.id}/files/result.json">⬇ Datos JSON</a>
    </div>
  </div>`;
}

async function sendIndexNow(id) {
  const btn = $('#indexnowBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
  try {
    const out = await api(`/api/clients/${id}/indexnow`, { method: 'POST' });
    const ok = out.result && out.result.ok;
    $('#indexnowResult').innerHTML = `<div class="card" style="padding:12px;border-color:${ok ? 'var(--ok)' : 'var(--warn)'}">
      <div class="small"><strong style="color:${ok ? 'var(--ok)' : 'var(--warn)'}">${ok ? 'Aceptado' : 'Respuesta del motor'}</strong> · ${out.sent} URLs · ${esc(out.result ? out.result.endpoint : '')} · HTTP ${out.result ? out.result.status : '?'}</div>
      <div class="small muted mt">${esc(out.reminder)}</div>
      <pre class="pre mt" style="max-height:110px">${esc(out.result ? out.result.body : '')}</pre>
    </div>`;
    toast(ok ? 'IndexNow aceptó el envío' : 'IndexNow respondió (revisa la clave)', ok ? 'ok' : '');
  } catch (e) {
    toast('IndexNow: ' + e.message, 'err');
    const box = $('#indexnowResult');
    if (box) box.innerHTML = '';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🚀 Enviar a IndexNow'; }
  }
}

function tabHistorial(runs) {
  const scores = runs.filter((r) => r.score != null).map((r) => r.score).reverse();
  const spark = sparkline(scores);
  return `
  <div class="card mb">
    <h3>Evolución del score</h3>
    ${spark || '<p class="muted small">Aún no hay historial de scores.</p>'}
  </div>
  <div class="table-wrap"><table class="tbl">
    <thead><tr><th>Corrida</th><th>Inicio</th><th>Fin</th><th>Estado</th><th class="num">Score</th></tr></thead>
    <tbody>${runs.length ? runs.map((r) => `<tr>
      <td class="mono small">${esc(r.id.slice(-10))}</td>
      <td class="small">${fmtDate(r.startedAt)}</td><td class="small">${fmtDate(r.finishedAt)}</td>
      <td>${statusPill(r.status)}</td>
      <td class="num" style="color:${scoreColor(r.score || 0)};font-weight:700">${r.score == null ? '–' : r.score}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="muted">Sin corridas</td></tr>'}
    </tbody></table></div>`;
}

function sparkline(scores) {
  if (scores.length < 2) return scores.length === 1 ? `<div style="font-size:32px;font-weight:800;color:${scoreColor(scores[0])}">${scores[0]}</div>` : '';
  const w = 600, h = 70, pad = 6;
  const min = Math.min(...scores) - 5, max = Math.max(...scores) + 5;
  const pts = scores.map((s, i) => {
    const x = pad + (i * (w - pad * 2)) / (scores.length - 1);
    const y = h - pad - ((s - min) / (max - min || 1)) * (h - pad * 2);
    return [x, y];
  });
  const line = pts.map((p) => p.join(',')).join(' ');
  const area = `${pad},${h - pad} ${line} ${w - pad},${h - pad}`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polygon points="${area}" fill="rgba(99,102,241,.15)"></polygon>
    <polyline points="${line}" fill="none" stroke="#22d3ee" stroke-width="2.5" stroke-linejoin="round"></polyline>
    ${pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="#6366f1"></circle>`).join('')}
  </svg>`;
}

/* ================= VISTA DEL AGENTE ================= */
async function viewAgente(main, clientId, mode) {
  const clients = await api('/api/clients');
  state.clients = clients;
  if (!clients.length) {
    main.innerHTML = `<div class="empty"><div class="big">✦</div><h2>${isAdmin() ? 'Primero crea un cliente' : 'Sin cliente asignado'}</h2>
      <p>${isAdmin() ? 'El agente necesita una URL, un rubro y keywords para trabajar.' : 'La agencia aún no te ha asignado un cliente a tu cuenta.'}</p>
      ${isAdmin() ? '<button class="btn btn-primary" onclick="openClientModal()">＋ Nuevo cliente</button>' : ''}</div>`;
    return;
  }
  const cid = clientId || clients[0].id;
  const client = clients.find((c) => c.id === cid) || clients[0];
  state.agent = { runId: null, clientId: client.id, poll: null, done: false };

  main.innerHTML = `
    <div class="page-head">
      <div><h1 class="page-title">Agente</h1><p class="page-sub">Pipeline autónomo: 10 pasos · auditoría en vivo → estrategia → contenido → GEO → indexación → informe</p></div>
    </div>

    <div class="card mb">
      <div class="run-hero">
        <div style="flex:1;min-width:240px">
          <div class="field" style="margin-bottom:10px">
            <label>Cliente</label>
            <select class="input select-inline" id="agentClient" onchange="onAgentClientChange(this.value)">
              ${clients.map((c) => `<option value="${c.id}" ${c.id === client.id ? 'selected' : ''}>${esc(c.name)} — ${esc(c.url)}</option>`).join('')}
            </select>
          </div>
          <div class="small muted" id="agentMeta">${esc(client.url)} · ${(client.keywords || []).length} keywords · ${esc(client.market)}</div>
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" id="runBtn" onclick="runAgentNow()">▶ Ejecutar agente</button>
        </div>
      </div>
    </div>

    <div class="steps mb" id="stepsGrid"></div>

    <div class="card">
      <h3>Bitácora en vivo <span class="sub" id="logStatus">inactiva</span></h3>
      <div class="console" id="console"><span class="ln info">Listo. Selecciona un cliente y pulsa «Ejecutar agente».</span></div>
      <div id="runSummary" class="mt"></div>
    </div>`;

  const runs = await api('/api/runs?clientId=' + client.id);
  const active = runs.find((r) => r.status === 'running' || r.status === 'queued');
  if (active) {
    pollRun(active.id, 0, false);
    setBusyBtn(true);
  } else if (runs.length) {
    attachRunSnapshot(runs[0].id);
  }

  if (mode === 'run' && !active) runAgentNow();
}

function onAgentClientChange(id) { location.hash = `#/agente/${id}`; }

function setBusyBtn(busy) {
  const btn = $('#runBtn');
  if (btn) { btn.disabled = busy; btn.textContent = busy ? '⏳ Agente en marcha…' : '▶ Ejecutar agente'; }
  const dot = $('#agentDot');
  if (dot) dot.classList.toggle('busy', busy);
}

/* --- ejecución con streaming (POST SSE) --- */
async function runAgentNow() {
  const sel = $('#agentClient');
  if (!sel) return;
  const cid = sel.value;
  setBusyBtn(true);
  try {
    const res = await fetch(`/api/clients/${cid}/run`, {
      method: 'POST',
      headers: { 'Accept': 'text/event-stream' },
    });
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); msg = j.error || msg; } catch { /* noop */ }
      throw new Error(msg);
    }
    attachRunStream(res, cid);
  } catch (e) {
    toast(e.message, 'err');
    setBusyBtn(false);
  }
}

function prepareConsole() {
  const box = $('#console');
  if (box) { box.innerHTML = ''; box.dataset.mode = 'live'; }
  const sum = $('#runSummary');
  if (sum) sum.innerHTML = '';
}

function attachRunStream(res, clientId) {
  state.agent.done = false;
  state.agent.clientId = clientId;
  prepareConsole();
  setLogStatus('en vivo…');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  const handle = (type, p) => {
    if (type === 'snapshot') { renderSteps(p.run.steps); (p.run.log || []).forEach(appendLog); }
    else if (type === 'steps') renderSteps(p);
    else if (type === 'log') appendLog(p);
    else if (type === 'done') {
      state.agent.done = true;
      state.agent.runId = p.runId;
      finalize(p.runId);
    }
  };

  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let type = null, data = '';
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event: ')) type = line.slice(7);
            else if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (type) { try { handle(type, JSON.parse(data)); } catch { /* noop */ } }
        }
      }
    } catch { /* conexión interrumpida */ }

    if (!state.agent.done) {
      setLogStatus('reconectando…');
      recoverLatestRun(clientId);
    } else {
      setLogStatus('completada');
      setBusyBtn(false);
    }
  })();
}

async function recoverLatestRun(clientId) {
  try {
    const runs = await api('/api/runs?clientId=' + clientId);
    const active = runs.find((r) => r.status === 'running' || r.status === 'queued');
    if (active) { pollRun(active.id, 0, true); return; }
    if (runs.length) attachRunSnapshot(runs[0].id);
  } catch { /* noop */ }
  setBusyBtn(false);
}

/** Snapshot de una corrida existente (histórico o activa re-cargada). */
async function attachRunSnapshot(runId) {
  try {
    const run = await api('/api/runs/' + runId);
    renderSteps(run.steps);
    const box = $('#console');
    if (box && box.dataset.mode !== 'live') { box.innerHTML = ''; box.dataset.mode = 'live'; }
    else if (box && !box.innerHTML.trim()) { box.innerHTML = ''; }
    (run.log || []).forEach(appendLog);
    const active = run.status === 'running' || run.status === 'queued';
    setLogStatus(active ? 'en curso…' : 'histórico');
    if (run.result) finishRun(run);
    if (active) { setBusyBtn(true); pollRun(runId, (run.log || []).length, false); }
    else { resetRunUI(run); }
  } catch { /* noop */ }
}

/** Polling para corridas activas iniciadas en otra pestaña / recuperación. */
function pollRun(runId, seenLog, toastOnDone) {
  if (state.agent.poll) clearInterval(state.agent.poll);
  let seen = seenLog || 0;
  const box = $('#console');
  if (box && seen === 0) { box.innerHTML = ''; box.dataset.mode = 'live'; }
  state.agent.poll = setInterval(async () => {
    try {
      const run = await api('/api/runs/' + runId);
      const log = run.log || [];
      if (log.length > seen) { log.slice(seen).forEach(appendLog); seen = log.length; }
      renderSteps(run.steps);
      setLogStatus('en vivo…');
      if (run.status === 'done' || run.status === 'error') {
        clearInterval(state.agent.poll);
        state.agent.poll = null;
        if (toastOnDone !== false) finalize(runId);
        else { finishRun(run); resetRunUI(run); }
      }
    } catch { /* retry */ }
  }, 900);
}

function resetRunUI(run) {
  setBusyBtn(false);
  if (run && run.status === 'error') showRunError(run);
}

async function finalize(runId) {
  try {
    const run = await api('/api/runs/' + runId);
    finishRun(run);
    resetRunUI(run);
    const clients = await api('/api/clients');
    clients.forEach((c) => { runsCache[c.id] = c; });
    state.clients = clients;
    state.agent.done = true;
    toast('Corrida del agente completada', 'ok');
  } catch { /* noop */ }
}

function renderSteps(steps) {
  const grid = $('#stepsGrid');
  if (!grid) return;
  grid.innerHTML = steps.map((s) => `
    <div class="step ${s.status}" data-step="${s.id}">
      <span class="ic"></span>
      <div>
        <div class="st-name">${esc(s.label)}</div>
        <div class="st-desc">${esc(s.desc)}</div>
        ${s.summary ? `<div class="st-sum">${esc(s.summary)}</div>` : ''}
      </div>
    </div>`).join('');
}

function appendLog(entry) {
  const box = $('#console');
  if (!box) return;
  if (box.dataset.mode !== 'live') { box.innerHTML = ''; box.dataset.mode = 'live'; }
  const ln = document.createElement('span');
  ln.className = 'ln';
  ln.innerHTML = `<span class="t">${fmtTime(entry.t)}</span> <span class="${esc(entry.level)}">${esc(entry.msg)}</span>`;
  box.appendChild(ln);
  box.scrollTop = box.scrollHeight;
}

function setLogStatus(txt) { const el = $('#logStatus'); if (el) el.textContent = txt; }

function finishRun(run) {
  const sum = $('#runSummary');
  if (!sum || !run.result || !run.result.audit) {
    if (sum && run.status === 'error') showRunError(run);
    return;
  }
  const s = run.result.audit.score;
  sum.innerHTML = `
    <div class="card">
      <div class="run-hero">
        ${ringSVG(s.total, s.grade, true)}
        <div style="flex:1;min-width:200px">
          <strong>Corrida completada</strong>
          <div class="small muted">${s.criticals} críticos · ${s.open} hallazgos · GEO ${run.result.geo.readiness}% · ${run.result.content.length} briefs</div>
        </div>
        <div class="btn-row">
          <a class="btn btn-sm btn-primary" href="#/cliente/${run.clientId}">Ver informe completo</a>
          <a class="btn btn-sm" href="/api/clients/${run.clientId}/files/report.md?dl=1">⬇ .md</a>
        </div>
      </div>
    </div>`;
}

function showRunError(run) {
  const sum = $('#runSummary');
  if (sum) sum.innerHTML = `<div class="card" style="border-color:var(--bad)"><strong>La corrida terminó con errores</strong><div class="small muted">${esc(run.error || '')}</div></div>`;
}

/* ================= AJUSTES ================= */
async function viewAjustes(main) {
  requireAdminView(main);
  const s = await api('/api/settings');
  state.settings = s;
  main.innerHTML = `
    <div class="page-head">
      <div><h1 class="page-title">Ajustes</h1><p class="page-sub">Autonomía del agente, marca de la agencia y LLM opcional</p></div>
    </div>
    <div class="grid grid-2">
      <div class="card">
        <h3>Agencia y autonomía</h3>
        <div class="field"><label>Nombre de la agencia / consultoría</label>
          <input class="input" id="setAgency" value="${esc(s.agencyName)}" placeholder="Ej: Estudio Norte" />
          <span class="hint">Aparece en los informes que entregas al cliente.</span></div>
        <div class="switch-row">
          <div><div class="sw-title">Modo autónomo</div><div class="sw-desc">Al crear o editar un cliente, el agente se ejecuta solo (auditoría + estrategia + archivos).</div></div>
          <label class="switch"><input type="checkbox" id="setAuto" ${s.autonomous ? 'checked' : ''}><i></i></label>
        </div>
        <div class="switch-row">
          <div><div class="sw-title">Re-ejecución automática</div><div class="sw-desc">Cron del Worker: vuelve a correr el agente si la última corrida superó N horas (0 = apagado).</div></div>
          <div style="width:110px"><input class="input" type="number" id="setRecheck" min="0" max="720" value="${s.recheckHours}" /> <span class="hint">horas</span></div>
        </div>
        <button class="btn btn-primary mt" onclick="saveSettings()">Guardar ajustes</button>
      </div>

      <div class="card">
        <h3>LLM opcional <span class="sub">OpenAI-compatible</span></h3>
        <p class="small muted">Si configuras un LLM, el agente usará tu modelo para redactar el resumen ejecutivo de cada informe. Sin LLM, funciona el motor determinista integrado (sin costo por token).</p>
        <div class="field"><label>Base URL</label>
          <input class="input mono" id="llmBase" value="${esc(s.llm.baseUrl)}" placeholder="https://api.openai.com/v1" /></div>
        <div class="field"><label>API key</label>
          <input class="input mono" id="llmKey" type="password" value="${esc(s.llm.apiKey)}" placeholder="sk-…" />
          <span class="hint">Guardada en D1 (tabla settings), solo la usa este Worker.</span></div>
        <div class="field"><label>Modelo</label>
          <input class="input mono" id="llmModel" value="${esc(s.llm.model)}" placeholder="gpt-4o-mini / claude-3-5-sonnet…" /></div>
        <button class="btn" onclick="saveSettings()">Guardar LLM</button>
      </div>

      <div class="card">
        <h3>Cómo trabaja el agente</h3>
        <ol class="small muted" style="padding-left:18px;line-height:1.9">
          <li>Descarga la home y mide estado, tiempo y peso.</li>
          <li>Lee robots.txt, sitemap.xml y llms.txt; rastrea enlaces internos.</li>
          <li>Analiza title/meta/Hn/ imágenes/keywords y datos estructurados.</li>
          <li>Evalúa señales GEO/AEO para ChatGPT, Perplexity, Gemini y AI Overviews.</li>
          <li>Calcula el score 0–100 y prioriza hallazgos.</li>
          <li>Construye la estrategia de 90 días con mapa de keywords y KPIs.</li>
          <li>Escribe briefs de contenido listos para publicar.</li>
          <li>Genera sitemap.xml, robots.txt y llms.txt.</li>
          <li>Deja el checklist GSC/Bing/IndexNow para indexar.</li>
          <li>Entrega el informe Markdown del cliente.</li>
        </ol>
      </div>

      <div class="card">
        <h3>Base de datos y cron</h3>
        <p class="small muted">Datos en <span class="mono">Cloudflare D1</span>: usuarios, sesiones, clientes, corridas y ajustes. El cron automático (<span class="mono">*/15 * * * *</span>) hace el re-check autónomo y recupera corridas interrumpidas.</p>
        <div class="btn-row">
          <button class="btn btn-sm" onclick="runCronNow()">⚙ Ejecutar cron ahora</button>
          <a class="btn btn-sm" href="/api/runs">API corridas</a>
          <a class="btn btn-sm" href="/api/clients">API clientes</a>
        </div>
      </div>
    </div>`;
}

async function saveSettings() {
  const body = {
    agencyName: $('#setAgency') ? $('#setAgency').value : state.settings.agencyName,
    autonomous: $('#setAuto') ? $('#setAuto').checked : state.settings.autonomous,
    recheckHours: $('#setRecheck') ? Number($('#setRecheck').value) : state.settings.recheckHours,
    llm: {
      baseUrl: $('#llmBase') ? $('#llmBase').value : '',
      apiKey: $('#llmKey') ? $('#llmKey').value : '',
      model: $('#llmModel') ? $('#llmModel').value : '',
    },
  };
  try {
    state.settings = await api('/api/settings', { method: 'PUT', body });
    toast('Ajustes guardados', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function runCronNow() {
  try {
    const out = await api('/api/admin/run-cron', { method: 'POST' });
    toast(out.message || 'Cron ejecutado', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

/* ================= init ================= */
Object.assign(window, {
  openClientModal, closeModal, removeClient, createDemo,
  goTab, copyBrief, sendIndexNow, runAgentNow,
  onAgentClientChange, saveSettings, logout,
  openUserModal, openPasswordModal, removeUser, runCronNow,
});

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', async () => {
  try {
    await refreshAuth();
    if (state.user && isAdmin()) {
      api('/api/settings').then((s) => { state.settings = s; }).catch(() => {});
    }
    await render();
    api('/api/runs').then((rs) => rs.forEach((r) => { runsCache[r.id] = r; })).catch(() => {});
  } catch (e) {
    $('#main').innerHTML = `<div class="empty"><div class="big">⚠</div><h2>Sin conexión con la API</h2><p class="mono">${esc(e.message)}</p></div>`;
  }
});

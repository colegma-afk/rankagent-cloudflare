/* Smoke de UI — requiere el dev server: npm run dev (y usuarios de prueba creados). */
/* Smoke test UI RankAgent CF: login admin + login cliente + rutas con jsdom */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const html = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => { if (!/Could not load/i.test(e.message)) errors.push('jsdomError: ' + e.message); });

const dom = new JSDOM(html, { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
const { window } = dom;

/* fetch con cookie simulada (jsdom no persiste Set-Cookie) */
let cookie = '';
window.fetch = async (path, init = {}) => {
  const url = new URL(path, BASE);
  const headers = new Headers(init.headers || {});
  if (cookie) headers.set('Cookie', cookie);
  const res = await fetch(url, { ...init, headers });
  const sc = res.headers.get('Set-Cookie');
  if (sc) {
    const m = sc.match(/ra_sess=([^;]+)/);
    if (m) cookie = 'ra_sess=' + m[1];
  }
  return res;
};
window.EventSource = class { addEventListener() {} close() {} };
window.confirm = () => true;
window.navigator.clipboard = { writeText: async () => {} };
window.addEventListener('error', (e) => errors.push('error: ' + (e.message || e.error)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function goto(hash, expects = []) {
  window.location.hash = hash;
  await sleep(300);
  const main = window.document.querySelector('#main');
  const txt = main ? main.textContent : '';
  const missing = expects.filter((t) => !txt.includes(t));
  console.log((missing.length ? 'FAIL' : ' OK '), hash.padEnd(36), missing.length ? 'falta: ' + JSON.stringify(missing) : '');
  if (missing.length) process.exitCode = 1;
  return txt;
}

async function login(email, password) {
  window.location.hash = '#/login';
  await sleep(250);
  const form = window.document.querySelector('#loginForm');
  if (!form) { console.log('FAIL  no hay formulario de login'); process.exitCode = 1; return false; }
  form.querySelector('[name=email]').value = email;
  form.querySelector('[name=password]').value = password;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(700);
  return !!cookie;
}

(async () => {
  window.eval(appJs);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await sleep(700);

  /* 1. sin sesión → login */
  await goto('#/panel', ['Iniciar sesión']);
  await goto('#/ajustes', ['Iniciar sesión']);

  /* 2. admin login */
  const okAdmin = await login('ana@agencia.cl', 'secreta123');
  console.log((okAdmin ? ' OK ' : 'FAIL'), 'login admin (cookie capturada)');
  if (!okAdmin) process.exitCode = 1;
  window.location.hash = '#/panel';
  await sleep(500);
  const panel = window.document.querySelector('#main').textContent;
  const adminChecks = ['Panel', 'Café Puerto Norte', 'Score promedio', 'Nuevo cliente'];
  const missA = adminChecks.filter((t) => !panel.includes(t));
  console.log((missA.length ? 'FAIL' : ' OK '), 'panel admin', missA.length ? JSON.stringify(missA) : '');

  await goto('#/clientes', ['Clientes', 'Correr', 'Informe']);
  const id = (await (await window.fetch('/api/clients')).json())[0].id;
  for (const [tab, expects] of [
    ['resumen', ['Score SEO global', 'Resumen ejecutivo']],
    ['auditoria', ['Hallazgos', 'Cobertura de keywords']],
    ['estrategia', ['Fase 1', 'Mapa de keywords']],
    ['contenido', ['Briefs listos', 'FAQ a incluir']],
    ['geo', ['Readiness', 'Prompts de prueba']],
    ['indexacion', ['sitemap.xml', 'IndexNow', 'Checklist']],
    ['historial', ['Evolución del score']],
  ]) await goto(`#/cliente/${id}/${tab}`, expects);

  await goto('#/agente', ['Agente', 'Bitácora', 'Ejecutar agente']);
  await goto('#/usuarios', ['Usuarios', 'cliente@cafe.cl', 'Nuevo usuario']);
  await goto('#/ajustes', ['Ajustes', 'Modo autónomo', 'Ejecutar cron ahora']);

  /* 3. modal usuario */
  window.eval('openUserModal()');
  await sleep(150);
  const um = window.document.querySelector('#userForm');
  console.log((um ? ' OK ' : 'FAIL'), 'modal nuevo usuario');
  if (!um) process.exitCode = 1;
  window.eval('closeModal()');

  /* 4. logout + login cliente */
  cookie = '';
  window.eval('logout()');
  await sleep(400);
  await goto('#/panel', ['Iniciar sesión']);
  const okCli = await login('cliente@cafe.cl', 'nuevaclave1');
  console.log((okCli ? ' OK ' : 'FAIL'), 'login cliente');
  if (!okCli) process.exitCode = 1;
  window.location.hash = '#/panel';
  await sleep(500);
  const panelC = window.document.querySelector('#main').textContent;
  const cliChecks = ['Café Puerto Norte'];
  const missC = cliChecks.filter((t) => !panelC.includes(t));
  console.log((missC.length ? 'FAIL' : ' OK '), 'panel cliente (ve su cliente)', missC.length ? JSON.stringify(missC) : '');
  if (missC.length) process.exitCode = 1;

  /* nav sin enlaces admin */
  const adminNavHidden = [...window.document.querySelectorAll('#nav a[data-admin]')].every((a) => a.style.display === 'none');
  console.log((adminNavHidden ? ' OK ' : 'FAIL'), 'nav admin oculta para cliente');
  if (!adminNavHidden) process.exitCode = 1;

  /* ruta admin redirige */
  window.location.hash = '#/usuarios';
  await sleep(350);
  const redirected = window.location.hash === '#/panel';
  console.log((redirected ? ' OK ' : 'FAIL'), '#/usuarios redirige a panel para cliente');
  if (!redirected) process.exitCode = 1;

  await goto('#/ajustes', ['Panel']); // debe redirigir al panel
  await goto(`#/cliente/${id}/geo`, ['Readiness', 'Prompts de prueba']); // informe propio visible

  if (errors.length) {
    console.log('\nERRORES JS:');
    errors.forEach((e) => console.log(' -', e));
    process.exitCode = 1;
  }
  console.log('\n' + (process.exitCode ? 'SMOKE CF: CON FALLOS' : 'SMOKE CF: TODO OK'));
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

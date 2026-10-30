'use strict';
/**
 * Orquestador del agente: pipeline autónomo de 10 pasos que produce
 * auditoría → score → estrategia → contenido → GEO → indexación → informe.
 */
const { auditSite } = require('./audit.cjs');
const { buildStrategy, buildContentPlan } = require('./plan.cjs');
const { geoPlan, llmsTxt } = require('./geo.cjs');
const { robotsTxt, sitemapXml, indexingChecklist } = require('./indexing.cjs');
const { buildReport } = require('./report.cjs');
const llm = require('./llm.cjs');
const store = require('../src/store.cjs');

const STEP_DEFS = [
  { id: 'fetch', label: 'Reconocimiento del sitio', desc: 'Descarga la home, mide estado, tiempo y peso' },
  { id: 'robots', label: 'Rastreo técnico', desc: 'robots.txt, sitemap.xml, llms.txt y enlaces internos' },
  { id: 'onpage', label: 'Análisis on-page', desc: 'Title, meta, Hn, imágenes, enlaces, keywords' },
  { id: 'schema', label: 'Estructura y E-E-A-T', desc: 'JSON-LD, confianza, señales de entidad' },
  { id: 'geo', label: 'Señales GEO/AEO', desc: 'Preparación para buscadores web e IA' },
  { id: 'score', label: 'Diagnóstico y scoring', desc: 'Prioriza hallazgos por impacto' },
  { id: 'strategy', label: 'Estrategia 90 días', desc: 'Fases, mapa de keywords, KPIs' },
  { id: 'content', label: 'Plan de contenido', desc: 'Briefs con title, esquema y FAQ' },
  { id: 'indexing', label: 'Artefactos de indexación', desc: 'sitemap, robots, llms.txt, checklist' },
  { id: 'report', label: 'Informe final', desc: 'Informe Markdown + resumen para el cliente' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ejecuta una corrida completa.
 * @param {object} run registro de ejecución (mutado en memoria y persistido)
 * @param {object} client
 * @param {(type:string, payload:any) => void} emit emitter de eventos SSE
 */
async function runAgent(run, client, emit) {
  const settings = await store.getSettings();
  const log = (level, msg, stepId) => {
    const entry = { t: Date.now(), level, msg, step: stepId || run.currentStep };
    run.log.push(entry);
    emit('log', entry);
  };
  const startStep = (id) => {
    run.currentStep = id;
    const st = run.steps.find((s) => s.id === id);
    if (st) { st.status = 'running'; st.startedAt = new Date().toISOString(); }
    emit('steps', run.steps);
    log('info', `▶ ${STEP_DEFS.find((d) => d.id === id).label}`, id);
  };
  const endStep = async (id, status, summary) => {
    const st = run.steps.find((s) => s.id === id);
    if (st) { st.status = status; st.summary = summary || ''; st.endedAt = new Date().toISOString(); }
    emit('steps', run.steps);
    await store.upsertRun(run);
  };

  run.status = 'running';
  run.startedAt = new Date().toISOString();
  emit('steps', run.steps);
  await store.upsertRun(run);

  const result = { audit: null, strategy: null, content: null, geo: null, indexing: null, reportMd: '', llmUsed: false, artifacts: {} };

  try {
    /* 1 — Reconocimiento */
    startStep('fetch');
    await sleep(150);
    result.audit = await auditSite(client, (level, msg) => log(level, msg, 'fetch'));
    await endStep('fetch', result.audit.homepage ? 'done' : 'warn',
      result.audit.homepage
        ? `HTTP ${result.audit.fetch.status} · ${Math.round(result.audit.fetch.bytes / 1024)} KB · ${result.audit.fetch.timeMs} ms`
        : `Acceso fallido: ${result.audit.fetch.error || 'HTTP ' + result.audit.fetch.status}`);

    /* 2 — Rastreo técnico (ya incluido en auditSite; se reporta) */
    startStep('robots');
    await sleep(120);
    log(result.audit.robots.ok ? 'ok' : 'warn', `robots.txt: ${result.audit.robots.ok ? 'OK' : 'ausente'}`, 'robots');
    log(result.audit.sitemap.ok ? 'ok' : 'warn', `sitemap.xml: ${result.audit.sitemap.ok ? result.audit.sitemap.count + ' URLs' : 'ausente'}`, 'robots');
    log(result.audit.crawled.length ? 'ok' : 'info', `URLs descubiertas por enlaces: ${result.audit.crawled.length}`, 'robots');
    await endStep('robots', result.audit.sitemap.ok && result.audit.robots.ok ? 'done' : 'warn',
      `${result.audit.crawled.length} URLs rastreadas · robots ${result.audit.robots.ok ? 'OK' : 'no'} · sitemap ${result.audit.sitemap.ok ? 'OK' : 'no'}`);

    /* 3 — On-page */
    startStep('onpage');
    await sleep(150);
    if (result.audit.homepage) {
      const p = result.audit.homepage;
      log(p.title ? 'ok' : 'err', p.title ? `Title: "${p.title.slice(0, 70)}" (${p.titleLength} car.)` : 'Title: ausente', 'onpage');
      log(p.metaDescription ? 'ok' : 'warn', `Meta description: ${p.metaDescription ? `${p.metaDescLength} car.` : 'ausente'}`, 'onpage');
      log(p.h1Count === 1 ? 'ok' : 'warn', `H1: ${p.h1Count} (${p.h1.slice(0, 60) || '—'})`, 'onpage');
      log('info', `Imágenes sin alt: ${p.imgNoAlt}/${p.imgTotal} · enlaces internos: ${p.internalLinks} · palabras: ${p.wordCount}`, 'onpage');
    } else {
      log('err', 'Sin HTML: no se puede analizar on-page', 'onpage');
    }
    await endStep('onpage', 'done', result.audit.homepage ? `${result.audit.homepage.wordCount} palabras · ${result.audit.issues.filter((i) => i.area === 'onpage').length} hallazgos` : 'sin datos');

    /* 4 — Estructura y E-E-A-T */
    startStep('schema');
    await sleep(120);
    if (result.audit.homepage) {
      const p = result.audit.homepage;
      log(p.jsonldTypes.length ? 'ok' : 'warn', `JSON-LD: ${p.jsonldTypes.length ? p.jsonldTypes.join(', ') : 'ninguno'}`, 'schema');
      log(p.trustSignals ? 'ok' : 'info', `Señales de confianza: ${p.trustSignals ? 'detectadas' : 'débiles'} · CTA: ${p.ctaSignals ? 'sí' : 'no'} · contacto: ${p.contactSignals ? 'sí' : 'no'}`, 'schema');
      log(p.canonical ? 'ok' : 'warn', `Canonical: ${p.canonical || 'ausente'}`, 'schema');
    }
    await endStep('schema', 'done', result.audit.homepage ? `${result.audit.homepage.jsonldTypes.length} schema(s) detectados(s)` : 'sin datos');

    /* 5 — GEO */
    startStep('geo');
    await sleep(150);
    result.geo = geoPlan(client, result.audit);
    log(result.audit.llms.ok ? 'ok' : 'warn', `Readiness GEO: ${result.geo.readiness}%`, 'geo');
    for (const c of result.geo.checks.filter((c) => c.status === 'fail').slice(0, 4)) log('warn', `GEO ✗ ${c.title}`, 'geo');
    await endStep('geo', result.geo.readiness >= 60 ? 'done' : 'warn', `Readiness GEO ${result.geo.readiness}%`);

    /* 6 — Scoring */
    startStep('score');
    await sleep(150);
    const s = result.audit.score;
    log(s.criticals ? 'err' : 'ok', `Score ${s.total}/100 · grado ${s.grade} · ${s.criticals} críticos / ${s.open} hallazgos`, 'score');
    for (const i of result.audit.issues.slice(0, 5)) log(i.severity === 'critico' ? 'err' : 'warn', `[${i.severity}] ${i.title}`, 'score');
    await endStep('score', 'done', `${s.total}/100 (grado ${s.grade})`);

    /* 7 — Estrategia (con LLM opcional para el resumen ejecutivo) */
    startStep('strategy');
    await sleep(150);
    result.strategy = buildStrategy(client, result.audit);
    const sys = 'Eres estratega SEO senior para pymes. Respondes en español neutro, concreto y sin relleno, en máximo 120 palabras.';
    const llmSummary = await llm.complete(settings, sys,
      `Cliente: ${client.name} (${client.niche || 'rubro no definido'}), mercado ${client.market}. Score SEO ${s.total}/100, ${s.criticals} críticos. Top hallazgos: ${result.audit.issues.slice(0, 3).map((i) => i.title).join('; ') || 'ninguno'}. Keywords: ${client.keywords.join(', ') || 'n/d'}. Resume el plan prioritario de 90 días.`);
    if (llmSummary) {
      result.strategy.executiveSummary = llmSummary;
      result.llmUsed = true;
      log('ok', 'Resumen ejecutivo redactado con LLM configurado', 'strategy');
    } else {
      log('info', 'Resumen ejecutivo generado con motor determinista' + (settings.llm.apiKey ? ' (LLM no respondió)' : ' (sin LLM configurado)'), 'strategy');
    }
    log('ok', `Estrategia: ${result.strategy.phases.length} fases · ${result.strategy.keywordPlan.length} keywords · ${result.strategy.kpis.length} KPIs`, 'strategy');
    await endStep('strategy', 'done', `${result.strategy.phases.reduce((n, p) => n + p.tasks.length, 0)} acciones planificadas`);

    /* 8 — Contenido */
    startStep('content');
    await sleep(150);
    result.content = buildContentPlan(client, result.strategy);
    log('ok', `Generados ${result.content.length} briefs: ${result.content.map((b) => b.keyword).join(' | ')}`, 'content');
    await endStep('content', 'done', `${result.content.length} briefs listos`);

    /* 9 — Indexación */
    startStep('indexing');
    await sleep(150);
    result.artifacts.robotsTxt = robotsTxt(client);
    result.artifacts.sitemapXml = sitemapXml(client, result.audit, false);
    result.artifacts.llmsTxt = llmsTxt(client, result.audit.crawled.filter((c) => c.status === 200));
    result.indexing = indexingChecklist(client, result.audit);
    log('ok', `robots.txt, sitemap.xml (${(result.artifacts.sitemapXml.match(/<url>/g) || []).length} URLs) y llms.txt listos`, 'indexing');
    log('info', `IndexNow: clave ${client.indexnowKey.slice(0, 8)}… — sube ${client.indexnowKey}.txt a la raíz del sitio para activarlo`, 'indexing');
    await endStep('indexing', 'done', '3 artefactos generados');

    /* 10 — Informe */
    startStep('report');
    await sleep(150);
    result.reportMd = buildReport(client, result, settings);
    log('ok', `Informe de ${result.reportMd.split('\n').length} líneas listo para el cliente`, 'report');
    await endStep('report', 'done', 'Informe Markdown + JSON exportables');

    run.status = 'done';
    run.finishedAt = new Date().toISOString();
    run.result = result;
    await store.upsertRun(run);
    await store.updateClientMeta(client.id, {
      lastRunId: run.id,
      lastScore: s.total,
      lastCriticals: s.criticals,
      lastRunAt: run.finishedAt,
    });
    log('ok', '✅ Corrida del agente completada', 'report');
    emit('done', { runId: run.id, score: s.total, grade: s.grade, status: 'done' });
  } catch (e) {
    run.status = 'error';
    run.finishedAt = new Date().toISOString();
    run.error = String(e && e.stack || e);
    run.result = result;
    await store.upsertRun(run);
    log('err', 'Error fatal en el pipeline: ' + (e && e.message), run.currentStep);
    emit('done', { runId: run.id, status: 'error', error: String(e && e.message) });
  }
}

function newRun(clientId) {
  return {
    id: store.uid('r'),
    clientId,
    status: 'queued',
    currentStep: null,
    startedAt: null,
    finishedAt: null,
    log: [],
    steps: STEP_DEFS.map((d) => ({ id: d.id, label: d.label, desc: d.desc, status: 'pending', summary: '', startedAt: null, endedAt: null })),
    result: null,
    error: null,
  };
}

module.exports = { runAgent, newRun, STEP_DEFS };

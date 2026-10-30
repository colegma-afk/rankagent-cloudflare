'use strict';
/**
 * Informe final en Markdown para el cliente (descargable/copy-paste).
 */
const { marketInfo } = require('./plan.cjs');

function sevIcon(s) { return s === 'critico' ? '🟥' : s === 'alto' ? '🟧' : s === 'medio' ? '🟨' : '🟦'; }

function buildReport(client, result, settings) {
  const { audit, strategy, content, geo, indexing } = result;
  const s = audit.score;
  const md = [];
  const info = marketInfo(client.market);
  const date = new Date().toISOString().slice(0, 10);

  md.push(`# Informe SEO — ${client.name}`);
  md.push('');
  md.push(`**Agencia:** ${settings.agencyName} · **Fecha:** ${date} · **Mercado:** ${info.label} (${client.market})`);
  md.push(`**URL:** ${client.url} · **Rubro:** ${client.niche || '—'} · **Tipo:** ${client.type}`);
  md.push('');
  md.push('---');
  md.push('');
  md.push('## 1. Resumen ejecutivo');
  md.push('');
  md.push(strategy.executiveSummary);
  md.push('');
  md.push(`### Score global: **${s.total}/100 (Grado ${s.grade})**`);
  md.push('');
  md.push('| Área | Puntos | Máximo |');
  md.push('|---|---:|---:|');
  for (const [k, v] of Object.entries(s.categories)) md.push(`| ${k} | ${v.got} | ${v.max} |`);
  md.push('');
  md.push(`- 🔴 Críticos: **${s.criticals}** · Hallazgos abiertos: **${s.open}**`);
  md.push(`- HTTP: **${audit.fetch.status || 'error'}** · ${audit.fetch.bytes ? Math.round(audit.fetch.bytes / 1024) + ' KB' : '—'} · ${audit.fetch.timeMs} ms`);
  md.push(`- URLs rastreadas: **${audit.crawled.length}** · robots.txt: **${audit.robots.ok ? 'OK' : 'no'}** · sitemap: **${audit.sitemap.ok ? audit.sitemap.count + ' URLs' : 'no'}** · llms.txt: **${audit.llms.ok ? 'sí' : 'no'}**`);
  md.push('');
  md.push('---');
  md.push('');
  md.push('## 2. Hallazgos priorizados');
  md.push('');
  md.push('| | Área | Hallazgo | Recomendación |');
  md.push('|---|---|---|---|');
  for (const i of audit.issues.slice(0, 25)) {
    md.push(`| ${sevIcon(i.severity)} ${i.severity} | ${i.area} | ${cell(i.title)} | ${cell(i.fix)} |`);
  }
  if (!audit.issues.length) md.push('| ✅ | — | Sin hallazgos abiertos | Mantener monitoreo |');
  md.push('');
  if (audit.keywordAnalysis.length) {
    md.push('### Cobertura de keywords objetivo');
    md.push('');
    md.push('| Keyword | En title | En H1 | En meta | Ocurrencias | Cobertura términos |');
    md.push('|---|:-:|:-:|:-:|---:|---:|');
    for (const k of audit.keywordAnalysis) {
      md.push(`| ${cell(k.keyword)} | ${k.inTitle ? '✅' : '❌'} | ${k.inH1 ? '✅' : '❌'} | ${k.inDescription ? '✅' : '❌'} | ${k.occurrences} | ${k.coverage}% |`);
    }
    md.push('');
  }
  md.push('---');
  md.push('');
  md.push('## 3. Estrategia 90 días');
  md.push('');
  for (const ph of strategy.phases) {
    md.push(`### ${ph.name}`);
    md.push(`*Objetivo: ${ph.goal}*`);
    md.push('');
    md.push('| Tarea | Por qué | Cómo | Fuente |');
    md.push('|---|---|---|---|');
    for (const t of ph.tasks) md.push(`| ${cell(t.task)} | ${cell(t.why)} | ${cell(t.fix)} | ${t.src} |`);
    md.push('');
  }
  md.push('### Mapa de keywords');
  md.push('');
  md.push('| Prioridad | Keyword | Intención | Contenido sugerido | Mes |');
  md.push('|---|---|---|---|---|');
  for (const k of strategy.keywordPlan) {
    md.push(`| ${k.priority} | ${cell(k.keyword)} | ${k.intent} | ${cell(k.contentType)} | 1–3 |`);
  }
  md.push('');
  md.push('### KPIs y cadencia');
  md.push('');
  md.push('| KPI | Meta | Frecuencia |');
  md.push('|---|---|---|');
  for (const k of strategy.kpis) md.push(`| ${k.kpi} | ${k.meta} | ${k.cadence} |`);
  md.push('');
  md.push(`**Cadencia de contenido:** ${strategy.contentCadence}`);
  md.push('');
  md.push('---');
  md.push('');
  md.push('## 4. Plan de contenido (briefs)');
  md.push('');
  for (const b of content) {
    md.push(`### ${b.order}. “${b.keyword}” — ${b.intentLabel} · ${b.priority} · publicar ${b.publishBy}`);
    md.push('');
    md.push(`- **Title (${b.titleLength}):** ${b.title}`);
    md.push(`- **Meta (${b.metaLength}):** ${b.meta}`);
    md.push(`- **Slug:** \`${b.slug}\``);
    md.push(`- **H1:** ${b.h1}`);
    md.push(`- **Extensión:** ${b.wordTarget} palabras · **Schema:** ${b.schema}`);
    md.push(`- **Enlaces internos:** ${b.internalLinks}`);
    md.push(`- **CTA:** ${b.cta}`);
    md.push('- **Esquema:**');
    for (const sec of b.outline) {
      md.push(`  - **${sec.h2}**`);
      for (const bl of sec.bullets) md.push(`    - ${bl}`);
    }
    md.push(`- **Preguntas FAQ a incluir:** ${b.questions.join(' / ')}`);
    md.push('');
  }
  md.push('---');
  md.push('');
  md.push('## 5. Visibilidad en buscadores IA (GEO/AEO)');
  md.push('');
  md.push(`**Readiness GEO: ${geo.readiness}%**`);
  md.push('');
  md.push('| Estado | Control | Por qué | Cómo |');
  md.push('|---|---|---|---|');
  const ico = { pass: '✅', fail: '❌', warn: '⚠️', info: 'ℹ️' };
  for (const c of geo.checks) md.push(`| ${ico[c.status]} | ${cell(c.title)} | ${cell(c.why)} | ${cell(c.how)} |`);
  md.push('');
  md.push('**Tácticas:**');
  for (const t of geo.tactics) md.push(`- ${t}`);
  md.push('');
  md.push('**Prompts de prueba (ejecutar quincenalmente):**');
  md.push('');
  md.push('| # | Prompt | Dónde |');
  md.push('|---|---|---|');
  for (const p of geo.prompts) md.push(`| ${p.n} | ${cell(p.prompt)} | ${p.where} |`);
  md.push('');
  md.push('---');
  md.push('');
  md.push('## 6. Indexación');
  md.push('');
  md.push('| ✓ | Grupo | Paso | Detalle |');
  md.push('|:-:|---|---|---|');
  for (const it of indexing.items) md.push(`| ${it.done ? 'x' : ' '} | ${it.group} | ${cell(it.step)} | ${cell(it.detail)} |`);
  md.push('');
  md.push('---');
  md.push('');
  md.push(`*Informe generado automáticamente por el agente de ${settings.agencyName}. Re-ejecutar el agente para medir avances.*`);
  md.push('');
  return md.join('\n');
}

function cell(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

module.exports = { buildReport };

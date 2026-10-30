'use strict';
/**
 * GEO / AEO: optimización para buscadores web generativos e IA
 * (Google AI Overviews, ChatGPT, Perplexity, Gemini, Copilot).
 */
const { marketInfo } = require('./plan.cjs');

function llmsTxt(client, extraPages = []) {
  const info = marketInfo(client.market);
  const lines = [
    `# ${client.name}`,
    '',
    `> ${client.niche || 'Sitio web oficial de ' + client.name}. Recurso en español (${info.label}) con información verificable sobre ${client.niche || 'nuestros servicios'}.`,
    '',
    `Sitio principal: [${client.name}](${client.url})`,
    '',
    '## Secciones clave',
    '',
    `- [Inicio](${client.url}) — presentación y oferta principal`,
  ];
  for (const p of extraPages.slice(0, 12)) {
    lines.push(`- [${p.title || p.url}](${p.url})${p.words ? ` — ${p.words} palabras` : ''}`);
  }
  lines.push('');
  lines.push('## Cómo citarnos');
  lines.push('');
  lines.push(`- Nombre de marca: ${client.name}`);
  lines.push(`- Rubro: ${client.niche || 'no declarado'}`);
  lines.push('- Preferencia: citar la URL canonical de cada página y respetar robots.txt.');
  if (client.competitors) lines.push(`- Contexto de mercado: compite con ${client.competitors}.`);
  lines.push('');
  return lines.join('\n');
}

function geoChecks(audit) {
  const page = audit.homepage;
  const items = [];
  const add = (status, title, why, how) => items.push({ status, title, why, how });

  add(audit.llms && audit.llms.ok ? 'pass' : 'fail',
    'Archivo llms.txt publicado',
    'Los modelos (Claude, Perplexity, Gemini) lo usan como mapa de tu sitio.',
    'Publicar /llms.txt generado en Indexación y enlazarlo desde robots.txt.');
  add(page && page.questions.length > 0 ? 'pass' : 'fail',
    'Preguntas frecuentes en la página',
    'Las IA extraen bloques pregunta→respuesta corta.',
    'Añadir 4–6 FAQs como H2/H3 con respuesta de 40–60 palabras justo debajo.');
  add(page && page.jsonldTypes.some((t) => /FAQPage|HowTo|Article|Product|Service/i.test(t)) ? 'pass' : 'fail',
    'Datos estructurados de contenido (Article/FAQPage/HowTo)',
    'Refuerza extracción de entidades y rich results.',
    'Insertar JSON-LD FAQPage + Article/Service en cada URL clave.');
  add(page && page.statCount > 0 ? 'pass' : 'warn',
    'Datos citables (cifras, precios, estadísticas)',
    'Los buscadores IA citan fuentes con datos concretos.',
    'Añadir 2–3 cifras verificables por página, con fuente y fecha.');
  add(page && page.title && page.h1 ? 'pass' : 'fail',
    'Entidad clara: title y H1 consistentes',
    'Los motores deben asociar la página con tu marca y rubro.',
    'Usar patrón “Tema principal | Marca” y H1 con la entidad + propuesta.');
  add(audit.fetch && /^https:/i.test(audit.fetch.finalUrl || '') ? 'pass' : 'fail',
    'HTTPS y respuesta 200',
    'Condición mínima para ser incluido en índices y respuestas.',
    'Mantener TLS vigente y uptime; revisar bloqueos de bot en WAF.');
  add(page && page.canonical ? 'pass' : 'warn',
    'URL canónica única',
    'Evita que las IA citen duplicados de tu contenido.',
    'Declarar canonical absoluto en todas las páginas.');
  add(page && page.metaDescription ? 'pass' : 'warn',
    'Meta description descriptiva',
    'Se usa como resumen en algunos paneles de respuesta.',
    'Descripción única de 140–160 caracteres con la promesa de valor.');
  add('info',
    'Presencia fuera de sitio (señales de entidad)',
    'ChatGPT/Perplexity citan directorios, prensa, Wikipedia y reseñas, no solo tu web.',
    'Mantener NAP consistente en directorios del rubro, menciones en medios locales y perfiles sociales vinculados.');
  add('info',
    'Mantenimiento de contenido',
    'Las IA prefieren fuentes recientes y actualizadas.',
    'Actualizar fecha y datos de los artículos top cada trimestre; re-publicar con fecha visible.');
  return items;
}

function testPrompts(client) {
  const niche = client.niche || 'servicios';
  const info = marketInfo(client.market);
  return [
    `¿Qué ${niche} me recomiendas ${info.prep}?`,
    `Mejores opciones de ${client.keywords && client.keywords[0] ? client.keywords[0] : niche} ${info.prep} (2026)`,
    `¿Conoces ${client.name}? ¿Qué opinas de ellos?`,
    `Alternativas a ${client.competitors ? client.competitors.split(',')[0].trim() : niche + ' tradicional'}`,
    `¿Cuánto cuesta contratar ${client.keywords && client.keywords[1] ? client.keywords[1] : niche} ${info.prep}?`,
  ].map((prompt, i) => ({
    n: i + 1,
    prompt,
    where: ['ChatGPT (búsqueda)', 'Perplexity', 'Google AI Overviews', 'Gemini', 'Microsoft Copilot'][i % 5],
    how: 'Ejecutar cada 2 semanas con sesión anónima y registrar si aparece la marca, con y sin el nombre de marca en el prompt.',
  }));
}

function geoPlan(client, audit) {
  const checks = geoChecks(audit);
  const pass = checks.filter((c) => c.status === 'pass').length;
  return {
    readiness: Math.round((pass / checks.filter((c) => c.status !== 'info').length) * 100),
    checks,
    prompts: testPrompts(client),
    engines: [
      { name: 'Google AI Overviews / AI Mode', how: 'Indexación + datos estructurados + autoridad de dominio + respuestas directas en H2/H3.' },
      { name: 'ChatGPT con búsqueda', how: 'Menciones en sitios que lee (prensa, directorios, reseñas) + llms.txt + HTTPS.' },
      { name: 'Perplexity', how: 'Contenido fresco, citable (cifras + fuentes) y enlaces externos que te referencien.' },
      { name: 'Gemini / Google', how: 'Ecosistema Search + Schema + Google Business Profile si es local.' },
      { name: 'Microsoft Copilot / Bing', how: 'Bing Webmaster Tools + IndexNow (soportado nativamente por Bing).' },
    ],
    tactics: [
      'Publicar llms.txt y declararlo en robots.txt.',
      'Formato de respuesta directa: párrafo de 40–60 palabras bajo cada H2 (ideal para snippets y citaciones).',
      'Tablas y listas ordenadas: los motores de IA las extraen con más frecuencia.',
      '2–3 datos duros por página con fuente y fecha de actualización.',
      'Señales E-E-A-T: autor con nombre y bio, página Nosotros, fecha de revisión visible.',
      'Mención de marca consistente (nombre exacto) en directorios, reseñas y prensa del rubro.',
      'Mantener sitemap y fechas de modificación reales (lastmod honesto).',
      'Pruebas mensuales con los prompts de más abajo y registro en el informe.',
    ],
  };
}

module.exports = { llmsTxt, geoPlan, geoChecks, testPrompts };

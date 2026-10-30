'use strict';
/**
 * Artefactos de indexación: robots.txt, sitemap.xml, IndexNow y checklist GSC/Bing.
 */
const { marketInfo } = require('./plan.cjs');
const { slugify } = require('./audit.cjs');

function robotsTxt(client) {
  const origin = safeOrigin(client.url);
  return [
    'User-agent: *',
    'Allow: /',
    '',
    '# Bloquear rutas privadas (ajustar a tu CMS)',
    'Disallow: /admin',
    'Disallow: /carrito',
    'Disallow: /*?s=', // búsquedas internas',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    `# Mapa legible para IA: ${origin}/llms.txt`,
    '',
    '# RankAgentBot — agente SEO del propietario del sitio',
    'User-agent: RankAgentBot',
    'Allow: /',
    '',
  ].join('\n');
}

function safeOrigin(url) {
  try { return new URL(url).origin; } catch { return 'https://example.com'; }
}

function xmlEscape(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sitemapXml(client, audit, includePlanned = false) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [];
  urls.push({ loc: client.url, priority: '1.0', changefreq: 'weekly', lastmod: today });

  const seen = new Set([client.url.replace(/\/$/, '')]);
  for (const c of (audit && audit.crawled) || []) {
    if (c.status !== 200) continue;
    const key = c.url.replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push({ loc: c.url, priority: '0.7', changefreq: 'monthly', lastmod: today });
  }

  const planned = [];
  if (includePlanned) {
    const seeds = (client.keywords || []).slice(0, 8);
    for (const s of seeds) {
      const loc = safeOrigin(client.url) + '/' + slugify(s);
      if (seen.has(loc)) continue;
      seen.add(loc);
      planned.push({ loc, priority: '0.6', changefreq: 'monthly', lastmod: today });
    }
  }

  const body = [...urls, ...planned].map((u) =>
    `  <url>\n    <loc>${xmlEscape(u.loc)}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function indexingChecklist(client, audit) {
  const origin = safeOrigin(client.url);
  const isLocal = client.type === 'local';
  const market = marketInfo(client.market);
  const items = [
    { step: 'Verificar el dominio en Google Search Console', detail: 'Método etiqueta HTML o DNS. Sin GSC no hay datos de impresiones/posiciones.', done: false, group: 'Google' },
    { step: 'Enviar el sitemap en Search Console', detail: `Ruta: ${origin}/sitemap.xml (pestaña Sitemaps).`, done: false, group: 'Google' },
    { step: 'Solicitar indexación de la home y URLs clave', detail: 'URL Inspection → Request Indexing (hasta ~10/día).', done: false, group: 'Google' },
    { step: 'Registrar y verificar en Bing Webmaster Tools', detail: 'Bing no indexa “solo por defecto”; hay que registrarse (o importar desde GSC).', done: false, group: 'Bing' },
    { step: 'Activar IndexNow (Bing/Yandex/Seznam)', detail: `Sube la clave a ${origin}/${client.indexnowKey}.txt y pulsa “Enviar a IndexNow” en esta pestaña.`, done: false, group: 'Bing' },
    { step: 'Publicar robots.txt con la línea Sitemap', detail: 'Disponible para copiar/descargar en esta pestaña.', done: !!audit.robots?.ok, group: 'Técnico' },
    { step: 'Publicar llms.txt (capa GEO)', detail: `Disponible en esta pestaña → ${origin}/llms.txt`, done: !!audit.llms?.ok, group: 'GEO/IA' },
    { step: 'Canonical + hreflang si el sitio es multilingüe', detail: market.lang + ' es el idioma principal declarado.', done: !!audit.homepage?.canonical, group: 'Técnico' },
    { step: 'Instalar analítica (GA4 o similar) y metas de conversión', detail: 'Baseline antes de publicar contenido.', done: false, group: 'Medición' },
  ];
  if (isLocal) {
    items.push({ step: 'Google Business Profile completo', detail: 'Categoría exacta, horarios, 20+ fotos, NAP idéntico al sitio.', done: false, group: 'Local' });
    items.push({ step: 'Bing Places / Apple Business Connect', detail: 'Cobertura de mapas alternativos a Google.', done: false, group: 'Local' });
  }
  return { origin, market, items };
}

function indexnowPayload(client, urls) {
  return JSON.stringify({
    host: safeOrigin(client.url).replace(/^https?:\/\//, ''),
    key: client.indexnowKey,
    keyLocation: safeOrigin(client.url) + '/' + client.indexnowKey + '.txt',
    urlList: urls.slice(0, 10000),
  });
}

module.exports = { robotsTxt, sitemapXml, indexingChecklist, indexnowPayload, safeOrigin };

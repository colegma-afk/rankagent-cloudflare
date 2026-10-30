'use strict';
/**
 * Auditoría SEO determinista: analiza HTML, robots, sitemap y señales GEO/AEO.
 * Sin dependencias de parser externo (regex tolerante + limpieza de texto).
 */

const { fetchResource } = require('./fetcher.cjs');

/* ---------------- helpers ---------------- */

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function collapse(s) {
  return decodeEntities(String(s || '').replace(/\s+/g, ' ')).trim();
}

function attrOf(tag, name) {
  const re = new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
  const m = String(tag || '').match(re);
  if (!m) return null;
  return m[2] != null ? m[2] : m[3] != null ? m[3] : m[4];
}

function getTags(html, tagName) {
  const re = new RegExp('<' + tagName + '\\b[^>]*>', 'gi');
  return String(html || '').match(re) || [];
}

function innerOf(html, tagName) {
  const re = new RegExp('<' + tagName + '\\b[^>]*>([\\s\\S]*?)</' + tagName + '>', 'gi');
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
}

function isAssetUrl(u) {
  return /\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|woff2?|ttf|mp4|webm|pdf|zip|xml\.gz)$/i.test(u);
}

/* ---------------- extracción de la página ---------------- */

function parseHtml(html, pageUrl) {
  const u = new URL(pageUrl);
  const text = collapse(stripTags(html));
  const words = text ? text.split(' ').filter(Boolean) : [];

  const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const title = collapse(titleTag);

  const metas = {};
  for (const tag of getTags(html, 'meta')) {
    const name = (attrOf(tag, 'name') || attrOf(tag, 'property') || '').toLowerCase();
    const content = attrOf(tag, 'content');
    if (name && content != null && !(name in metas)) metas[name] = content;
  }

  let canonical = null;
  for (const tag of getTags(html, 'link')) {
    if ((attrOf(tag, 'rel') || '').toLowerCase() === 'canonical') { canonical = attrOf(tag, 'href'); break; }
  }

  const hreflangs = [];
  for (const tag of getTags(html, 'link')) {
    const rel = (attrOf(tag, 'rel') || '').toLowerCase();
    const hl = attrOf(tag, 'hreflang');
    if (rel === 'alternate' && hl) hreflangs.push({ lang: hl, href: attrOf(tag, 'href') });
  }

  const htmlTag = (html.match(/<html\b[^>]*>/i) || [])[0] || '';
  const lang = attrOf(htmlTag, 'lang');

  const headings = { h1: [], h2: [], h3: [], h4: [], h5: [], h6: [] };
  for (const h of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    headings[h] = innerOf(html, h).map((x) => collapse(x)).filter(Boolean);
  }

  const imgs = getTags(html, 'img');
  const imgTotal = imgs.length;
  const imgNoAlt = imgs.filter((t) => {
    const alt = attrOf(t, 'alt');
    return alt == null || String(alt).trim() === '';
  }).length;

  const anchors = getTags(html, 'a').map((t) => ({ href: attrOf(t, 'href') || '', rel: (attrOf(t, 'rel') || '').toLowerCase() }));
  let internal = 0, external = 0, nofollowExt = 0;
  const internalUrls = new Set();
  for (const a of anchors) {
    const href = a.href.trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
    try {
      const abs = new URL(href, pageUrl);
      if (abs.origin === u.origin) {
        internal++;
        if (!isAssetUrl(abs.pathname)) internalUrls.add(abs.origin + abs.pathname);
      } else if (/^https?:$/.test(abs.protocol)) {
        external++;
        if (a.rel.includes('nofollow')) nofollowExt++;
      }
    } catch { /* href inválido */ }
  }

  const jsonld = [];
  const ldRe = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldRe.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const arr = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
      for (const node of arr) if (node && node['@type']) jsonld.push(String(node['@type']));
    } catch { jsonld.push('__invalid__'); }
  }

  const scripts = getTags(html, 'script').length;
  const stylesheets = getTags(html, 'link').filter((t) => (attrOf(t, 'rel') || '').toLowerCase().includes('stylesheet')).length;
  const hasViewport = !!metas['viewport'];
  const charset = !!(html.match(/<meta[^>]+charset\s*=/i)) || !!metas['charset'];
  const robotsMeta = (metas['robots'] || '').toLowerCase();
  const canonicalize = canonical ? (() => { try { return new URL(canonical, pageUrl).href; } catch { return canonical; } })() : null;

  const questions = [...headings.h2, ...headings.h3, ...headings.h4].filter((h) => /\?|^(cómo|que|qué|cuánto|cuándo|dónde|por qué|cuales|cuáles|ventajas|desventajas|es |son )/i.test(h));

  const statsMatches = text.match(/(\d+(\.\d+)?\s*%|\$\s?\d+|\d{2,}\s+(años|d[ií]as|clientes|proyectos|usuarios|empresas)|\b\d{1,3}\.\d{3}\b)/gi) || [];

  const contactSignals = /whatsapp|tel[eé]fono|\+56|contacto|agenda|cotizaci[oó]n/i.test(text);
  const trustSignals = /(t[eé]rminos|privacidad|pol[ií]tica|aviso legal|nosotros|equipo|acerca)/i.test(text) && (internalUrls.size > 0);
  const ctaSignals = /(cont[aá]ctanos|cotiza|agenda|comienza|solicita|llamanos|escr[ií]benos|reserva|comprar)/i.test(text);

  return {
    url: pageUrl,
    title,
    titleLength: title.length,
    metaDescription: collapse(metas['description'] || ''),
    metaDescLength: collapse(metas['description'] || '').length,
    robotsMeta,
    canonical: canonicalize,
    lang,
    viewport: hasViewport,
    charset,
    og: {
      title: collapse(metas['og:title'] || ''),
      description: collapse(metas['og:description'] || ''),
      image: metas['og:image'] || '',
    },
    twitterCard: metas['twitter:card'] || '',
    hreflangs,
    headings,
    h1Count: headings.h1.length,
    h1: headings.h1[0] || '',
    imgTotal,
    imgNoAlt,
    internalLinks: internal,
    externalLinks: external,
    nofollowExt,
    internalUrls: [...internalUrls],
    jsonldTypes: jsonld,
    scripts,
    stylesheets,
    wordCount: words.length,
    text,
    questions: questions.slice(0, 12),
    statCount: statsMatches.length,
    contactSignals,
    trustSignals,
    ctaSignals,
    wordList: words.map((w) => normalizeText(w)).filter(Boolean),
  };
}

function keywordStats(page, keywords) {
  return (keywords || []).map((kw) => {
    const n = normalizeText(kw);
    if (!n) return null;
    const phrase = page.text ? normalizeText(page.text).split(' ').filter(Boolean) : [];
    // ocurrencias de frase
    const occurrences = page.text ? (normalizeText(page.text).match(new RegExp(escapeRe(n), 'g')) || []).length : 0;
    const terms = n.split(' ').filter((w) => w.length > 3);
    const termHits = terms.filter((t) => page.wordList.includes(t)).length;
    const density = phrase.length ? ((occurrences * n.split(' ').length * 100) / phrase.length) : 0;
    return {
      keyword: kw,
      inTitle: normalizeText(page.title).includes(n),
      inH1: normalizeText(page.h1).includes(n),
      inDescription: normalizeText(page.metaDescription).includes(n),
      occurrences,
      coverage: terms.length ? Math.round((termHits / terms.length) * 100) : 0,
      density: Math.round(density * 100) / 100,
    };
  }).filter(Boolean);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ---------------- diagnóstico ---------------- */

function buildIssues(page, res, robots, sitemap, llms, keywordAnalysis) {
  const issues = [];
  const add = (area, severity, title, detail, fix) => issues.push({ area, severity, title, detail, fix, status: 'abierto' });

  if (!page) {
    add('tecnico', 'critico', 'No se pudo acceder a la página', res.error || `HTTP ${res.status}`, 'Verificar que la URL responda 200 y no bloquee bots (WAF/firewall).');
    return issues;
  }
  if (!/^https:/i.test(res.finalUrl)) add('tecnico', 'critico', 'Sin HTTPS', 'La página se sirve por HTTP.', 'Instalar certificado TLS y redirigir 301 http → https.');
  if (res.status >= 300 && res.status < 400) add('tecnico', 'medio', 'Redirección en la URL principal', `Status ${res.status}.`, 'Usar la URL canónica definitiva como principal.');
  if (!robots) add('tecnico', 'alto', 'robots.txt ausente o inaccesible', 'Los rastreadores no encuentran reglas ni sitemap.', 'Publicar /robots.txt con Allow: / y la línea Sitemap.');
  if (!sitemap || !sitemap.ok) add('tecnico', 'alto', 'sitemap.xml ausente o con error', 'No se detectó un sitemap válido.', 'Generar y publicar /sitemap.xml; declararlo en robots.txt.');
  if (!page.canonical) add('tecnico', 'alto', 'Sin etiqueta canonical', 'Riesgo de contenido duplicado.', 'Añadir <link rel="canonical"> apuntando a la URL preferida.');
  if (!page.viewport) add('tecnico', 'critico', 'Sin viewport responsive', 'Problema grave en móvil (mobile-first).', 'Añadir meta viewport width=device-width.');
  if (!page.charset) add('tecnico', 'medio', 'Sin charset declarado', 'Posibles problemas de acentos y renderizado.', 'Añadir <meta charset="utf-8"> en <head>.');
  if (/noindex/.test(page.robotsMeta)) add('tecnico', 'critico', 'Meta robots noindex', 'La página está bloqueada para los buscadores.', 'Eliminar noindex cuando el sitio esté listo para publicar.');
  if (!page.lang) add('tecnico', 'bajo', 'Sin atributo lang en <html>', 'Peor accesibilidad e interpretación de idioma.', `Declarar lang según mercado (ej. "es-cl").`);
  if (sitemap && sitemap.ok && sitemap.count === 0) add('tecnico', 'medio', 'Sitemap vacío', 'El sitemap no contiene URLs.', 'Regenerar el sitemap con las URLs publicadas.');

  if (!page.title) add('onpage', 'critico', 'Sin <title>', 'La página no tiene título de página.', 'Crear único title de 50–60 caracteres con keyword principal.');
  else {
    if (page.titleLength < 30) add('onpage', 'medio', 'Title demasiado corto', `${page.titleLength} caracteres.`, ' Ampliar a 50–60 caracteres con keyword + marca.');
    if (page.titleLength > 65) add('onpage', 'medio', 'Title demasiado largo', `${page.titleLength} caracteres; se cortará en SERP.`, 'Acortar a ≤60 caracteres.');
  }
  if (!page.metaDescription) add('onpage', 'alto', 'Sin meta description', 'Google generará la descripción al azar.', 'Escribir descripción única de 140–160 caracteres con CTA.');
  else if (page.metaDescLength < 70) add('onpage', 'bajo', 'Meta description muy corta', `${page.metaDescLength} caracteres.`, 'Ampliar a 140–160 caracteres.');
  else if (page.metaDescLength > 170) add('onpage', 'bajo', 'Meta description muy larga', `${page.metaDescLength} caracteres; se cortará.`, 'Recortar a ≤160 caracteres.');
  if (page.h1Count === 0) add('onpage', 'critico', 'Sin H1', 'No hay encabezado principal.', 'Añadir un H1 único con la keyword principal.');
  if (page.h1Count > 1) add('onpage', 'medio', `H1 múltiples (${page.h1Count})`, 'Diluye la señal temática.', 'Dejar un solo H1 y degradar los otros a H2.');
  if (page.wordCount < 300) add('contenido', 'alto', 'Contenido thin', `Solo ~${page.wordCount} palabras.`, 'Desarrollar contenido útil de 800–1500 palabras según intención.');
  if (page.imgTotal > 0 && page.imgNoAlt > 0) add('onpage', 'medio', `Imágenes sin alt (${page.imgNoAlt}/${page.imgTotal})`, 'Pérdida de accesibilidad y de imágenes en Google.', 'Describir cada imagen en alt relevante.');
  if (page.jsonldTypes.length === 0) add('contenido', 'alto', 'Sin datos estructurados (JSON-LD)', 'Sin rich results ni contexto para buscadores IA.', 'Añadir schema Organization/LocalBusiness + FAQPage.');
  if (page.jsonldTypes.includes('__invalid__')) add('contenido', 'medio', 'JSON-LD inválido', 'Un bloque de datos estructurados no es JSON válido.', 'Corregir el JSON-LD (comas, comillas).');
  if (!page.og.title) add('onpage', 'bajo', 'Sin Open Graph', 'Mal aspecto al compartir en redes/WhatsApp.', 'Añadir og:title, og:description, og:image.');
  if (!page.contactSignals) add('contenido', 'medio', 'Sin señales de contacto visibles', 'Reduce confianza y SEO local.', 'Incluir teléfono/WhatsApp y página de contacto.');
  if (!page.trustSignals) add('contenido', 'bajo', 'Faltan señales de confianza', 'Sin enlaces a privacidad/nosotros detectados.', 'Añadir sección Nosotros + políticas enlazadas en footer.');
  if (!page.ctaSignals) add('contenido', 'medio', 'Sin llamadas a la acción', 'Poca conversión desde búsqueda.', 'Añadir CTA claro (cotizar, agendar, comprar).');
  if (page.internalLinks < 5) add('onpage', 'medio', 'Pocos enlaces internos', `${page.internalLinks} enlaces internos.`, 'Enlazar a servicios, blog y contacto desde el contenido.');
  if (page.scripts > 40) add('ux', 'medio', `Muchos scripts (${page.scripts})`, 'Puede penalizar Core Web Vitals.', 'Diferir scripts no críticos (defer/async) y eliminar unused JS.');
  if (page.stylesheets > 10) add('ux', 'bajo', `Muchas hojas de estilo (${page.stylesheets})`, 'CSS blocking render.', 'Concatenar/minimizar CSS crítico.');
  if (res.bytes > 300000) add('ux', 'medio', `HTML pesado (${Math.round(res.bytes / 1024)} KB)`, 'Ralentiza el primer render.', 'Limpiar HTML generado, inlining excesivo o comentarios.');

  if (!llms) add('geo', 'medio', 'Sin llms.txt', 'Los modelos de lanza contexto limitado sobre tu sitio.', 'Publicar /llms.txt con mapa de contenido para IA.');
  if (page.questions.length === 0) add('geo', 'medio', 'Sin preguntas frecuentes en headings', 'Menos chances de aparecer en respuestas IA/AAE.', 'Incluir bloque FAQ con preguntas reales en H2/H3.');
  if (page.statCount === 0) add('geo', 'bajo', 'Sin datos/cifras citables', 'Los buscadores IA citan fuentes con datos.', 'Añadir estadísticas, precios o datos verificables con fuente.');
  const weak = keywordAnalysis.filter((k) => !k.inTitle || !k.inH1 || !k.inDescription);
  for (const k of weak.slice(0, 5)) {
    const missing = [!k.inTitle && 'title', !k.inH1 && 'H1', !k.inDescription && 'meta description'].filter(Boolean).join(', ');
    add('onpage', k.inTitle ? 'medio' : 'alto', `Keyword "${k.keyword}" ausente en ${missing}`, `Cobertura de términos: ${k.coverage}%.`, 'Incluir la keyword de forma natural en title, H1 y descripción.');
  }

  const order = { critico: 0, alto: 1, medio: 2, bajo: 3 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return issues.filter((i) => i.title);
}

/* ---------------- scoring ---------------- */

function computeScore(page, res, robots, sitemap, llms, keywordAnalysis, issues) {
  const cat = {
    tecnico: { got: 0, max: 25 },
    onpage: { got: 0, max: 30 },
    contenido: { got: 0, max: 15 },
    geo: { got: 0, max: 15 },
    ux: { got: 0, max: 15 },
  };
  const openIds = new Set(issues.map((i) => i.area + '|' + i.severity));

  if (page) {
    // técnico (25)
    if (/^https:/i.test(res.finalUrl)) cat.tecnico.got += 5;
    if (robots) cat.tecnico.got += 4;
    if (sitemap && sitemap.ok && sitemap.count > 0) cat.tecnico.got += 5;
    if (page.canonical) cat.tecnico.got += 4;
    if (page.viewport) cat.tecnico.got += 4;
    if (page.charset) cat.tecnico.got += 1.5;
    if (page.lang) cat.tecnico.got += 1.5;
    if (!/noindex/.test(page.robotsMeta)) cat.tecnico.got += 1;

    // on-page (30)
    if (page.title && page.titleLength >= 30 && page.titleLength <= 65) cat.onpage.got += 7;
    else if (page.title) cat.onpage.got += 4;
    if (page.metaDescription && page.metaDescLength >= 70 && page.metaDescLength <= 170) cat.onpage.got += 6;
    else if (page.metaDescription) cat.onpage.got += 3;
    if (page.h1Count === 1) cat.onpage.got += 6;
    else if (page.h1Count > 1) cat.onpage.got += 3;
    if ((page.headings.h2 || []).length >= 2) cat.onpage.got += 3;
    if (page.imgTotal === 0 || page.imgNoAlt / page.imgTotal <= 0.2) cat.onpage.got += 3;
    else if (page.imgNoAlt / page.imgTotal <= 0.5) cat.onpage.got += 1.5;
    if (page.internalLinks >= 10) cat.onpage.got += 3;
    else if (page.internalLinks >= 5) cat.onpage.got += 2;
    const kwInCore = keywordAnalysis.length
      ? keywordAnalysis.reduce((s, k) => s + (k.inTitle ? 1 : 0) + (k.inH1 ? 1 : 0) + (k.inDescription ? 1 : 0), 0) / (keywordAnalysis.length * 3)
      : 0;
    cat.onpage.got += Math.round(kwInCore * 2);

    // contenido (15)
    if (page.wordCount >= 900) cat.contenido.got += 7;
    else if (page.wordCount >= 500) cat.contenido.got += 5;
    else if (page.wordCount >= 300) cat.contenido.got += 3;
    if (page.jsonldTypes.length > 0) cat.contenido.got += 4;
    if (page.contactSignals) cat.contenido.got += 2;
    if (page.trustSignals) cat.contenido.got += 1;
    if (page.ctaSignals) cat.contenido.got += 1;

    // geo (15)
    if (llms) cat.geo.got += 3;
    if (page.jsonldTypes.some((t) => /FAQPage|HowTo|Article|Product/i.test(t))) cat.geo.got += 3;
    if (page.questions.length > 0) cat.geo.got += 3;
    if (page.statCount > 0) cat.geo.got += 2;
    if (page.og.title && page.og.image) cat.geo.got += 2;
    if (page.title && page.h1) cat.geo.got += 2;

    // ux (15)
    if (res.bytes <= 120000) cat.ux.got += 5;
    else if (res.bytes <= 300000) cat.ux.got += 3;
    if (page.scripts <= 25) cat.ux.got += 4;
    else if (page.scripts <= 40) cat.ux.got += 2;
    if (page.stylesheets <= 8) cat.ux.got += 3;
    else if (page.stylesheets <= 15) cat.ux.got += 1.5;
    if (res.timeMs <= 800) cat.ux.got += 3;
    else if (res.timeMs <= 2000) cat.ux.got += 2;
    else if (res.timeMs <= 4000) cat.ux.got += 1;
  }

  for (const k of Object.keys(cat)) cat[k].got = Math.min(cat[k].max, Math.round(cat[k].got * 10) / 10);
  const total = Math.round(Object.values(cat).reduce((s, c) => s + c.got, 0));
  const grade = total >= 90 ? 'A' : total >= 75 ? 'B' : total >= 60 ? 'C' : total >= 45 ? 'D' : 'E';
  const open = issues.length;
  const criticals = issues.filter((i) => i.severity === 'critico').length;
  return { total, grade, categories: cat, open, criticals, openIds: [...openIds] };
}

/* ---------------- crawl de URLs (profundidad 1) ---------------- */

async function crawlUrls(baseUrl, internalUrls, limit = 10) {
  const targets = internalUrls.filter((u) => {
    try { const x = new URL(u); return x.origin === new URL(baseUrl).origin; } catch { return false; }
  }).slice(0, limit);
  const results = [];
  const queue = [...targets];
  const workers = Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const url = queue.shift();
      const res = await fetchResource(url, { timeout: 9000 });
      if (res.ok) {
        const page = parseHtml(res.body, res.finalUrl || url);
        results.push({
          url,
          status: res.status,
          title: page.title.slice(0, 80),
          titleLength: page.titleLength,
          metaDescription: page.metaDescription.slice(0, 100),
          h1: page.h1.slice(0, 80),
          words: page.wordCount,
          hasSchema: page.jsonldTypes.length > 0,
        });
      } else {
        results.push({ url, status: res.status || 0, title: '', titleLength: 0, metaDescription: '', h1: '', words: 0, hasSchema: false, error: res.error });
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/* ---------------- orquestador de auditoría ---------------- */

async function auditSite(client, log = () => {}) {
  const url = client.url;
  const out = { homepage: null, fetch: null, robots: null, sitemap: null, llms: null, keywordAnalysis: [], issues: [], score: null, crawled: [] };

  log('info', `Descargando ${url} …`);
  const res = await fetchResource(url, { timeout: 15000 });
  out.fetch = { status: res.status, timeMs: res.timeMs, bytes: res.bytes, finalUrl: res.finalUrl, error: res.error };
  if (res.ok) {
    out.homepage = parseHtml(res.body, res.finalUrl || url);
    log(res.status === 200 ? 'ok' : 'warn', `HTTP ${res.status} · ${res.bytes} bytes · ${res.timeMs} ms · ${out.homepage.wordCount} palabras`);
  } else {
    log('err', `No se pudo descargar la página: ${res.error || 'HTTP ' + res.status}`);
  }

  const origin = (() => { try { return new URL(url).origin; } catch { return null; } })();
  if (origin) {
    const [rb, sm, ll] = await Promise.all([
      fetchResource(origin + '/robots.txt', { timeout: 9000 }),
      fetchResource(origin + '/sitemap.xml', { timeout: 9000 }),
      fetchResource(origin + '/llms.txt', { timeout: 9000 }),
    ]);

    out.robots = rb.ok && rb.body.trim()
      ? { ok: true, text: rb.body.slice(0, 4000), sitemapDeclared: (rb.body.match(/^Sitemap:\s*(.+)$/gim) || []).map((s) => s.split(':').slice(1).join(':').trim()) }
      : { ok: false, error: rb.error || `HTTP ${rb.status}` };
    log(out.robots.ok ? 'ok' : 'warn', out.robots.ok ? `robots.txt OK · sitemaps declarados: ${out.robots.sitemapDeclared.length || 0}` : 'robots.txt no encontrado o vacío');

    if (sm.ok) {
      const urls = (sm.body.match(/<loc>\s*([^<\s]+)\s*<\/loc>/g) || []).length;
      out.sitemap = { ok: true, count: urls, bytes: sm.bytes };
      log('ok', `sitemap.xml OK · ${urls} URLs`);
    } else {
      out.sitemap = { ok: false, error: sm.error || `HTTP ${sm.status}` };
      log('warn', 'sitemap.xml no encontrado en la raíz');
    }

    out.llms = ll.ok && ll.body.trim().length > 20 ? { ok: true, bytes: ll.bytes } : { ok: false };
    log(out.llms.ok ? 'ok' : 'info', out.llms.ok ? 'llms.txt presente (buena señal GEO)' : 'llms.txt ausente (oportunidad GEO)');
  }

  if (out.homepage) {
    out.keywordAnalysis = keywordStats(out.homepage, client.keywords);
    const kwHit = out.keywordAnalysis.filter((k) => k.inTitle || k.inH1).length;
    log(kwHit > 0 ? 'ok' : 'info', `Keywords detectadas en title/H1: ${kwHit}/${out.keywordAnalysis.length || 0}`);
    log('info', `Señales: ${out.homepage.jsonldTypes.length} schema(s), ${out.homepage.questions.length} preguntas, ${out.homepage.statCount} cifras, ${out.homepage.internalLinks} enlaces internos`);

    log('info', 'Rastreando enlaces internos para el mapa de sitio …');
    out.crawled = await crawlUrls(url, out.homepage.internalUrls, 10);
    const good = out.crawled.filter((c) => c.status === 200).length;
    log('ok', `Crawl: ${out.crawled.length} URLs visitadas · ${good} responden 200`);
  }

  out.issues = buildIssues(out.homepage, res, out.robots && out.robots.ok ? out.robots : null, out.sitemap, out.llms && out.llms.ok ? out.llms : null, out.keywordAnalysis);
  out.score = computeScore(out.homepage, res, out.robots && out.robots.ok ? out.robots : null, out.sitemap, out.llms && out.llms.ok ? out.llms : null, out.keywordAnalysis, out.issues);
  log(out.score.criticals > 0 ? 'warn' : 'ok', `Score SEO: ${out.score.total}/100 (grado ${out.score.grade}) · ${out.score.criticals} críticos, ${out.score.open} hallazgos`);
  return out;
}

module.exports = { auditSite, parseHtml, buildIssues, computeScore, keywordStats, crawlUrls, slugify, normalizeText, stripTags, collapse, decodeEntities };

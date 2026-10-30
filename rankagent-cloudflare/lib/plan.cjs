'use strict';
/**
 * Generadores deterministas de estrategia 90 días y briefs de contenido.
 * Todo en español, parametrizado por rubro, mercado y keywords del cliente.
 */
const { slugify, normalizeText } = require('./audit.cjs');

const MARKETS = {
  'es-CL': { label: 'Chile', serp: 'Google Chile', prep: 'en Chile', local: 'en tu ciudad', lang: 'es-CL' },
  'es': { label: 'LatAm', serp: 'Google Hispanoamérica', prep: 'en Latinoamérica', local: 'en tu zona', lang: 'es' },
  'es-MX': { label: 'México', serp: 'Google México', prep: 'en México', local: 'en tu ciudad', lang: 'es-MX' },
  'es-AR': { label: 'Argentina', serp: 'Google Argentina', prep: 'en Argentina', local: 'en tu ciudad', lang: 'es-AR' },
  'es-PE': { label: 'Perú', serp: 'Google Perú', prep: 'en Perú', local: 'en tu ciudad', lang: 'es-PE' },
  'es-CO': { label: 'Colombia', serp: 'Google Colombia', prep: 'en Colombia', local: 'en tu ciudad', lang: 'es-CO' },
  'en': { label: 'Global', serp: 'Google US', prep: 'worldwide', local: 'near me', lang: 'en' },
  'en-US': { label: 'USA', serp: 'Google US', prep: 'in the US', local: 'near me', lang: 'en-US' },
};

function marketInfo(market) {
  return MARKETS[market] || MARKETS['es-CL'];
}

function classifyIntent(kw) {
  const k = normalizeText(kw);
  if (/(cerca|donde|ubicacion|direccion|horario|mapa)/.test(k)) return 'local';
  if (/(comprar|precio|precios|cotizar|contratar|servicio|servicios|tarifa|costo|cuanto cuesta|mejores|top|agenda|reserva|alquiler|empresa|proveedor)/.test(k)) return 'transaccional';
  if (/(vs|versus|comparar|alternativas|opiniones|review)/.test(k)) return 'comparacion';
  if (/(como|que|cual|cuales|cuando|por que|guia|guía|tutorial|tips|ejemplo|definicion|significa|ventajas|beneficios|diferencia)/.test(k)) return 'informacional';
  return 'informacional';
}

const INTENT_META = {
  informacional: { label: 'Informacional', schema: 'Article + FAQPage', funnel: 'TOFU' },
  transaccional: { label: 'Transaccional', schema: 'Service/Product + FAQPage', funnel: 'BOFU' },
  local: { label: 'Local', schema: 'LocalBusiness + FAQPage', funnel: 'BOFU local' },
  comparacion: { label: 'Comparación', schema: 'Article + ItemList', funnel: 'MOFU' },
};

function longTails(base, info) {
  const b = base.trim();
  return [
    `mejores ${b} ${info.prep}`,
    `cuánto cuesta ${b}`,
    `cómo elegir ${b}`,
    `${b} ${info.local}`,
    `${b} para pymes`,
    `${b} opiniones`,
    `${b} paso a paso`,
    `${b} precios y opciones`,
  ];
}

function buildKeywordPlan(client) {
  const info = marketInfo(client.market);
  const seeds = (client.keywords && client.keywords.length ? client.keywords : [client.niche || client.name])
    .slice(0, 6);
  const rows = [];
  const seen = new Set();
  const push = (kw, prio) => {
    const key = normalizeText(kw);
    if (!key || seen.has(key)) return;
    seen.add(key);
    rows.push({ keyword: kw.trim(), intent: classifyIntent(kw), priority: prio });
  };

  seeds.forEach((s, i) => push(s, i < 2 ? 'P1' : 'P2'));
  // expansiones semánticas (a validar en Keyword Planner / GSC)
  seeds.slice(0, 3).forEach((s) => longTails(s, info).slice(0, 4).forEach((t) => push(t, 'P2')));
  seeds.slice(0, 1).forEach((s) => longTails(s, info).slice(4, 8).forEach((t) => push(t, 'P3')));

  return rows.slice(0, 18).map((r) => ({
    ...r,
    volumeNote: 'sin datos (validar en GSC/Keyword Planner)',
    contentType: INTENT_META[r.intent].label === 'Local'
      ? 'Landing local + GBP'
      : r.intent === 'transaccional'
        ? 'Landing de servicio/producto'
        : r.intent === 'comparacion'
          ? 'Artículo comparativo'
          : 'Artículo de blog (cluster pilar)',
  }));
}

function outlineFor(intent, kw, info) {
  const common = [{ h2: 'Preguntas frecuentes', bullets: ['3–6 preguntas reales en formato H3', 'Respuesta directa de 40–60 palabras bajo cada pregunta'] }];
  if (intent === 'transaccional') {
    return [
      { h2: `${kw[0].toUpperCase()}${kw.slice(1)}: qué incluye`, bullets: ['Beneficios concretos en viñetas', 'Para quién es / para quién no es'] },
      { h2: 'Precios y formas de pago', bullets: ['Tabla de planes o rangos', 'Qué afecta el precio (factores)'] },
      { h2: 'Cómo contratar (3 pasos)', bullets: ['Pasos numerados con tiempos estimados', 'Sin fricción: WhatsApp/ formulario'] },
      { h2: 'Casos de éxito o testimonios', bullets: ['1–2 casos con métricas antes/después', 'Nombre, empresa y foto si es posible'] },
      ...common,
    ];
  }
  if (intent === 'local') {
    return [
      { h2: `${kw} ${info.local}: información clave`, bullets: ['Dirección, horario y forma de llegada', 'Cobertura por sector/comuna'] },
      { h2: 'Qué diferencia este servicio en la zona', bullets: ['2–3 diferenciadores verificables', 'Experiencia y equipo'] },
      { h2: 'Reseñas y reputación', bullets: ['Resumen de reseñas (Google/otros)', 'Pedir reseñas a clientes reales'] },
      ...common,
    ];
  }
  if (intent === 'comparacion') {
    return [
      { h2: 'Resumen ejecutivo (respuesta directa)', bullets: ['Ganador y por qué, en 2–3 líneas', 'Tabla comparativa rápida'] },
      { h2: 'Criterios de comparación', bullets: ['Precio, calidad, soporte, plazos, garantía'] },
      { h2: 'Comparativa detallada', bullets: ['Tabla Markdown/HTML con 5–7 filas', 'Enlaces a fuentes primarias'] },
      { h2: '¿Cuál elegir según tu caso?', bullets: ['Escenarios: presupuesto bajo / crecimiento / enterprise'] },
      ...common,
    ];
  }
  return [
    { h2: `Qué es ${kw} y por qué importa ahora`, bullets: ['Definición en el primer párrafo (respuesta directa)', 'Dato o tendencia con fuente citable'] },
    { h2: 'Cómo funciona, paso a paso', bullets: ['4–6 pasos numerados', 'Errores comunes al empezar'] },
      { h2: 'Ventajas y casos de uso reales', bullets: ['Beneficios con evidencia concreta', 'Ejemplo aplicado a un caso real del rubro'] },
    { h2: 'Cuánto cuesta / qué esperar', bullets: ['Rangos de precio o esfuerzo', 'Variables que lo cambian'] },
    ...common,
  ];
}

function buildBrief(client, row, index) {
  const info = marketInfo(client.market);
  const kw = row.keyword;
  const brand = client.name;
  const cap = kw.charAt(0).toUpperCase() + kw.slice(1);

  const title = row.intent === 'transaccional'
    ? `${cap} ${info.prep} | ${brand}`.slice(0, 60)
    : `${cap}: guía ${info.prep} (2026)`.slice(0, 60);
  const meta = row.intent === 'transaccional'
    ? `${cap} con garantía y atención personalizada. Cotiza hoy con ${brand}: respuesta en menos de 24 h. Pide tu presupuesto.`.slice(0, 155)
    : `Todo sobre ${kw}: definición, pasos, precios y preguntas frecuentes. Guía práctica actualizada ${info.prep} por ${brand}.`.slice(0, 155);

  const outline = outlineFor(row.intent, kw, info);
  // arreglar bullet residual con función si quedó
  const cleanOutline = outline.map((sec) => ({
    h2: sec.h2,
    bullets: sec.bullets.map((b) => (typeof b === 'string' ? b : 'Beneficios con evidencia')),
  }));

  const questions = row.intent === 'transaccional'
    ? [`¿Cuánto cuesta ${kw}?`, `¿Qué incluye ${kw}?`, `¿Cuánto demora contratar?`, `¿Hay garantía o devolución?`]
    : [`¿Qué es ${kw}?`, `¿Cómo se hace ${kw}?`, `¿Cuáles son las ventajas?`, `¿Cuánto cuesta ${kw}?`];

  return {
    order: index + 1,
    keyword: kw,
    priority: row.priority,
    intent: row.intent,
    intentLabel: INTENT_META[row.intent].label,
    funnel: INTENT_META[row.intent].funnel,
    title,
    titleLength: title.length,
    meta,
    metaLength: meta.length,
    slug: '/' + slugify(kw),
    h1: cap,
    wordTarget: row.intent === 'informacional' ? '1200–1800' : '700–1200',
    outline: cleanOutline,
    questions,
    schema: INTENT_META[row.intent].schema,
    internalLinks: `Enlazar desde/ hacia: inicio, ${client.niche || 'servicios'}, casos, contacto${row.intent === 'local' ? ', ficha de Google Business Profile' : ''}`,
    cta: row.intent === 'informacional' ? 'CTA contextual al final + bloque intermedio' : 'CTA primario (cotizar/agendar/whatsapp) sobre la línea de flotación',
    publishBy: `Semana ${Math.min(12, 3 + index * 2)}`,
  };
}

function buildStrategy(client, audit) {
  const info = marketInfo(client.market);
  const score = audit.score;
  const kwPlan = buildKeywordPlan(client);
  const isLocal = client.type === 'local';

  const phase1Tasks = [];
  const crit = (audit.issues || []).filter((i) => i.severity === 'critico' || i.severity === 'alto').slice(0, 6);
  for (const i of crit) phase1Tasks.push({ task: i.title, why: i.detail, fix: i.fix, src: 'auditoría en vivo' });
  if (!phase1Tasks.length) phase1Tasks.push({ task: 'Mantener fundamento técnico', why: 'No se detectaron fallos críticos.', fix: 'Monitoreo semanal con el agente.', src: 'auditoría en vivo' });
  phase1Tasks.push({ task: 'Google Search Console + Bing Webmaster + Analytics', why: 'Sin datos no hay mejora medible.', fix: 'Verificar dominio, enviar sitemap, activar informes.', src: 'checklist estándar' });
  phase1Tasks.push({ task: 'Reescribir title y meta description de la home', why: 'Principal palanca de CTR orgánico.', fix: `Incluir keyword primaria + ${brandTag(client)} dentro de 60/155 caracteres.`, src: 'on-page' });

  const phase2Tasks = kwPlan.filter((k) => k.priority !== 'P3').slice(0, 6).map((k) => ({
    task: `Publicar contenido: "${k.keyword}" (${k.contentType})`,
    why: `Intención ${INTENT_META[k.intent].label.toLowerCase()} · ${k.funnel}`,
    fix: `Seguir brief con slug ${slugify(k.keyword)}.`,
    src: 'plan de contenido',
  }));
  phase2Tasks.push({ task: 'Arquitectura de enlaces internos', why: 'Distribuir autoridad entre pilar ↔ clusters.', fix: 'Cada artículo nuevo enlaza al pilar y a 2 hermanos; el pilar enlaza a todos.', src: 'on-page' });
  phase2Tasks.push({ task: 'Datos estructurados completos', why: 'Rich results y contexto para IA.', fix: 'Organization/LocalBusiness + FAQPage + Article en cada publicación.', src: 'E-E-A-T' });

  const phase3Tasks = [
    { task: isLocal ? 'Google Business Profile optimizado + reseñas' : 'Autoridad: menciones y backlinks de calidad', why: isLocal ? 'Empaque local (mapa) es el mayor canal de captación local.' : 'Los enlaces siguen siendo el principal factor de ranking.', fix: isLocal ? 'Categoría exacta, 20+ fotos, pedir reseña en cada cierre, NAP consistente.' : 'Directorios del sector, colaboraciones, notas de prensa local/sectorial, link exchanges temáticos (evitar granjas).', src: 'off-page' },
    { task: 'Optimización GEO/AEO para buscadores IA', why: `Aparecer en ChatGPT, Perplexity, Gemini y AI Overviews de ${info.label}.`, fix: 'Publicar llms.txt, respuestas directas de 40–60 palabras, datos citables y presencia en directorios/entidades.', src: 'GEO' },
    { task: 'Entidad de marca y E-E-A-T', why: 'Los motores de IA citan entidades reconocibles.', fix: 'Página Nosotros con autoría real, perfiles sociales vinculados, menciones de marca consistentes NAP.', src: 'E-E-A-T' },
    { task: 'Refresh de contenido + medición', why: 'El contenido envejece; el tráfico, no.', fix: 'Revisar posiciones quincenales con GSC; actualizar top-10 posts cada trimestre.', src: 'operación' },
  ];

  const kpis = [
    { kpi: 'Impresiones orgánicas (GSC)', meta: '+40% en 90 días', cadence: 'semanal' },
    { kpi: 'Posición media keyword P1', meta: 'Top 10 en 90 días', cadencia: 'semanal' },
    { kpi: 'Páginas indexadas / sitemap', meta: '100% de URLs publicadas', cadencia: 'quincenal' },
    { kpi: 'CTR orgánico', meta: '≥ 3% en brand, ≥ 1,5% en no-brand', cadencia: 'mensual' },
    { kpi: 'Conversiones orgánicas (leads/ventas)', meta: 'línea base +25%', cadencia: 'mensual' },
    { kpi: 'Menciones en buscadores IA', meta: 'aparecer en 3/5 prompts de prueba', cadence: 'mensual' },
    { kpi: 'Score del agente', meta: `de ${score ? score.total : 0} a ≥80`, cadencia: 'por ejecución' },
  ];

  const keywordsHighIntent = kwPlan.filter((k) => k.priority === 'P1');

  const summary = `La web de ${client.name} (${info.serp}) cierra con un score de ${score ? score.total : 0}/100 (grado ${score ? score.grade : '–'}), con ${score ? score.criticals : 0} problemas críticos y ${score ? score.open : 0} hallazgos abiertos. La prioridad inmediata es ${crit.length ? `resolver los ${crit.length} fallos de impacto alto: ${crit.slice(0, 3).map((c) => c.title.toLowerCase()).join('; ')}` : 'consolidar el fundamento técnico ya sólido'}. El crecimiento orgánico se juega en ${keywordsHighIntent.length ? keywordsHighIntent.length + ' keywords de alta intención (' + keywordsHighIntent.map((k) => k.keyword).slice(0, 3).join(', ') + ')' : 'la expansión del mapa de keywords'} + una cadencia de 1–2 publicaciones/semana, más la capa GEO para capturar menciones en ChatGPT, Perplexity y AI Overviews.`;

  return {
    market: info,
    executiveSummary: summary,
    phases: [
      { name: 'Fase 1 · Cimientos (Semanas 1–2)', goal: 'Indexabilidad y base técnica', tasks: phase1Tasks },
      { name: 'Fase 2 · Contenido y on-page (Semanas 3–6)', goal: 'Capturar intención de búsqueda', tasks: phase2Tasks },
      { name: 'Fase 3 · Autoridad, GEO y medición (Semanas 7–12)', goal: 'Rankings estables + visibilidad en IA', tasks: phase3Tasks },
    ],
    keywordPlan: kwPlan,
    kpis,
    contentCadence: '1–2 artículos/semana (P1 primero), 1 landing de servicio optimizada, refresh quincenal de top posts.',
    quickWins: (audit.issues || [])
      .filter((i) => i.severity === 'critico' || i.severity === 'alto')
      .slice(0, 5)
      .map((i) => ({ title: i.title, fix: i.fix })),
  };
}

function brandTag(client) {
  return client.name && client.name.length <= 24 ? client.name : 'marca';
}

function buildContentPlan(client, strategy) {
  return strategy.keywordPlan
    .filter((k) => k.priority !== 'P3')
    .slice(0, 6)
    .map((row, i) => buildBrief(client, row, i));
}

module.exports = { buildStrategy, buildContentPlan, buildKeywordPlan, classifyIntent, marketInfo, MARKETS };

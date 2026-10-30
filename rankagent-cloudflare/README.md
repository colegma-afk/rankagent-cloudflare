# RankAgent Cloudflare — Agente IA de SEO con usuarios y base de datos

> 📦 **¿Desplegar?** Sigue **`DESPLIEGUE.md`** — incluye la ruta **sin instalar nada** (GitHub + panel de Cloudflare, solo navegador).

Aplicación web completa lista para desplegar en **Cloudflare Workers** con **D1 (SQLite)**:

- **Usuarios**: cuenta *administradora de la agencia* + usuarios *cliente* (cada uno ve solo su cliente asignado, con informe completo y re-ejecución del agente).
- **Agente autónomo**: auditoría en vivo (10 pasos), estrategia 90 días, briefs de contenido, plan GEO/AEO para buscadores IA e indexación (`sitemap.xml`, `robots.txt`, `llms.txt`, IndexNow, checklist GSC/Bing).
- **Base de datos D1**: usuarios, sesiones, clientes, corridas y ajustes.
- **Cron** (`*/15 * * * *`): re-check autónomo + recuperación de corridas interrumpidas.
- **Zero dependencias de producción** (solo `wrangler` como herramienta de desarrollo).

---

## Despliegue en Cloudflare (recomendado: wrangler)

**Requisitos:** cuenta Cloudflare (free sirve) y Node.js ≥ 18.

```bash
# 1. Descomprimir y entrar a la carpeta
unzip RankAgent-cloudflare.zip && cd rankagent-cloudflare

# 2. Instalar la herramienta de despliegue (solo wrangler)
npm install

# 3. Login de Cloudflare (abre el navegador)
npx wrangler login

# 4. Automático: crea la base D1, escribe el database_id en wrangler.toml y crea las tablas
npm run setup

# 5. Desplegar
npm run deploy
#   ▸ Te entrega la URL: https://rankagent.<tu-cuenta>.workers.dev
```

> `npm run setup` hace todo el trabajo manual de antes (crear D1, copiar el id, ejecutar `schema.sql`). Si prefieres hacerlo a mano: `npm run db:create` → pega el id en `wrangler.toml` → `npm run db:init:remote`.

**Primer uso (en la URL desplegada):**

1. Se muestra **Configuración inicial** → crea la cuenta *admin* de la agencia (email + contraseña).
2. **Clientes → ＋ Nuevo cliente** (URL, rubro, keywords) → el agente corre automáticamente y genera el informe.
3. **Usuarios → ＋ Nuevo usuario** → rol *Cliente* + cliente asignado → esa persona ingresa con su email y ve solo su informe.

> El `database_id` solo se configura una vez; las actualizaciones futuras son `npm run deploy` tras guardar cambios.

## Desarrollo local

```bash
npm install
npm run db:init:local     # crea las tablas en la D1 local (.wrangler/state)
npm run dev               # http://localhost:8787
```

Notas locales:

- El endpoint `http://localhost:8787/cdn-cgi/handler/scheduled` puede responder `exception` con `[assets]` (limitación del entorno local de wrangler); **en producción el cron se dispara por el edge normalmente**. Para probar la lógica del cron en local usa `POST /api/admin/run-cron` (o el botón «Ejecutar cron ahora» en Ajustes, sesión admin).
- El estado local (usuarios de prueba, corridas) vive en `.wrangler/` y no se incluye en ningún ZIP de despliegue.

## Estructura

```
├── wrangler.toml        # Worker + assets + D1 + cron
├── schema.sql           # esquema D1 (users, sessions, clients, runs, settings)
├── src/
│   ├── worker.js        # entrada: /api → API, resto → assets estáticos, scheduled()
│   ├── api.js           # rutas REST + control de roles (admin | cliente)
│   ├── auth.js          # PBKDF2 (WebCrypto), sesiones con cookie HttpOnly
│   ├── runner.js        # ejecución con streaming SSE + cron
│   └── store.cjs        # repositorio D1 (misma API que la versión Node)
├── lib/                 # motor del agente (auditoría, estrategia, GEO, indexación, informe)
├── public/              # SPA (login, setup, panel, clientes, agente, usuarios, ajustes)
└── test/ui-smoke.js     # smoke de UI con jsdom (requiere el dev server corriendo)
```

## API y seguridad

- Sesiones: cookie `ra_sess` (HttpOnly, SameSite=Lax, Secure en HTTPS) con token aleatorio de 192 bits en D1.
- Contraseñas: **PBKDF2-SHA256, 100.000 iteraciones** (WebCrypto), verificación en tiempo constante.
- Roles: `admin` (todo) · `cliente` (solo su cliente: lectura, informes y re-ejecución; 403 en settings/usuarios/CRUD).
- Rate-limit de login (15 intentos / 15 min) y de setup.
- El agente hace streaming de eventos (`event: log|steps|done`) en el cuerpo del `POST /api/clients/:id/run`; la UI hace *polling* de respaldo si se corta la conexión.

## Límites (plan free de Cloudflare, suficiente para pymes)

- Workers: 100.000 solicitudes/día · D1: 5 GB, 100.000 lecturas/día y 100.000 escrituras/día.
- Cada corrida del agente escribe ~12 veces en D1 y lee el resultado varias veces — holgado para decenas de clientes con re-check diario.

## Configuración opcional

- **Ajustes → LLM**: conectar un endpoint compatible con OpenAI (`baseUrl` + `apiKey` + `model`) para que el agente redacte el resumen ejecutivo con tu modelo; sin LLM usa el motor determinista integrado.
- **Modo autónomo / re-check (horas)**: comportamiento del agente al crear clientes y frecuencia del cron.

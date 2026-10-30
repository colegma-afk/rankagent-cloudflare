# 📦 Guía de despliegue completa — RankAgent

Hay dos caminos. **Elige el A si NO tienes Node.js** (todo desde el navegador) o el B si ya lo tienes.

---

## RUTA A — Sin instalar nada (solo navegador) ✅ recomendada si no tienes Node.js

**Necesitas 2 cuentas gratuitas:** [Cloudflare](https://dash.cloudflare.com/sign-up) y [GitHub](https://github.com/signup).

### Paso 1 — Subir el código a GitHub

1. Entra a **github.com** → sesión → botón **＋** (arriba a la derecha) → **New repository**.
2. Nombre: `rankagent-cloudflare` → **Create repository** (público o privado, da igual).
3. En la página del repo vacío haz clic en **"uploading an existing file"** (o **Add file → Upload files**).
4. Abre en tu computador la carpeta descomprimida, entra a `rankagent-cloudflare/`,
   selecciona **TODO** dentro (Ctrl+A / Cmd+A) y **arrastra los archivos** al navegador.
   > ⚠️ Arrastra el **contenido** de la carpeta (package.json, src, public…), no la carpeta en sí,
   > para que `wrangler.toml` quede en la raíz del repositorio.
5. Espera a que suban → **Commit changes**.

### Paso 2 — Crear la base de datos en Cloudflare (panel web)

1. **dash.cloudflare.com** → menú izquierdo → **Workers & Pages** → pestaña **D1** (o "SQL & Databases → D1") → **Create database**.
2. Nombre: `rankagent` → **Create**.
3. Entra a la base → pestaña **Settings / Data** → copia el valor de **`database_id`**
   (algo como `a1b2c3d4-1111-2222-3333-444455556666`).

### Paso 3 — Pegar el ID en `wrangler.toml` (desde GitHub)

1. En tu repo → clic en **`wrangler.toml`** → icono ✏️ (**Edit**).
2. Reemplaza exactamente `PEGA_AQUI_TU_DATABASE_ID` por el ID copiado (sin comillas nuevas, se queda entre las comillas).
3. **Commit changes**.

### Paso 4 — Importar y desplegar el repo en Cloudflare

1. En Cloudflare: **Workers & Pages** → **Create** → pestaña **Import a repository** → **Get started**.
2. Conecta tu cuenta de GitHub (Authorize) → elige `rankagent-cloudflare` → **Begin setup**.
3. La configuración de build se **auto-detecta** (ve `wrangler.toml`): déjala tal cual y pulsa **Deploy**.
4. Espera el verde **Success** → te entrega tu URL:
   `https://rankagent.<tu-usuario>.workers.dev`

> Si en algún momento haces cambios y vuelves a subirlos a GitHub, Cloudflare **redespliega solo**.

### Paso 5 — Crear las tablas (SQL desde el navegador)

1. En GitHub abre **`schema.sql`** → botón **Copy raw file** (copia todo el SQL).
2. En Cloudflare: **D1** → `rankagent` → pestaña **Console** → pega → **Execute**.
3. Verás las 5 tablas creadas (`users`, `sessions`, `clients`, `runs`, `settings`).

### Paso 6 — Abrir la app y crear la cuenta admin

1. Abre tu URL → aparece **Configuración inicial** → nombre, email y contraseña → **Crear cuenta admin**.
2. **Clientes → ＋ Nuevo cliente** (URL, rubro, keywords) → el agente corre y genera el informe.
3. **Usuarios → ＋ Nuevo usuario** → rol *Cliente* + cliente asignado → esa persona entra con su email
   y ve **solo** su informe.

### ✅ Lista de verificación final

- [ ] La URL abre la pantalla de acceso / configuración.
- [ ] En D1 → *Tables* aparecen las 5 tablas.
- [ ] `wrangler.toml` ya **no** contiene `PEGA_AQUI_TU_DATABASE_ID`.
- [ ] Una corrida de prueba del agente devuelve un score (ej. 35/100).
- [ ] Los usuarios *cliente* no ven Ajustes ni Usuarios (les da 403).

### ❗ Errores frecuentes y solución

| Error | Causa y arreglo |
|---|---|
| `database_id` inválido / placeholder en el build | Paso 3 incompleto → editar `wrangler.toml`, guardar; el push dispara un redespliegue solo. |
| Build falla pidiendo login de Cloudflare | Conecta la cuenta en Workers (*Get started* → Connect). Es un enlace de una vez. |
| La app carga pero falla al crear clientes | Falta el SQL → repite Paso 5 en la consola D1. |
| Subiste la carpeta y `wrangler.toml` no está en la raíz | En GitHub: mueve los archivos a la raíz (o vuelve a subir el contenido de la carpeta). |
| Puerto/confusión con otra app | Cada Worker tiene su propia URL; no hay nada que configurar. |

---

## RUTA B — Con Node.js (5 comandos en la terminal)

```bash
npm install
npx wrangler login
npm run setup     # crea la D1, escribe el ID y crea las tablas (todo automático)
npm run deploy    # publica y entrega la URL
```

Después: mismo **Paso 6** de la Ruta A.

---

## Datos de la app

- **Modo autónomo**: al crear un cliente, el agente corre solo (auditoría → estrategia → contenido → GEO → indexación → informe).
- **Cron** `*/15`: re-check automático (configúralo en Ajustes; botón manual «Ejecutar cron ahora»).
- **LLM opcional** (Ajustes): endpoint compatible con OpenAI para el resumen ejecutivo.
- **Seguridad**: PBKDF2 100k, sesiones HttpOnly, roles `admin`/cliente con 403 verificados.
- **Probar en local**: `npm install && npm run db:init:local && npm run dev` → http://localhost:8787

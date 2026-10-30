-- RankAgent · esquema de base de datos (Cloudflare D1 / SQLite)
-- Aplicar: npx wrangler d1 execute rankagent --remote --file schema.sql
-- Local:   npx wrangler d1 execute rankagent --local  --file schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'cliente',   -- 'admin' | 'cliente'
  client_id     TEXT,                              -- si role='cliente': cliente asignado
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL DEFAULT '',
  niche           TEXT DEFAULT '',
  market          TEXT DEFAULT 'es-CL',
  type            TEXT DEFAULT 'servicios',
  keywords        TEXT DEFAULT '[]',   -- JSON array
  competitors     TEXT DEFAULT '',
  notes           TEXT DEFAULT '',
  auto_run        INTEGER DEFAULT 1,
  indexnow_key    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_run_id     TEXT,
  last_score      INTEGER,
  last_criticals  INTEGER,
  last_run_at     TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL,
  status       TEXT NOT NULL,          -- queued | running | done | error
  current_step TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  log          TEXT NOT NULL DEFAULT '[]',   -- JSON
  steps        TEXT NOT NULL DEFAULT '[]',   -- JSON
  result       TEXT,                          -- JSON (informe + artefactos)
  error        TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_runs_client    ON runs(client_id);
CREATE INDEX IF NOT EXISTS idx_users_client   ON users(client_id);

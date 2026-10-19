// Подключение к PostgreSQL и инициализация схемы.
const { Pool } = require('pg');
const config = require('./config');
const { logger } = require('./logger');

const pool = new Pool({ connectionString: config.databaseUrl });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         VARCHAR(254) NOT NULL UNIQUE,
  name          VARCHAR(100) NOT NULL,
  password_hash TEXT NOT NULL,
  role          VARCHAR(10) NOT NULL DEFAULT 'user' CHECK (role IN ('viewer', 'user', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- Активные подключения: одна строка = одно устройство/вход. Хранится ХЕШ refresh-токена.
CREATE TABLE IF NOT EXISTS sessions (
  id                UUID PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash      TEXT NOT NULL UNIQUE,
  prev_refresh_hash TEXT,
  rotated_at        TIMESTAMPTZ,
  user_agent        VARCHAR(255) NOT NULL DEFAULT '',
  ip                VARCHAR(64) NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_prev_hash_idx ON sessions(prev_refresh_hash);

-- Защита от подбора: счётчик неудачных входов по email (в том числе несуществующим).
CREATE TABLE IF NOT EXISTS login_attempts (
  email          VARCHAR(254) PRIMARY KEY,
  failures       INTEGER NOT NULL DEFAULT 0,
  last_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until   TIMESTAMPTZ
);

-- Восстановление доступа: одноразовые токены (хранится хеш).
CREATE TABLE IF NOT EXISTS password_resets (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id          SERIAL PRIMARY KEY,
  title       VARCHAR(200) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      VARCHAR(20) NOT NULL DEFAULT 'todo'
              CHECK (status IN ('todo', 'in_progress', 'done')),
  due_date    DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS attachments (
  id            SERIAL PRIMARY KEY,
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stored_name   VARCHAR(255) NOT NULL UNIQUE,
  original_name VARCHAR(255) NOT NULL,
  mime_type     VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
  size          INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_task_id_idx ON attachments(task_id);
`;

// БД в контейнере может подниматься дольше сервера — ждём её готовности.
async function init({ retries = 30, delayMs = 1000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await pool.query(SCHEMA);
      return;
    } catch (err) {
      if (attempt >= retries) throw err;
      logger.warn({ event: 'db.waiting', attempt, retries, code: err.code }, 'БД недоступна, повторяем попытку');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = { pool, init };

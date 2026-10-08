// Подключение к PostgreSQL и инициализация схемы.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgres://spp:spp@localhost:5432/spp',
});

const SCHEMA = `
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
      console.log(`БД недоступна (${err.code || err.message}), попытка ${attempt}/${retries}...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = { pool, init };

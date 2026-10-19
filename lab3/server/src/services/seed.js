// Начальные пользователи: администратор из переменных окружения и (по желанию) демо-аккаунты.
const { pool } = require('../db');
const config = require('../config');
const { logger } = require('../logger');
const { hashPassword } = require('../security/passwords');

async function ensureUser({ email, name, password, role }) {
  const { rowCount } = await pool.query('SELECT 1 FROM users WHERE email = $1', [email]);
  if (rowCount) return false;
  await pool.query('INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4)', [
    email, name, await hashPassword(password), role,
  ]);
  logger.info({ event: 'seed.user_created', email, role }, 'Создан начальный пользователь');
  return true;
}

async function seed() {
  if (config.adminEmail && config.adminPassword) {
    await ensureUser({ email: config.adminEmail.toLowerCase(), name: 'Администратор', password: config.adminPassword, role: 'admin' });
  }
  if (config.seedDemoUsers) {
    await ensureUser({ email: 'user@example.com', name: 'Пользователь Демо', password: 'User12345!', role: 'user' });
    await ensureUser({ email: 'viewer@example.com', name: 'Наблюдатель Демо', password: 'Viewer12345!', role: 'viewer' });
  }
}

module.exports = { seed };

// Защита от подбора учётных данных: счётчик неудач по email + временная блокировка.
// Работает и для несуществующих email, чтобы поведение не выдавало, зарегистрирован ли адрес.
const { pool } = require('../db');
const config = require('../config');

// Возвращает оставшееся время блокировки (сек) или 0.
async function lockedForSeconds(email) {
  const { rows } = await pool.query(
    'SELECT EXTRACT(EPOCH FROM (locked_until - now()))::float AS secs FROM login_attempts WHERE email = $1 AND locked_until > now()',
    [email]
  );
  return rows[0] ? Math.ceil(rows[0].secs) : 0;
}

// Фиксирует неудачную попытку. Возвращает { failures, lockedSeconds }.
async function recordFailure(email) {
  const { rows } = await pool.query(
    `INSERT INTO login_attempts (email, failures, last_failed_at)
     VALUES ($1, 1, now())
     ON CONFLICT (email) DO UPDATE SET
       failures = CASE WHEN login_attempts.last_failed_at < now() - make_interval(mins => $2)
                       THEN 1 ELSE login_attempts.failures + 1 END,
       last_failed_at = now()
     RETURNING failures`,
    [email, config.lockoutMinutes]
  );
  const failures = rows[0].failures;
  if (failures >= config.maxFailedAttempts) {
    await pool.query('UPDATE login_attempts SET locked_until = now() + make_interval(mins => $2) WHERE email = $1', [
      email,
      config.lockoutMinutes,
    ]);
    return { failures, lockedSeconds: config.lockoutMinutes * 60 };
  }
  return { failures, lockedSeconds: 0 };
}

const clear = (email) => pool.query('DELETE FROM login_attempts WHERE email = $1', [email]);

module.exports = { lockedForSeconds, recordFailure, clear };

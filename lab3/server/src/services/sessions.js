// Активные подключения (сессии) и обновление временных ключей.
const crypto = require('crypto');
const { pool } = require('../db');
const config = require('../config');
const { sha256, randomToken, signAccessToken } = require('../security/tokens');

const GRACE_MS = 10_000; // повторное предъявление «только что ротированного» токена (гонка вкладок)

const publicUser = (u) => ({
  id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.created_at, lastLoginAt: u.last_login_at ?? null,
});

function accessFor(user, sessionId) {
  return {
    accessToken: signAccessToken({ userId: user.id, role: user.role, sessionId }),
    tokenType: 'Bearer',
    expiresIn: config.accessTtlSec,
  };
}

// Создаёт сессию (новый вход). Если подключений больше лимита — старые завершаются.
async function createSession(user, req) {
  const refreshToken = randomToken();
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, user_id, refresh_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
    [id, user.id, sha256(refreshToken), String(req.get('user-agent') || '').slice(0, 255), String(req.ip || '').slice(0, 64), config.refreshTtlSec]
  );
  const { rows } = await pool.query(
    `UPDATE sessions SET revoked_at = now()
     WHERE id IN (SELECT id FROM sessions
                  WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
                  ORDER BY created_at DESC OFFSET $2)
     RETURNING id`,
    [user.id, config.maxSessions]
  );
  rows.forEach((r) =>
    req.log.info({ event: 'session.evicted', userId: user.id, sessionId: r.id }, 'Старейшее подключение завершено (лимит сессий)')
  );
  return { sessionId: id, refreshToken };
}

// Обмен refresh-токена на новую пару (ротация). Возвращает { user, sessionId, refreshToken|null }.
async function rotateRefresh(refreshToken, req) {
  const oldHash = sha256(refreshToken);
  const newToken = randomToken();

  const { rows } = await pool.query(
    `UPDATE sessions SET prev_refresh_hash = refresh_hash, refresh_hash = $2, rotated_at = now(),
            last_used_at = now(), expires_at = now() + make_interval(secs => $3), ip = $4
     WHERE refresh_hash = $1 AND revoked_at IS NULL AND expires_at > now()
     RETURNING id, user_id`,
    [oldHash, sha256(newToken), config.refreshTtlSec, String(req.ip || '').slice(0, 64)]
  );
  if (rows[0]) return { sessionId: rows[0].id, userId: rows[0].user_id, refreshToken: newToken };

  // Токен не текущий. Если он — предыдущий: либо гонка (допустимо), либо кража/повтор (отзываем сессию).
  const prev = await pool.query(
    `SELECT id, user_id, revoked_at, expires_at > now() AS alive,
            rotated_at > now() - make_interval(secs => $2) AS in_grace
     FROM sessions WHERE prev_refresh_hash = $1`,
    [oldHash, GRACE_MS / 1000]
  );
  const s = prev.rows[0];
  if (!s || s.revoked_at || !s.alive) return null;
  if (s.in_grace) return { sessionId: s.id, userId: s.user_id, refreshToken: null };

  await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [s.id]);
  req.log.warn({ event: 'auth.refresh.reuse_detected', sessionId: s.id, userId: s.user_id }, 'Повторное использование refresh-токена — сессия отозвана');
  return null;
}

const ACTIVE = 'revoked_at IS NULL AND expires_at > now()';

const listActive = (userId) =>
  pool.query(
    `SELECT id, user_agent, ip, created_at, last_used_at, expires_at FROM sessions
     WHERE user_id = $1 AND ${ACTIVE} ORDER BY last_used_at DESC`,
    [userId]
  ).then((r) => r.rows);

async function revokeOne(userId, sessionId) {
  const { rowCount } = await pool.query(
    `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND ${ACTIVE}`,
    [sessionId, userId]
  );
  return rowCount > 0;
}

async function revokeAll(userId, exceptSessionId = null) {
  const { rowCount } = await pool.query(
    `UPDATE sessions SET revoked_at = now()
     WHERE user_id = $1 AND ${ACTIVE} AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [userId, exceptSessionId]
  );
  return rowCount;
}

// Завершает сессию по refresh-токену (выход).
async function revokeByRefresh(refreshToken) {
  const h = sha256(refreshToken);
  const { rows } = await pool.query(
    `UPDATE sessions SET revoked_at = now()
     WHERE (refresh_hash = $1 OR prev_refresh_hash = $1) AND revoked_at IS NULL RETURNING id, user_id`,
    [h]
  );
  return rows[0] || null;
}

// Периодическая чистка старых записей.
const cleanup = () =>
  pool.query(`DELETE FROM sessions WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '7 days'`);

module.exports = { publicUser, accessFor, createSession, rotateRefresh, listActive, revokeOne, revokeAll, revokeByRefresh, cleanup };

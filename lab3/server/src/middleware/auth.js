// Аутентификация по access-токену и проверка ролей.
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { verifyAccessToken } = require('../security/tokens');
const { unauthorized, forbidden } = require('../errors');
const { wrap } = require('../http');

const RANK = { viewer: 1, user: 2, admin: 3 };

const authenticate = wrap(async (req, res, next) => {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw unauthorized('UNAUTHENTICATED', 'Требуется авторизация: передайте заголовок Authorization: Bearer <токен>.');

  let payload;
  try {
    payload = verifyAccessToken(match[1]);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw unauthorized('TOKEN_EXPIRED', 'Срок действия токена истёк. Обновите токен.');
    throw unauthorized('INVALID_TOKEN', 'Недействительный токен.');
  }

  // Токен «временный», но мы дополнительно сверяем его с БД: сессию можно отозвать мгновенно,
  // а роль всегда берётся актуальная.
  const { rows } = await pool.query(
    `SELECT s.id AS sid, s.last_used_at, u.id, u.email, u.name, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND u.id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [payload.sid, Number(payload.sub)]
  );
  if (!rows[0]) throw unauthorized('SESSION_REVOKED', 'Сессия завершена. Войдите снова.');

  const { sid, last_used_at: lastUsed, ...user } = rows[0];
  req.user = user;
  req.sessionId = sid;
  if (Date.now() - new Date(lastUsed).getTime() > 60_000) {
    pool.query('UPDATE sessions SET last_used_at = now() WHERE id = $1', [sid]).catch(() => {});
  }
  next();
});

// requireRole('user') — доступ для роли user и выше (admin).
const requireRole = (minRole) => (req, res, next) => {
  if (RANK[req.user.role] >= RANK[minRole]) return next();
  req.log.warn({ event: 'access.denied', required: minRole, actual: req.user.role }, 'Доступ запрещён: недостаточно прав');
  return next(forbidden(`Для этого действия нужна роль «${minRole}» или выше (у вас «${req.user.role}»).`));
};

module.exports = { authenticate, requireRole };

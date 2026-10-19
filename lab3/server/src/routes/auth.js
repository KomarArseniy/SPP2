// Аутентификация: регистрация, вход, обновление ключей, выход, сессии, восстановление пароля.
const express = require('express');
const { pool } = require('../db');
const config = require('../config');
const { wrap, methodNotAllowed } = require('../http');
const { HttpError, badRequest, unauthorized, notFound, conflict, tooManyRequests } = require('../errors');
const {
  validateRegister, validateLogin, validateForgot, validateReset, validateChangePassword,
} = require('../validate');
const { hashPassword, verifyPassword } = require('../security/passwords');
const { sha256, randomToken } = require('../security/tokens');
const { createRateLimiter } = require('../security/rateLimit');
const { authenticate } = require('../middleware/auth');
const sessions = require('../services/sessions');
const attempts = require('../services/loginAttempts');
const { sendPasswordReset } = require('../mailer');

const router = express.Router();
const limiter = createRateLimiter({ name: 'auth', ...config.authRateLimit });

// Ответы с ключами не должны попадать в кэш.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ---------- refresh-cookie ----------
const COOKIE = 'refresh_token';

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function setRefreshCookie(res, token) {
  const parts = [`${COOKIE}=${token}`, 'HttpOnly', 'SameSite=Strict', 'Path=/api/auth', `Max-Age=${config.refreshTtlSec}`];
  if (config.cookieSecure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearRefreshCookie(res) {
  const parts = [`${COOKIE}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/api/auth', 'Max-Age=0'];
  if (config.cookieSecure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function ensureValid({ value, errors }) {
  if (errors.length) throw badRequest('Данные не прошли проверку.', errors);
  return value;
}

// Пароль заведомо несуществующего пользователя проверяем «вхолостую», чтобы время ответа не выдавало,
// есть ли такой email в системе.
let dummyHash = null;
const getDummyHash = () => (dummyHash ||= hashPassword('dummy-password-for-timing-1'));

async function startSession(req, res, user, status = 200) {
  const { sessionId, refreshToken } = await sessions.createSession(user, req);
  setRefreshCookie(res, refreshToken);
  res.status(status).json({ user: sessions.publicUser(user), ...sessions.accessFor(user, sessionId) });
  return sessionId;
}

// ---------- регистрация ----------
router.route('/register')
  .post(limiter, wrap(async (req, res) => {
    const { email, name, password } = ensureValid(validateRegister(req.body));
    const { rows } = await pool.query(
      `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, 'user')
       ON CONFLICT (email) DO NOTHING RETURNING *`,
      [email, name, await hashPassword(password)]
    );
    if (!rows[0]) throw conflict('Пользователь с таким email уже зарегистрирован.');
    req.log.info({ event: 'auth.register', userId: rows[0].id }, 'Зарегистрирован новый пользователь');
    await startSession(req, res, rows[0], 201);
  }))
  .all(methodNotAllowed);

// ---------- вход ----------
router.route('/login')
  .post(limiter, wrap(async (req, res) => {
    const { email, password } = ensureValid(validateLogin(req.body));

    const locked = await attempts.lockedForSeconds(email);
    if (locked) {
      req.log.warn({ event: 'auth.login.blocked', email, retryAfter: locked }, 'Вход заблокирован: слишком много неудачных попыток');
      throw tooManyRequests('ACCOUNT_LOCKED', `Слишком много неудачных попыток входа. Повторите через ${Math.ceil(locked / 60)} мин.`, locked);
    }

    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    const ok = await verifyPassword(password, user ? user.password_hash : await getDummyHash());

    if (!user || !ok) {
      const { failures, lockedSeconds } = await attempts.recordFailure(email);
      req.log.warn({ event: 'auth.login.failed', email, failures }, 'Неудачная попытка входа');
      if (lockedSeconds) {
        req.log.warn({ event: 'auth.lockout', email, minutes: config.lockoutMinutes }, 'Учётная запись временно заблокирована');
        throw tooManyRequests('ACCOUNT_LOCKED', `Слишком много неудачных попыток входа. Учётная запись заблокирована на ${config.lockoutMinutes} мин.`, lockedSeconds);
      }
      const left = config.maxFailedAttempts - failures;
      throw new HttpError(401, 'INVALID_CREDENTIALS', `Неверный email или пароль. Осталось попыток: ${left}.`, {
        headers: { 'WWW-Authenticate': 'Bearer realm="api", error="invalid_request"' },
      });
    }

    await attempts.clear(email);
    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    const sessionId = await startSession(req, res, user);
    req.log.info({ event: 'auth.login.success', userId: user.id, sessionId }, 'Успешный вход');
  }))
  .all(methodNotAllowed);

// ---------- обновление ключей по refresh-cookie ----------
router.route('/refresh')
  .post(limiter, wrap(async (req, res) => {
    const token = readCookie(req, COOKIE);
    if (!token) throw unauthorized('NO_REFRESH_TOKEN', 'Нет refresh-токена. Войдите заново.');

    const result = await sessions.rotateRefresh(token, req);
    if (!result) {
      clearRefreshCookie(res);
      throw unauthorized('INVALID_REFRESH_TOKEN', 'Refresh-токен недействителен или устарел. Войдите заново.');
    }
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [result.userId]);
    if (!rows[0]) {
      clearRefreshCookie(res);
      throw unauthorized('INVALID_REFRESH_TOKEN', 'Пользователь не найден.');
    }
    if (result.refreshToken) setRefreshCookie(res, result.refreshToken);
    res.json({ user: sessions.publicUser(rows[0]), ...sessions.accessFor(rows[0], result.sessionId) });
  }))
  .all(methodNotAllowed);

// ---------- выход ----------
router.route('/logout')
  .post(wrap(async (req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) {
      const s = await sessions.revokeByRefresh(token);
      if (s) req.log.info({ event: 'auth.logout', userId: s.user_id, sessionId: s.id }, 'Выход');
    }
    clearRefreshCookie(res);
    res.status(204).end();
  }))
  .all(methodNotAllowed);

// ---------- профиль ----------
router.route('/me')
  .get(authenticate, (req, res) => res.json({ user: sessions.publicUser(req.user), sessionId: req.sessionId }))
  .all(methodNotAllowed);

router.route('/change-password')
  .post(authenticate, wrap(async (req, res) => {
    const { currentPassword, newPassword } = ensureValid(validateChangePassword(req.body));
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await verifyPassword(currentPassword, rows[0].password_hash))) {
      throw badRequest('Данные не прошли проверку.', [{ field: 'currentPassword', message: 'Неверный текущий пароль.' }]);
    }
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(newPassword), req.user.id]);
    const closed = await sessions.revokeAll(req.user.id, req.sessionId);
    req.log.info({ event: 'auth.password_changed', userId: req.user.id, closedSessions: closed }, 'Пароль изменён');
    res.status(204).end();
  }))
  .all(methodNotAllowed);

// ---------- контроль активных подключений ----------
router.route('/sessions')
  .get(authenticate, wrap(async (req, res) => {
    const list = await sessions.listActive(req.user.id);
    res.json(list.map((s) => ({
      id: s.id, userAgent: s.user_agent, ip: s.ip, createdAt: s.created_at, lastUsedAt: s.last_used_at,
      expiresAt: s.expires_at, current: s.id === req.sessionId,
    })));
  }))
  // Завершить все подключения, кроме текущего.
  .delete(authenticate, wrap(async (req, res) => {
    const closed = await sessions.revokeAll(req.user.id, req.sessionId);
    req.log.info({ event: 'session.revoked_others', userId: req.user.id, closed }, 'Завершены остальные подключения');
    res.status(204).end();
  }))
  .all(methodNotAllowed);

router.route('/sessions/:id')
  .delete(authenticate, wrap(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw badRequest('Некорректный id сессии.');
    if (!(await sessions.revokeOne(req.user.id, req.params.id))) throw notFound('Активная сессия не найдена.');
    if (req.params.id === req.sessionId) clearRefreshCookie(res);
    req.log.info({ event: 'session.revoked', userId: req.user.id, sessionId: req.params.id }, 'Подключение завершено');
    res.status(204).end();
  }))
  .all(methodNotAllowed);

// ---------- восстановление доступа через e-mail ----------
// Всегда 202 и одинаковый ответ — чтобы нельзя было выяснить, какие email зарегистрированы.
router.route('/forgot-password')
  .post(limiter, wrap(async (req, res) => {
    const { email } = ensureValid(validateForgot(req.body));
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];

    if (user) {
      const { rows: recent } = await pool.query(
        `SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1 AND created_at > now() - interval '1 hour'`,
        [user.id]
      );
      if (recent[0].n >= config.resetMaxPerHour) {
        req.log.warn({ event: 'auth.reset.throttled', userId: user.id }, 'Слишком частые запросы восстановления');
      } else {
        const token = randomToken();
        await pool.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
        await pool.query(
          `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`,
          [user.id, sha256(token), config.resetTtlMinutes]
        );
        // Не ждём SMTP, чтобы время ответа не отличалось для существующих/несуществующих адресов.
        sendPasswordReset(user, token).catch((err) =>
          req.log.error({ event: 'mail.failed', err, userId: user.id }, 'Не удалось отправить письмо')
        );
        req.log.info({ event: 'auth.reset.requested', userId: user.id }, 'Запрошено восстановление доступа');
      }
    } else {
      req.log.info({ event: 'auth.reset.unknown_email' }, 'Запрос восстановления для неизвестного email');
    }
    res.status(202).json({ message: 'Если такой email зарегистрирован, мы отправили на него письмо со ссылкой для восстановления.' });
  }))
  .all(methodNotAllowed);

router.route('/reset-password')
  .post(limiter, wrap(async (req, res) => {
    const { token, password } = ensureValid(validateReset(req.body));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE password_resets SET used_at = now()
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
        [sha256(token)]
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        throw new HttpError(400, 'INVALID_RESET_TOKEN', 'Ссылка недействительна, уже использована или устарела. Запросите восстановление заново.');
      }
      const { rows: users } = await client.query(
        'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, email',
        [await hashPassword(password), rows[0].user_id]
      );
      await client.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [users[0].id]);
      await client.query('DELETE FROM login_attempts WHERE email = $1', [users[0].email]);
      await client.query('COMMIT');
      req.log.info({ event: 'auth.reset.completed', userId: users[0].id }, 'Пароль восстановлен, все сессии завершены');
      res.status(204).end();
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }))
  .all(methodNotAllowed);

module.exports = router;

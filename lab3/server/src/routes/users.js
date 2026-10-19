// Управление пользователями — только для администратора.
const express = require('express');
const { pool } = require('../db');
const { wrap, idParam, methodNotAllowed } = require('../http');
const { badRequest, notFound, conflict } = require('../errors');
const { validateUserPatch } = require('../validate');
const { authenticate, requireRole } = require('../middleware/auth');
const sessions = require('../services/sessions');

const router = express.Router();
router.use(authenticate, requireRole('admin'));

const USER_SELECT = `
  SELECT u.*,
    (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now())::int AS active_sessions,
    EXISTS (SELECT 1 FROM login_attempts la WHERE la.email = u.email AND la.locked_until > now()) AS locked
  FROM users u`;

const toUser = (r) => ({ ...sessions.publicUser(r), activeSessions: r.active_sessions, locked: r.locked });

async function getUserOr404(id) {
  const { rows } = await pool.query(`${USER_SELECT} WHERE u.id = $1`, [id]);
  if (!rows[0]) throw notFound(`Пользователь с id=${id} не найден.`);
  return rows[0];
}

router.route('/')
  .get(wrap(async (req, res) => {
    const { rows } = await pool.query(`${USER_SELECT} ORDER BY u.id`);
    res.json(rows.map(toUser));
  }))
  .all(methodNotAllowed);

router.route('/:id')
  .get(wrap(async (req, res) => res.json(toUser(await getUserOr404(idParam(req.params.id))))))
  .patch(wrap(async (req, res) => {
    const id = idParam(req.params.id);
    await getUserOr404(id);
    const { value, errors } = validateUserPatch(req.body);
    if (errors.length) throw badRequest('Данные не прошли проверку.', errors);
    if (value.role && id === req.user.id) throw conflict('Нельзя изменить собственную роль.');

    const sets = [];
    const params = [];
    Object.entries(value).forEach(([k, v]) => { params.push(v); sets.push(`${k} = $${params.length}`); });
    params.push(id);
    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    if (value.role) req.log.info({ event: 'user.role_changed', targetId: id, role: value.role }, 'Роль пользователя изменена');
    res.json(toUser(await getUserOr404(id)));
  }))
  .delete(wrap(async (req, res) => {
    const id = idParam(req.params.id);
    if (id === req.user.id) throw conflict('Нельзя удалить самого себя.');
    const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [id]);
    if (!rowCount) throw notFound(`Пользователь с id=${id} не найден.`);
    req.log.info({ event: 'user.deleted', targetId: id }, 'Пользователь удалён');
    res.status(204).end();
  }))
  .all(methodNotAllowed);

// Снять блокировку после неудачных попыток входа.
router.route('/:id/unlock')
  .post(wrap(async (req, res) => {
    const user = await getUserOr404(idParam(req.params.id));
    await pool.query('DELETE FROM login_attempts WHERE email = $1', [user.email]);
    req.log.info({ event: 'user.unlocked', targetId: user.id }, 'Блокировка входа снята');
    res.status(204).end();
  }))
  .all(methodNotAllowed);

// Контроль подключений пользователя.
router.route('/:id/sessions')
  .get(wrap(async (req, res) => {
    const user = await getUserOr404(idParam(req.params.id));
    const list = await sessions.listActive(user.id);
    res.json(list.map((s) => ({
      id: s.id, userAgent: s.user_agent, ip: s.ip, createdAt: s.created_at, lastUsedAt: s.last_used_at, expiresAt: s.expires_at,
    })));
  }))
  .delete(wrap(async (req, res) => {
    const user = await getUserOr404(idParam(req.params.id));
    const closed = await sessions.revokeAll(user.id);
    req.log.info({ event: 'session.revoked_by_admin', targetId: user.id, closed }, 'Подключения пользователя завершены администратором');
    res.status(204).end();
  }))
  .all(methodNotAllowed);

module.exports = router;

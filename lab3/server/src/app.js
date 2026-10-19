// Сборка Express-приложения.
//
//  /api/auth/*   — вход, ключи, сессии, восстановление пароля   (routes/auth.js)
//  /api/users/*  — управление пользователями (admin)            (routes/users.js)
//  /api/tasks/*  — задачи и файлы (viewer / user / admin)       (routes/tasks.js)
const express = require('express');
const multer = require('multer');

const config = require('./config');
const { httpLogger } = require('./logger');
const { pool } = require('./db');
const { HttpError, notFound } = require('./errors');
const { wrap } = require('./http');
const { createRateLimiter } = require('./security/rateLimit');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const taskRoutes = require('./routes/tasks');

const MAX_FILE_MB = 10;
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

app.use(httpLogger);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
}));

const api = express.Router();
api.use(createRateLimiter({ name: 'api', ...config.apiRateLimit }));
api.use('/auth', authRoutes);
api.use('/users', userRoutes);
api.use('/tasks', taskRoutes);
api.use((req, res, next) => next(notFound('Маршрут API не найден.')));
app.use('/api', api);

// ---------- обработка ошибок: семантика кодов HTTP ----------
app.use((err, req, res, _next) => {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Внутренняя ошибка сервера.';
  let details;
  let headers = {};

  if (err instanceof HttpError) {
    ({ status, code, message, details, headers } = err);
  } else if (err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    code = err.code === 'LIMIT_FILE_SIZE' ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR';
    message = {
      LIMIT_FILE_SIZE: `Файл слишком большой (максимум ${MAX_FILE_MB} МБ).`,
      LIMIT_FILE_COUNT: 'Слишком много файлов (максимум 10 за раз).',
      LIMIT_UNEXPECTED_FILE: 'Файлы нужно отправлять в поле "files" (не более 10).',
    }[err.code] || `Ошибка загрузки файла: ${err.message}`;
    (req.files || []).forEach((f) => taskRoutes.removeFile(f.filename));
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_JSON';
    message = 'Тело запроса не является корректным JSON.';
  } else if (err.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Тело запроса слишком большое.';
  } else {
    req.log.error({ err, event: 'unhandled_error' }, 'Необработанная ошибка');
  }

  Object.entries(headers || {}).forEach(([k, v]) => res.set(k, v));
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}), requestId: req.id } });
});

module.exports = { app, UPLOADS_DIR: taskRoutes.UPLOADS_DIR };

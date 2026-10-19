// Структурированное логирование: каждая запись — одна строка JSON.
// Поля: time, level, service, msg + контекст (reqId, userId, event, ...).
// Секреты (пароли, токены, cookie, Authorization) маскируются.
const crypto = require('crypto');
const pino = require('pino');
const pinoHttp = require('pino-http');
const config = require('./config');

const logger = pino({
  level: config.logLevel,
  base: { service: 'spp-lab3-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.newPassword',
      '*.currentPassword',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
    ],
    censor: '[REDACTED]',
  },
});

// Лог каждого HTTP-запроса: метод, путь, статус, время, id запроса, пользователь.
const httpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && /^[\w-]{1,64}$/.test(incoming) ? incoming : crypto.randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  autoLogging: { ignore: (req) => req.url === '/api/health' },
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url.split('?')[0]} -> ${res.statusCode}`,
  customErrorMessage: (req, res) => `${req.method} ${req.url.split('?')[0]} -> ${res.statusCode} (error)`,
  customProps: (req) => ({ userId: req.user?.id ?? null, role: req.user?.role ?? null }),
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url, ip: req.remoteAddress }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});

module.exports = { logger, httpLogger };

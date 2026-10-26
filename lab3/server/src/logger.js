// Структурированное логирование: каждая запись — одна строка JSON.
// Поля: time, level, service, msg + контекст (reqId, userId, event, ...).
// Секреты (пароли, токены, cookie, Authorization) маскируются.
const crypto = require('crypto');
const pino = require('pino');
const pinoHttp = require('pino-http');
const config = require('./config');

// Куда писать: всегда в stdout (docker compose logs), а если задан LOG_FILE — ещё и в файл (по строке JSON на событие).
const streams = [{ stream: process.stdout }];
if (config.logFile) {
  const fileStream = pino.destination({ dest: config.logFile, mkdir: true, sync: false });
  fileStream.on('error', (err) => console.error(`Не удалось писать лог в файл ${config.logFile}: ${err.message}`));
  streams.push({ stream: fileStream });
}

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
}, pino.multistream(streams));

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
  customSuccessMessage: (req, res) => `${req.method} ${(req.originalUrl || req.url).split('?')[0]} -> ${res.statusCode}`,
  customErrorMessage: (req, res) => `${req.method} ${(req.originalUrl || req.url).split('?')[0]} -> ${res.statusCode} (error)`,
  // userId и role добавляем только когда пользователь известен: иначе ключи дублировались бы (null + реальное значение).
  customProps: (req) => (req.user ? { userId: req.user.id, role: req.user.role } : {}),
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url, ip: req.remoteAddress }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});

module.exports = { logger, httpLogger };

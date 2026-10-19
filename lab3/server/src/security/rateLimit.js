// Ограничитель частоты запросов (скользящее окно «по IP»), без внешних зависимостей.
// При превышении — 429 Too Many Requests + Retry-After. Заголовки RateLimit-* — по черновику IETF.
const { tooManyRequests } = require('../errors');

function createRateLimiter({ name, windowMs, max, keyFn = (req) => req.ip }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, Math.max(windowMs, 1000));
  timer.unref();

  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    const resetSec = Math.ceil((entry.reset - now) / 1000);
    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', Math.max(0, max - entry.count));
    res.setHeader('RateLimit-Reset', resetSec);

    if (entry.count > max) {
      req.log.warn({ event: 'rate_limit.exceeded', limiter: name, key }, 'Превышен лимит запросов');
      return next(tooManyRequests('RATE_LIMITED', `Слишком много запросов. Повторите через ${resetSec} с.`, resetSec));
    }
    return next();
  };
}

module.exports = { createRateLimiter };

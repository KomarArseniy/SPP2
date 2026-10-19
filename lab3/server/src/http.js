const { HttpError, badRequest } = require('./errors');
const { parseId } = require('./validate');

// Оборачивает async-обработчик, чтобы ошибки попадали в общий обработчик.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function idParam(raw, what = 'id') {
  const id = parseId(raw);
  if (id === null) throw badRequest(`Некорректный ${what}: ожидается положительное целое число.`);
  return id;
}

// 405 Method Not Allowed + обязательный по RFC 9110 заголовок Allow.
function methodNotAllowed(req, res, next) {
  const allowed = Object.keys(req.route.methods)
    .filter((m) => m !== '_all')
    .map((m) => m.toUpperCase());
  if (allowed.includes('GET')) allowed.push('HEAD');
  allowed.push('OPTIONS');
  res.set('Allow', [...new Set(allowed)].join(', '));
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next(new HttpError(405, 'METHOD_NOT_ALLOWED', `Метод ${req.method} не поддерживается для этого ресурса.`));
}

module.exports = { wrap, idParam, methodNotAllowed };

// Единый формат ошибок API:
// { "error": { "code": "FORBIDDEN", "message": "...", "details": [...], "requestId": "..." } }
class HttpError extends Error {
  constructor(status, code, message, { details, headers } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers || {};
  }
}

const badRequest = (message, details) => new HttpError(400, 'VALIDATION_ERROR', message, { details });
// 401: не удалось установить личность. По RFC 6750 сообщаем схему аутентификации.
const unauthorized = (code = 'UNAUTHENTICATED', message = 'Требуется авторизация.', error = 'invalid_token') =>
  new HttpError(401, code, message, {
    headers: { 'WWW-Authenticate': `Bearer realm="api"${code === 'UNAUTHENTICATED' ? '' : `, error="${error}"`}` },
  });
// 403: личность известна, но прав недостаточно.
const forbidden = (message = 'Недостаточно прав для этого действия.') => new HttpError(403, 'FORBIDDEN', message);
const notFound = (message = 'Ресурс не найден.') => new HttpError(404, 'NOT_FOUND', message);
const conflict = (message) => new HttpError(409, 'CONFLICT', message);
const tooManyRequests = (code, message, retryAfterSec) =>
  new HttpError(429, code, message, { headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSec))) } });

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict, tooManyRequests };

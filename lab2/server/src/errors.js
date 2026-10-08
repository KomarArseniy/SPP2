// Единый формат ошибок API:
// { "error": { "message": "...", "details": [{ "field": "...", "message": "..." }] } }
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const badRequest = (message, details) => new HttpError(400, message, details);
const notFound = (message = 'Ресурс не найден.') => new HttpError(404, message);

module.exports = { HttpError, badRequest, notFound };

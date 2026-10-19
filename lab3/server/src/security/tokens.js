// Временные ключи:
//  * access-токен — JWT (HS256), живёт минуты, передаётся в заголовке Authorization: Bearer ...
//  * refresh-токен — случайная строка, живёт дни, лежит в httpOnly-cookie, в БД хранится только её хеш.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function signAccessToken({ userId, role, sessionId }, options = {}) {
  return jwt.sign({ role, sid: sessionId }, config.jwtSecret, {
    algorithm: 'HS256',
    subject: String(userId),
    expiresIn: config.accessTtlSec,
    ...options,
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
}

module.exports = { sha256, randomToken, signAccessToken, verifyAccessToken };

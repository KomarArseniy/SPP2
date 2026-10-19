// Вся конфигурация читается из переменных окружения (12-factor).
const env = process.env;

const int = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (value, fallback = false) =>
  value === undefined || value === '' ? fallback : ['1', 'true', 'yes'].includes(String(value).toLowerCase());

const DEFAULT_SECRET = 'dev-insecure-secret-change-me';

module.exports = {
  env: env.NODE_ENV || 'development',
  port: int(env.PORT, 4000),
  databaseUrl: env.DATABASE_URL || 'postgres://spp:spp@localhost:5432/spp',
  uploadsDir: env.UPLOADS_DIR || null,
  logLevel: env.LOG_LEVEL || 'info',
  trustProxy: int(env.TRUST_PROXY, 1), // сколько прокси (nginx) стоит перед сервером

  // --- временные ключи ---
  jwtSecret: env.JWT_SECRET || DEFAULT_SECRET,
  usingDefaultSecret: !env.JWT_SECRET,
  accessTtlSec: int(env.ACCESS_TOKEN_TTL_SECONDS, 15 * 60), // access-токен живёт 15 минут
  refreshTtlSec: int(env.REFRESH_TOKEN_TTL_SECONDS, 7 * 24 * 3600), // refresh-токен — 7 дней
  cookieSecure: bool(env.COOKIE_SECURE, false), // true, если сайт отдаётся по HTTPS

  // --- защита от подбора ---
  maxFailedAttempts: int(env.MAX_FAILED_ATTEMPTS, 5),
  lockoutMinutes: int(env.LOCKOUT_MINUTES, 15),
  authRateLimit: { windowMs: int(env.AUTH_RATE_LIMIT_WINDOW_MS, 60_000), max: int(env.AUTH_RATE_LIMIT_MAX, 30) },
  apiRateLimit: { windowMs: int(env.API_RATE_LIMIT_WINDOW_MS, 60_000), max: int(env.API_RATE_LIMIT_MAX, 600) },

  // --- активные подключения ---
  maxSessions: int(env.MAX_SESSIONS, 5),

  // --- восстановление доступа ---
  resetTtlMinutes: int(env.RESET_TOKEN_TTL_MINUTES, 30),
  resetMaxPerHour: int(env.RESET_MAX_PER_HOUR, 3),
  appUrl: (env.APP_URL || 'http://localhost:8080').replace(/\/$/, ''),
  smtp: {
    host: env.SMTP_HOST || '',
    port: int(env.SMTP_PORT, 1025),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || 'Список задач <no-reply@tasks.local>',
  },

  // --- начальные данные ---
  adminEmail: env.ADMIN_EMAIL || '',
  adminPassword: env.ADMIN_PASSWORD || '',
  seedDemoUsers: bool(env.SEED_DEMO_USERS, false),
};

const { app } = require('./app');
const config = require('./config');
const { logger } = require('./logger');
const { init, pool } = require('./db');
const { seed } = require('./services/seed');
const { cleanup } = require('./services/sessions');

async function main() {
  if (config.usingDefaultSecret) {
    logger.warn({ event: 'config.insecure_secret' }, 'JWT_SECRET не задан — используется небезопасный секрет по умолчанию (только для разработки!)');
  }
  await init();
  await seed();

  const server = app.listen(config.port, () => logger.info({ event: 'server.started', port: config.port }, `API слушает порт ${config.port}`));
  const timer = setInterval(() => cleanup().catch((err) => logger.error({ err }, 'Ошибка очистки сессий')), 60 * 60 * 1000);
  timer.unref();

  const stop = (signal) => {
    logger.info({ event: 'server.stopping', signal }, 'Остановка сервера');
    server.close(() => pool.end().then(() => process.exit(0)));
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err, event: 'server.crashed' }, 'Не удалось запустить сервер');
  process.exit(1);
});

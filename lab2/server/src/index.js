const { app } = require('./app');
const { init, pool } = require('./db');

const PORT = process.env.PORT || 4000;

init()
  .then(() => {
    const server = app.listen(PORT, () => console.log(`API слушает порт ${PORT}`));
    const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  })
  .catch((err) => {
    console.error('Не удалось инициализировать БД:', err);
    process.exit(1);
  });

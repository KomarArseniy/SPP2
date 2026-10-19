// Отправка писем (восстановление пароля). Если SMTP не настроен — письмо только пишется в лог.
const nodemailer = require('nodemailer');
const config = require('./config');
const { logger } = require('./logger');

let transport = null;
if (config.smtp.host) {
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

// Последние отправленные письма (нужны тестам).
const outbox = [];

async function sendMail({ to, subject, text, html }) {
  outbox.push({ to, subject, text });
  if (outbox.length > 50) outbox.shift();

  if (!transport) {
    // Режим разработки без SMTP: выводим текст письма в лог, чтобы можно было взять ссылку.
    logger.info({ event: 'mail.not_configured', to, subject, text }, 'SMTP не настроен — письмо только записано в лог');
    return;
  }
  await transport.sendMail({ from: config.smtp.from, to, subject, text, html });
  logger.info({ event: 'mail.sent', to, subject }, 'Письмо отправлено');
}

function sendPasswordReset(user, token) {
  const link = `${config.appUrl}/?reset_token=${token}`;
  return sendMail({
    to: user.email,
    subject: 'Восстановление доступа — Список задач',
    text:
      `Здравствуйте, ${user.name}!\n\n` +
      `Чтобы задать новый пароль, перейдите по ссылке (действует ${config.resetTtlMinutes} мин., одноразовая):\n${link}\n\n` +
      'Если вы не запрашивали восстановление — просто проигнорируйте это письмо.',
    html:
      `<p>Здравствуйте, ${user.name.replace(/[<>&]/g, '')}!</p>` +
      `<p>Чтобы задать новый пароль, нажмите на ссылку (действует ${config.resetTtlMinutes} мин., одноразовая):</p>` +
      `<p><a href="${link}">${link}</a></p>` +
      '<p>Если вы не запрашивали восстановление — просто проигнорируйте это письмо.</p>',
  });
}

module.exports = { sendMail, sendPasswordReset, outbox };

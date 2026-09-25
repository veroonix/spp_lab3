const nodemailer = require('nodemailer');

function createMailer({ logger, port }) {
  async function sendRecoveryEmail(email, resetUrl) {
    if (!process.env.SMTP_HOST) {
      logger.warn('email_not_configured', { email });
      return;
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      } : undefined,
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: 'Восстановление доступа к книжной полке',
      text: `Ссылка для восстановления доступа действительна 30 минут: ${resetUrl}`,
    });
    logger.info('recovery_email_sent', { email });
  }

  function recoveryUrl(token) {
    return `${process.env.APP_URL || `http://localhost:${port}`}/?resetToken=${token}`;
  }

  return { sendRecoveryEmail, recoveryUrl };
}

module.exports = { createMailer };

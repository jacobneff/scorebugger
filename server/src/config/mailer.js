const nodemailer = require('nodemailer');

let transportPromise = null;

function resolveBoolean(value, fallback = false) {
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return fallback;
}

function isEmailConfigured() {
  return Boolean(process.env.SMTP_HOST);
}

async function getTransport() {
  if (transportPromise) return transportPromise;

  if (!isEmailConfigured()) {
    transportPromise = Promise.resolve(null);
    return transportPromise;
  }

  const {
    SMTP_HOST,
    SMTP_PORT = '587',
    SMTP_USER,
    SMTP_PASSWORD,
    SMTP_SECURE = 'false',
  } = process.env;

  const secure = resolveBoolean(SMTP_SECURE);

  transportPromise = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure,
    requireTLS: !secure,
    family: 4,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    auth:
      SMTP_USER && SMTP_PASSWORD
        ? {
            user: SMTP_USER,
            pass: SMTP_PASSWORD,
          }
        : undefined,
  });

  return transportPromise;
}

async function sendMail(options) {
  const from = process.env.EMAIL_FROM;

  if (!from) {
    throw new Error('EMAIL_FROM is not configured');
  }

  const transport = await getTransport();

  if (!transport) {
    // eslint-disable-next-line no-console
    console.warn('SMTP credentials missing; email delivery skipped');
    return { delivered: false };
  }

  try {
    await transport.sendMail({ ...options, from });
    return { delivered: true };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('SMTP send failed', {
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_SECURE,
      user: process.env.SMTP_USER ? '[redacted]' : null,
      code: error?.code,
      command: error?.command,
      message: error?.message,
    });
    throw error;
  }
}

module.exports = {
  isEmailConfigured,
  sendMail,
};

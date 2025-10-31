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

  transportPromise = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: resolveBoolean(SMTP_SECURE),
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

  await transport.sendMail({ ...options, from });
  return { delivered: true };
}

module.exports = {
  isEmailConfigured,
  sendMail,
};

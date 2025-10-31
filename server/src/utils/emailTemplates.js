const { resolveAppBaseUrl } = require('./urls');

function buildVerificationEmail({ displayName, token }) {
  const baseUrl = resolveAppBaseUrl();
  const verifyUrl = `${baseUrl}/auth/verify?token=${encodeURIComponent(token)}`;
  const greeting = displayName ? `Hi ${displayName},` : 'Hi there,';

  const subject = 'Confirm your Scorebugger account';
  const text = `${greeting}

Please confirm your email address to activate your Scorebugger account.

Click the link below (or paste it into your browser) within the next 24 hours:
${verifyUrl}

If you did not create this account, you can ignore this email.`;

  const html = `
    <p>${greeting}</p>
    <p>Please confirm your email address to activate your Scorebugger account.</p>
    <p><a href="${verifyUrl}">Verify your email address</a></p>
    <p style="margin-top:16px">If the button doesn't work, copy and paste this link into your browser:</p>
    <p><code>${verifyUrl}</code></p>
    <p style="margin-top:24px;font-size:14px;color:#6b7280">If you did not make this request, you can safely ignore this email.</p>
  `;

  return { subject, text, html };
}

function buildPasswordResetEmail({ displayName, token }) {
  const baseUrl = resolveAppBaseUrl();
  const resetUrl = `${baseUrl}/auth/reset-password?token=${encodeURIComponent(token)}`;
  const greeting = displayName ? `Hi ${displayName},` : 'Hi there,';

  const subject = 'Reset your Scorebugger password';
  const text = `${greeting}

We received a request to reset your Scorebugger password.

If you made this request, reset your password using the link below within the next 30 minutes:
${resetUrl}

If you did not request a password reset, you can ignore this email.`;

  const html = `
    <p>${greeting}</p>
    <p>We received a request to reset your Scorebugger password.</p>
    <p><a href="${resetUrl}">Reset your password</a></p>
    <p style="margin-top:16px">If the button doesn't work, copy and paste this link into your browser:</p>
    <p><code>${resetUrl}</code></p>
    <p style="margin-top:24px;font-size:14px;color:#6b7280">If you did not make this request, you can safely ignore this email.</p>
  `;

  return { subject, text, html };
}

module.exports = {
  buildVerificationEmail,
  buildPasswordResetEmail,
};

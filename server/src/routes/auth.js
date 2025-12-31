const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { sendMail, isEmailConfigured } = require('../config/mailer');
const { createTokenPair, hashToken } = require('../utils/tokens');
const {
  buildVerificationEmail,
  buildPasswordResetEmail,
} = require('../utils/emailTemplates');
const { requireAuth } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes
const RESEND_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again after 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to all auth routes
router.use(authLimiter);

async function issueVerificationToken(user) {
  const { token, tokenHash, expiresAt } = createTokenPair(VERIFICATION_TTL_MS);
  user.set({
    verificationTokenHash: tokenHash,
    verificationTokenExpires: expiresAt,
    verificationRequestedAt: new Date(),
  });
  await user.save();
  return token;
}

async function sendVerificationMessage(user) {
  const token = await issueVerificationToken(user);
  const payload = buildVerificationEmail({
    displayName: user.displayName || user.email,
    token,
  });

  const canSend = Boolean(process.env.EMAIL_FROM) && isEmailConfigured();
  if (canSend) {
    await sendMail({
      to: user.email,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    });
  }

  if (process.env.NODE_ENV !== 'production') {
    const fallbackUrl = payload.html.match(/href="([^"]+)"/)?.[1] || '';
    // eslint-disable-next-line no-console
    console.info(
      canSend ? '[DEV] Verification link (also emailed):' : '[DEV] Verification link:',
      fallbackUrl || payload.text
    );
  }
}

async function issuePasswordResetToken(user) {
  const { token, tokenHash, expiresAt } = createTokenPair(RESET_TTL_MS);
  user.set({
    passwordResetTokenHash: tokenHash,
    passwordResetExpires: expiresAt,
  });
  await user.save();
  return token;
}

async function sendPasswordResetMessage(user) {
  const token = await issuePasswordResetToken(user);
  const payload = buildPasswordResetEmail({
    displayName: user.displayName || user.email,
    token,
  });

  const canSend = Boolean(process.env.EMAIL_FROM) && isEmailConfigured();
  if (canSend) {
    await sendMail({
      to: user.email,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    });
  }

  if (!canSend || process.env.NODE_ENV !== 'production') {
    const fallbackUrl = payload.html.match(/href="([^"]+)"/)?.[1] || '';
    // eslint-disable-next-line no-console
    console.info(
      canSend ? '[DEV] Password reset link (also emailed):' : '[DEV] Password reset link:',
      fallbackUrl || payload.text
    );
  }
}

function generateToken(userId) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT secret is not set');
  }

  return jwt.sign(
    {
      sub: userId,
    },
    secret,
    { expiresIn: '7d' }
  );
}

function serializeUser(user) {
  return {
    id: user._id.toString(),
    email: user.email,
    displayName: user.displayName,
    emailVerified: Boolean(user.emailVerified),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

router.post('/register', async (req, res, next) => {
  try {
    const { email, password, displayName } = req.body ?? {};

    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    if (password.trim().length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existingUser = await User.findOne({ email: normalizedEmail }).lean();
    if (existingUser) {
      return res.status(409).json({ message: 'An account with that email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await User.create({
      email: normalizedEmail,
      passwordHash,
      displayName: displayName?.trim() || normalizedEmail,
    });

    await sendVerificationMessage(user);

    res.status(201).json({
      message: 'Registration successful. Please check your email to verify your account.',
      requiresEmailVerification: true,
      emailDeliveryConfigured: Boolean(process.env.EMAIL_FROM) && isEmailConfigured(),
      email: user.email,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};

    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const matches = await bcrypt.compare(password, user.passwordHash);

    if (!matches) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (!user.emailVerified) {
      return res.status(403).json({
        message: 'Please verify your email before signing in.',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }

    const token = generateToken(user._id.toString());

    res.json({
      token,
      user: serializeUser(user),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/verify-email', async (req, res, next) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
    if (!token) {
      return res.status(400).json({ message: 'Verification token is required' });
    }

    const tokenHash = hashToken(token);

    const user = await User.findOne({
      verificationTokenHash: tokenHash,
      verificationTokenExpires: { $gt: new Date() },
    }).select('+verificationTokenHash +verificationTokenExpires +verificationRequestedAt');

    if (!user) {
      return res
        .status(400)
        .json({ message: 'Verification link is invalid or has expired. Please request a new one.' });
    }

    user.set({
      emailVerified: true,
      verificationTokenHash: null,
      verificationTokenExpires: null,
      verificationRequestedAt: null,
    });
    await user.save();

    const authToken = generateToken(user._id.toString());

    return res.json({
      message: 'Email verified successfully',
      token: authToken,
      user: serializeUser(user),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/resend-verification', async (req, res, next) => {
  try {
    const { email } = req.body ?? {};
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const user = await User.findOne({ email: normalizedEmail }).select(
      '+verificationTokenHash +verificationTokenExpires +verificationRequestedAt'
    );

    if (!user || user.emailVerified) {
      return res.json({
        message:
          'If that account exists and is not verified, we just sent another verification email.',
      });
    }

    const lastSentAt = user.verificationRequestedAt
      ? user.verificationRequestedAt.getTime()
      : 0;
    if (Date.now() - lastSentAt < RESEND_COOLDOWN_MS) {
      return res.status(429).json({
        message: 'A verification email was sent recently. Please wait a few minutes and try again.',
      });
    }

    await sendVerificationMessage(user);

    return res.json({
      message: 'A verification email has been sent to your inbox.',
    });
  } catch (error) {
    next(error);
  }
});

router.post('/request-password-reset', async (req, res, next) => {
  try {
    const { email } = req.body ?? {};
    if (!email) {
      return res
        .status(200)
        .json({ message: 'If that account exists, a reset email will arrive shortly.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const user = await User.findOne({ email: normalizedEmail }).select(
      '+passwordResetTokenHash +passwordResetExpires'
    );

    if (user) {
      await sendPasswordResetMessage(user);
    }

    return res.json({
      message: 'If that account exists, a reset email will arrive shortly.',
    });
  } catch (error) {
    next(error);
  }
});

router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body ?? {};

    const rawToken = typeof token === 'string' ? token.trim() : '';

    if (!rawToken || typeof password !== 'string') {
      return res.status(400).json({ message: 'Reset token and new password are required' });
    }

    if (password.trim().length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long' });
    }

    const tokenHash = hashToken(rawToken);

    const user = await User.findOne({
      passwordResetTokenHash: tokenHash,
      passwordResetExpires: { $gt: new Date() },
    }).select('+passwordResetTokenHash +passwordResetExpires +passwordHash');

    if (!user) {
      return res
        .status(400)
        .json({ message: 'Reset link is invalid or has expired. Please request a new one.' });
    }

    const newPasswordHash = await bcrypt.hash(password, 12);

    user.set({
      passwordHash: newPasswordHash,
      passwordResetTokenHash: null,
      passwordResetExpires: null,
      emailVerified: true,
      verificationTokenHash: null,
      verificationTokenExpires: null,
      verificationRequestedAt: null,
    });
    await user.save();

    const authToken = generateToken(user._id.toString());

    return res.json({
      message: 'Password updated successfully',
      token: authToken,
      user: serializeUser(user),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};

    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ message: 'Current and new passwords are required' });
    }

    if (!currentPassword.trim()) {
      return res.status(400).json({ message: 'Current password is required' });
    }

    if (newPassword.trim().length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long' });
    }

    const user = await User.findById(req.user.id).select('+passwordHash +passwordResetTokenHash');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const matches = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!matches) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 12);
    user.set({
      passwordHash: newPasswordHash,
      passwordResetTokenHash: null,
      passwordResetExpires: null,
    });
    await user.save();

    const token = generateToken(user._id.toString());
    return res.json({
      message: 'Password updated successfully',
      token,
      user: serializeUser(user),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

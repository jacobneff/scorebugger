const jwt = require('jsonwebtoken');
const User = require('../models/User');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const token = header.slice(7).trim();

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT secret not configured');
    }

    const payload = jwt.verify(token, secret);

    const user = await User.findById(payload.sub).lean();

    if (!user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!user.emailVerified) {
      return res.status(403).json({
        message: 'Email verification required',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }

    req.user = {
      id: user._id.toString(),
      email: user.email,
      displayName: user.displayName,
      emailVerified: Boolean(user.emailVerified),
    };

    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
}

module.exports = {
  requireAuth,
};

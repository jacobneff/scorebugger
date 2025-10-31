const crypto = require('crypto');

function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createTokenPair(ttlMs) {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + Math.max(ttlMs, 60_000));
  return { token, tokenHash, expiresAt };
}

module.exports = {
  generateToken,
  hashToken,
  createTokenPair,
};

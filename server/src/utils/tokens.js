const crypto = require('crypto');

function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function resolveTtl(ttlMs) {
  const parsed = Number(ttlMs);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 60_000;
  }

  return Math.max(parsed, 60_000);
}

function createTokenPair(ttlMs) {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + resolveTtl(ttlMs));
  return { token, tokenHash, expiresAt };
}

module.exports = {
  generateToken,
  hashToken,
  createTokenPair,
  resolveTtl,
};

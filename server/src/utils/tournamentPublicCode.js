const crypto = require('crypto');

const CODE_LENGTH = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function generateTournamentPublicCode() {
  const randomBytes = crypto.randomBytes(CODE_LENGTH);

  return Array.from(randomBytes)
    .map((value) => ALPHABET[value % ALPHABET.length])
    .join('');
}

async function createUniqueTournamentPublicCode(TournamentModel, maxAttempts = 25) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateTournamentPublicCode();
    const exists = await TournamentModel.exists({ publicCode: candidate });

    if (!exists) {
      return candidate;
    }
  }

  throw new Error('Failed to generate a unique tournament code');
}

module.exports = {
  CODE_LENGTH,
  generateTournamentPublicCode,
  createUniqueTournamentPublicCode,
};

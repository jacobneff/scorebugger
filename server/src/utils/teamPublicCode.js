const crypto = require('crypto');

const TEAM_PUBLIC_CODE_LENGTH = 8;
const TEAM_PUBLIC_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const TEAM_PUBLIC_CODE_PATTERN = /^[A-Z0-9]{8}$/;

function normalizeTeamPublicCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function generateTeamPublicCode() {
  const randomBytes = crypto.randomBytes(TEAM_PUBLIC_CODE_LENGTH);

  return Array.from(randomBytes)
    .map((value) => TEAM_PUBLIC_CODE_ALPHABET[value % TEAM_PUBLIC_CODE_ALPHABET.length])
    .join('');
}

function isValidTeamPublicCode(value) {
  return TEAM_PUBLIC_CODE_PATTERN.test(normalizeTeamPublicCode(value));
}

async function createUniqueTeamPublicCode(
  TournamentTeamModel,
  tournamentId,
  { excludeTeamId = null, reservedCodes = null, maxAttempts = 40 } = {}
) {
  const normalizedReservedCodes =
    reservedCodes && typeof reservedCodes?.has === 'function' ? reservedCodes : null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateTeamPublicCode();

    if (normalizedReservedCodes?.has(candidate)) {
      continue;
    }

    const query = {
      tournamentId,
      publicTeamCode: candidate,
    };

    if (excludeTeamId) {
      query._id = { $ne: excludeTeamId };
    }

    const exists = await TournamentTeamModel.exists(query);

    if (!exists) {
      return candidate;
    }
  }

  throw new Error('Failed to generate a unique team public code');
}

module.exports = {
  TEAM_PUBLIC_CODE_LENGTH,
  TEAM_PUBLIC_CODE_PATTERN,
  createUniqueTeamPublicCode,
  generateTeamPublicCode,
  isValidTeamPublicCode,
  normalizeTeamPublicCode,
};

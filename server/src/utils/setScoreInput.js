function createSetScoreInputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function parseNonNegativeInteger(value, label) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw createSetScoreInputError(`${label} must be an integer >= 0`);
  }

  return parsed;
}

function normalizeSetScoreEntry(entry, index) {
  if (!entry || typeof entry !== 'object') {
    throw createSetScoreInputError(`Set ${index + 1} must include scores for both teams`);
  }

  return {
    a: parseNonNegativeInteger(entry.a, `Set ${index + 1} team A score`),
    b: parseNonNegativeInteger(entry.b, `Set ${index + 1} team B score`),
  };
}

function parseSetScoreToken(token, index) {
  const match = /^(\d+)\s*-\s*(\d+)$/.exec(token);

  if (!match) {
    throw createSetScoreInputError(`Set ${index + 1} must use the format A-B`);
  }

  return {
    a: parseNonNegativeInteger(match[1], `Set ${index + 1} team A score`),
    b: parseNonNegativeInteger(match[2], `Set ${index + 1} team B score`),
  };
}

function parseSetScoresFromString(input) {
  const trimmed = input.trim();

  if (!trimmed) {
    throw createSetScoreInputError('setScores text is required');
  }

  const tokens = trimmed
    .replace(/,/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    throw createSetScoreInputError('setScores text is required');
  }

  return tokens.map(parseSetScoreToken);
}

function validateBestOfThreeSetScores(setScores) {
  if (!Array.isArray(setScores) || (setScores.length !== 2 && setScores.length !== 3)) {
    throw createSetScoreInputError('setScores must contain 2 or 3 sets');
  }

  return setScores;
}

function normalizeSetScoresInput(input) {
  const normalized =
    typeof input === 'string'
      ? parseSetScoresFromString(input)
      : Array.isArray(input)
        ? input.map(normalizeSetScoreEntry)
        : null;

  if (!normalized) {
    throw createSetScoreInputError('setScores must be an array or score line text');
  }

  return validateBestOfThreeSetScores(normalized);
}

function inferSetWins(setScores) {
  return (Array.isArray(setScores) ? setScores : []).reduce(
    (accumulator, set) => {
      if (set.a > set.b) {
        accumulator.a += 1;
      } else if (set.b > set.a) {
        accumulator.b += 1;
      }

      return accumulator;
    },
    { a: 0, b: 0 }
  );
}

function hasDecisiveWinner(setScores) {
  const wins = inferSetWins(setScores);
  return (wins.a === 2 || wins.b === 2) && wins.a !== wins.b;
}

module.exports = {
  createSetScoreInputError,
  hasDecisiveWinner,
  inferSetWins,
  normalizeSetScoresInput,
  validateBestOfThreeSetScores,
};

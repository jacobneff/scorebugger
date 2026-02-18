function createSetScoreInputError(message) {
  const error = new Error(message);
  error.code = 'SET_SCORE_INPUT_INVALID';
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

export function parseSetScoreLine(input) {
  if (typeof input !== 'string') {
    throw createSetScoreInputError('setScores text is required');
  }

  const tokens = input
    .trim()
    .replace(/,/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    throw createSetScoreInputError('setScores text is required');
  }

  return tokens.map(parseSetScoreToken);
}

export function normalizeSetScoresInput(input) {
  const normalized =
    typeof input === 'string'
      ? parseSetScoreLine(input)
      : Array.isArray(input)
        ? input.map(normalizeSetScoreEntry)
        : null;

  if (!normalized) {
    throw createSetScoreInputError('setScores must be an array or score line text');
  }

  if (normalized.length !== 2 && normalized.length !== 3) {
    throw createSetScoreInputError('setScores must contain 2 or 3 sets');
  }

  return normalized;
}

export function inferSetWins(setScores) {
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

export function hasDecisiveWinner(setScores) {
  const wins = inferSetWins(setScores);
  return (wins.a === 2 || wins.b === 2) && wins.a !== wins.b;
}

export function formatSetScoreLine(setScores) {
  return (Array.isArray(setScores) ? setScores : [])
    .map((set) => `${set.a}-${set.b}`)
    .join(', ');
}

export function toSetScoreChips(setScores) {
  return (Array.isArray(setScores) ? setScores : []).map((set, index) => ({
    id: `set-${index + 1}`,
    label: `Set ${index + 1}: ${set.a}-${set.b}`,
  }));
}

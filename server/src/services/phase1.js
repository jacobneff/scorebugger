const PHASE1_POOL_NAMES = ['A', 'B', 'C', 'D', 'E'];

const PHASE1_POOL_HOME_COURTS = {
  A: 'SRC-1',
  B: 'SRC-2',
  C: 'SRC-3',
  D: 'VC-1',
  E: 'VC-2',
};

const PHASE1_COURT_ORDER = ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1', 'VC-2'];

const PHASE1_MATCH_ORDER = [
  {
    roundBlock: 1,
    teamAIndex: 0,
    teamBIndex: 1,
    refIndex: 2,
  },
  {
    roundBlock: 2,
    teamAIndex: 1,
    teamBIndex: 2,
    refIndex: 0,
  },
  {
    roundBlock: 3,
    teamAIndex: 0,
    teamBIndex: 2,
    refIndex: 1,
  },
];

const SCORING_DEFAULTS = {
  setTargets: [25, 25, 15],
  winBy: 2,
  caps: [27, 27, 17],
};

const phase1PoolNameIndex = PHASE1_POOL_NAMES.reduce((lookup, poolName, index) => {
  lookup[poolName] = index;
  return lookup;
}, {});

const clampPositiveInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
};

const normalizeScoringArray = (value, fallback) => {
  if (!Array.isArray(value) || value.length !== 3) {
    return [...fallback];
  }

  return value.map((entry, index) => clampPositiveInt(entry, fallback[index]));
};

function normalizeScoringConfig(rawScoring) {
  const scoring = rawScoring && typeof rawScoring === 'object' ? rawScoring : {};

  return {
    setTargets: normalizeScoringArray(scoring.setTargets, SCORING_DEFAULTS.setTargets),
    winBy: clampPositiveInt(scoring.winBy, SCORING_DEFAULTS.winBy),
    caps: normalizeScoringArray(scoring.caps, SCORING_DEFAULTS.caps),
  };
}

function getFacilityFromCourt(court) {
  if (typeof court !== 'string') {
    return null;
  }

  if (court.startsWith('SRC-')) {
    return 'SRC';
  }

  if (court.startsWith('VC-')) {
    return 'VC';
  }

  return null;
}

function sortPoolsByPhase1Name(a, b) {
  const aIndex = phase1PoolNameIndex[a?.name] ?? Number.MAX_SAFE_INTEGER;
  const bIndex = phase1PoolNameIndex[b?.name] ?? Number.MAX_SAFE_INTEGER;

  if (aIndex !== bIndex) {
    return aIndex - bIndex;
  }

  const aName = typeof a?.name === 'string' ? a.name : '';
  const bName = typeof b?.name === 'string' ? b.name : '';
  return aName.localeCompare(bName);
}

function buildSerpentineAssignments(teams) {
  const assignments = PHASE1_POOL_NAMES.reduce((map, poolName) => {
    map[poolName] = [];
    return map;
  }, {});

  if (!Array.isArray(teams) || teams.length === 0) {
    return assignments;
  }

  let poolIndex = 0;
  let direction = 1;

  teams.slice(0, 15).forEach((team) => {
    const poolName = PHASE1_POOL_NAMES[poolIndex];
    assignments[poolName].push(team._id);

    poolIndex += direction;
    if (poolIndex >= PHASE1_POOL_NAMES.length) {
      direction = -1;
      poolIndex = PHASE1_POOL_NAMES.length - 1;
    } else if (poolIndex < 0) {
      direction = 1;
      poolIndex = 0;
    }
  });

  return assignments;
}

module.exports = {
  PHASE1_COURT_ORDER,
  PHASE1_MATCH_ORDER,
  PHASE1_POOL_HOME_COURTS,
  PHASE1_POOL_NAMES,
  SCORING_DEFAULTS,
  buildSerpentineAssignments,
  getFacilityFromCourt,
  normalizeScoringConfig,
  sortPoolsByPhase1Name,
};

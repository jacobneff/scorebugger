const Match = require('../models/Match');
const Pool = require('../models/Pool');
const Tournament = require('../models/Tournament');
const { PHASE1_POOL_NAMES } = require('./phase1');
const { computeStandingsBundle } = require('./tournamentEngine/standings');

const PHASE2_POOL_NAMES = ['F', 'G', 'H', 'I', 'J'];
const PHASE2_POOL_HOME_COURTS = {
  F: 'SRC-1',
  G: 'SRC-2',
  H: 'SRC-3',
  I: 'VC-1',
  J: 'VC-2',
};

const PHASE2_MATCH_ORDER = [
  {
    roundBlock: 4,
    teamAIndex: 0,
    teamBIndex: 1,
    refIndex: 2,
  },
  {
    roundBlock: 5,
    teamAIndex: 1,
    teamBIndex: 2,
    refIndex: 0,
  },
  {
    roundBlock: 6,
    teamAIndex: 0,
    teamBIndex: 2,
    refIndex: 1,
  },
];

const PHASE2_POOL_MAPPING = {
  F: ['A1', 'B2', 'C3'],
  G: ['B1', 'C2', 'D3'],
  H: ['C1', 'D2', 'E3'],
  I: ['D1', 'E2', 'A3'],
  J: ['E1', 'A2', 'B3'],
};

const PHASE2_SWAP_TIERS = [3, 2, 1];
const MAX_PHASE2_SWAP_ATTEMPTS = 50;
const PHASE1_EXPECTED_MATCH_COUNT = 15;

const PLACEMENT_TOKEN_PATTERN = /^([A-E])([1-3])$/;

const toIdString = (value) => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && value._id) {
    return value._id.toString();
  }

  return value.toString();
};

const normalizeTeamIdList = (value) =>
  Array.isArray(value) ? value.map((teamId) => toIdString(teamId)).filter(Boolean) : [];

const normalizePoolOverrides = (rawOverrides) => {
  if (!rawOverrides) {
    return {};
  }

  if (rawOverrides instanceof Map) {
    return Object.fromEntries(
      Array.from(rawOverrides.entries()).map(([poolName, teamIds]) => [
        poolName,
        normalizeTeamIdList(teamIds),
      ])
    );
  }

  if (typeof rawOverrides === 'object') {
    return Object.fromEntries(
      Object.entries(rawOverrides).map(([poolName, teamIds]) => [
        poolName,
        normalizeTeamIdList(teamIds),
      ])
    );
  }

  return {};
};

const isPermutation = (candidate, expected) => {
  if (!Array.isArray(candidate) || !Array.isArray(expected)) {
    return false;
  }

  if (candidate.length !== expected.length) {
    return false;
  }

  if (new Set(candidate).size !== candidate.length) {
    return false;
  }

  const expectedSet = new Set(expected);
  return candidate.every((teamId) => expectedSet.has(teamId));
};

const parsePlacementToken = (token) => {
  if (typeof token !== 'string') {
    return null;
  }

  const normalizedToken = token.trim().toUpperCase();
  const match = normalizedToken.match(PLACEMENT_TOKEN_PATTERN);

  if (!match) {
    return null;
  }

  return {
    sourcePoolName: match[1],
    placement: Number(match[2]),
  };
};

const buildPairKey = (teamIdA, teamIdB) => {
  const left = toIdString(teamIdA);
  const right = toIdString(teamIdB);

  if (!left || !right || left === right) {
    return null;
  }

  return left < right ? `${left}:${right}` : `${right}:${left}`;
};

const buildConflictPairsForTeamIds = (teamIds, playedPairs) => {
  const conflicts = [];
  const ids = normalizeTeamIdList(teamIds);

  for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
      const key = buildPairKey(ids[leftIndex], ids[rightIndex]);

      if (!key || !playedPairs.has(key)) {
        continue;
      }

      const [teamIdA, teamIdB] = key.split(':');
      conflicts.push({ teamIdA, teamIdB });
    }
  }

  return conflicts;
};

const cloneState = (state) =>
  Object.fromEntries(
    PHASE2_POOL_NAMES.map((poolName) => [
      poolName,
      (state[poolName] || []).map((entry) => ({ ...entry })),
    ])
  );

const evaluatePhase2State = (state, playedPairs) => {
  const warningsByPool = {};
  let totalConflicts = 0;

  PHASE2_POOL_NAMES.forEach((poolName) => {
    const entries = Array.isArray(state[poolName]) ? state[poolName] : [];
    const orderedEntries = [...entries].sort((a, b) => (a.slotIndex ?? 0) - (b.slotIndex ?? 0));
    const teamIds = orderedEntries.map((entry) => toIdString(entry.teamId)).filter(Boolean);
    const warnings = buildConflictPairsForTeamIds(teamIds, playedPairs);

    warningsByPool[poolName] = warnings;
    totalConflicts += warnings.length;
  });

  return { warningsByPool, totalConflicts };
};

const swapTierEntries = (state, sourcePoolName, targetPoolName, tier) => {
  const nextState = cloneState(state);
  const sourceEntries = nextState[sourcePoolName] || [];
  const targetEntries = nextState[targetPoolName] || [];
  const sourceIndex = sourceEntries.findIndex((entry) => entry.tier === tier);
  const targetIndex = targetEntries.findIndex((entry) => entry.tier === tier);

  if (sourceIndex === -1 || targetIndex === -1) {
    return null;
  }

  const sourceTeamId = sourceEntries[sourceIndex].teamId;
  sourceEntries[sourceIndex].teamId = targetEntries[targetIndex].teamId;
  targetEntries[targetIndex].teamId = sourceTeamId;

  return nextState;
};

const buildInitialPhase2State = (placementsByPool) =>
  Object.fromEntries(
    PHASE2_POOL_NAMES.map((poolName) => {
      const slots = PHASE2_POOL_MAPPING[poolName].map((placementToken, slotIndex) => {
        const placementMeta = parsePlacementToken(placementToken);

        if (!placementMeta) {
          throw new Error(`Invalid Phase 2 placement token: ${placementToken}`);
        }

        const sourcePoolPlacements = placementsByPool[placementMeta.sourcePoolName] || [];
        const teamId = toIdString(sourcePoolPlacements[placementMeta.placement - 1]);

        if (!teamId) {
          throw new Error(`Missing team for placement ${placementToken}`);
        }

        return {
          placementToken,
          slotIndex,
          tier: placementMeta.placement,
          teamId,
        };
      });

      return [poolName, slots];
    })
  );

const buildPhase2PoolPayloadsFromState = (state, warningsByPool) =>
  PHASE2_POOL_NAMES.map((poolName) => {
    const orderedEntries = [...(state[poolName] || [])].sort(
      (entryA, entryB) => (entryA.slotIndex ?? 0) - (entryB.slotIndex ?? 0)
    );

    return {
      name: poolName,
      teamIds: orderedEntries.map((entry) => entry.teamId),
      homeCourt: PHASE2_POOL_HOME_COURTS[poolName] || null,
      rematchWarnings: Array.isArray(warningsByPool?.[poolName]) ? warningsByPool[poolName] : [],
    };
  });

function resolvePhase2Rematches(initialState, playedPairs, maxAttempts = MAX_PHASE2_SWAP_ATTEMPTS) {
  let currentState = cloneState(initialState);
  let currentEvaluation = evaluatePhase2State(currentState, playedPairs);
  let bestState = cloneState(currentState);
  let bestEvaluation = currentEvaluation;
  let attempts = 0;

  for (const tier of PHASE2_SWAP_TIERS) {
    let tierImproved = true;

    while (tierImproved && attempts < maxAttempts) {
      tierImproved = false;

      for (const poolName of PHASE2_POOL_NAMES) {
        const poolWarnings = currentEvaluation.warningsByPool[poolName] || [];

        if (poolWarnings.length === 0) {
          continue;
        }

        let appliedSwap = false;

        for (const candidatePoolName of PHASE2_POOL_NAMES) {
          if (candidatePoolName === poolName) {
            continue;
          }

          if (attempts >= maxAttempts) {
            break;
          }

          attempts += 1;

          const candidateState = swapTierEntries(
            currentState,
            poolName,
            candidatePoolName,
            tier
          );

          if (!candidateState) {
            continue;
          }

          const candidateEvaluation = evaluatePhase2State(candidateState, playedPairs);

          if (candidateEvaluation.totalConflicts < currentEvaluation.totalConflicts) {
            currentState = candidateState;
            currentEvaluation = candidateEvaluation;
            tierImproved = true;
            appliedSwap = true;

            if (candidateEvaluation.totalConflicts < bestEvaluation.totalConflicts) {
              bestState = cloneState(candidateState);
              bestEvaluation = candidateEvaluation;
            }

            break;
          }
        }

        if (appliedSwap) {
          break;
        }
      }
    }
  }

  return {
    state: bestState,
    warningsByPool: bestEvaluation.warningsByPool,
    totalConflicts: bestEvaluation.totalConflicts,
    attempts,
  };
}

async function loadFinalizedPhase1PlayedPairs(tournamentId) {
  const finalizedPhase1Matches = await Match.find({
    tournamentId,
    phase: 'phase1',
    status: 'final',
    result: { $ne: null },
  })
    .select('teamAId teamBId')
    .lean();

  const playedPairs = new Set();

  finalizedPhase1Matches.forEach((match) => {
    const pairKey = buildPairKey(match.teamAId, match.teamBId);

    if (pairKey) {
      playedPairs.add(pairKey);
    }
  });

  return playedPairs;
}

function computeRematchWarningsForPools(pools, playedPairs) {
  return Object.fromEntries(
    PHASE2_POOL_NAMES.map((poolName) => {
      const pool = Array.isArray(pools)
        ? pools.find((entry) => entry?.name === poolName)
        : null;
      const teamIds = pool ? normalizeTeamIdList(pool.teamIds) : [];

      return [poolName, buildConflictPairsForTeamIds(teamIds, playedPairs)];
    })
  );
}

async function recomputePhase2RematchWarnings(tournamentId) {
  const [phase2Pools, playedPairs] = await Promise.all([
    Pool.find({
      tournamentId,
      phase: 'phase2',
      name: { $in: PHASE2_POOL_NAMES },
    })
      .select('_id name teamIds')
      .lean(),
    loadFinalizedPhase1PlayedPairs(tournamentId),
  ]);

  const warningsByPool = computeRematchWarningsForPools(phase2Pools, playedPairs);

  if (phase2Pools.length > 0) {
    await Pool.bulkWrite(
      phase2Pools.map((pool) => ({
        updateOne: {
          filter: { _id: pool._id },
          update: {
            $set: {
              rematchWarnings: warningsByPool[pool.name] || [],
            },
          },
        },
      })),
      { ordered: true }
    );
  }

  return warningsByPool;
}

async function computePhase1PlacementsForPhase2(tournamentId) {
  const [tournament, phase1Pools, phase1Matches] = await Promise.all([
    Tournament.findById(tournamentId).select('standingsOverrides').lean(),
    Pool.find({
      tournamentId,
      phase: 'phase1',
      name: { $in: PHASE1_POOL_NAMES },
    })
      .select('name teamIds')
      .lean(),
    Match.find({
      tournamentId,
      phase: 'phase1',
    })
      .select('_id result')
      .lean(),
  ]);

  const missing = [];
  const phase1PoolsByName = new Map(
    (Array.isArray(phase1Pools) ? phase1Pools : []).map((pool) => [pool.name, pool])
  );

  PHASE1_POOL_NAMES.forEach((poolName) => {
    const pool = phase1PoolsByName.get(poolName);

    if (!pool) {
      missing.push(`Pool ${poolName} is missing`);
      return;
    }

    const teamIds = normalizeTeamIdList(pool.teamIds);

    if (teamIds.length !== 3) {
      missing.push(`Pool ${poolName} must have exactly 3 teams`);
    }
  });

  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      isFullyFinalized: false,
      hasSufficientOverrides: false,
      placements: null,
    };
  }

  const finalizedMatchCount = phase1Matches.filter((match) => Boolean(match?.result)).length;
  const isFullyFinalized =
    phase1Matches.length === PHASE1_EXPECTED_MATCH_COUNT &&
    finalizedMatchCount === PHASE1_EXPECTED_MATCH_COUNT;

  const phase1PoolOrderOverrides = normalizePoolOverrides(
    tournament?.standingsOverrides?.phase1?.poolOrderOverrides
  );

  const missingOverridePools = [];
  const placementsFromOverrides = {};

  PHASE1_POOL_NAMES.forEach((poolName) => {
    const pool = phase1PoolsByName.get(poolName);
    const poolTeamIds = normalizeTeamIdList(pool?.teamIds);
    const overrideOrder = normalizeTeamIdList(phase1PoolOrderOverrides[poolName]);

    if (!isPermutation(overrideOrder, poolTeamIds)) {
      missingOverridePools.push(poolName);
      return;
    }

    placementsFromOverrides[poolName] = overrideOrder;
  });

  const hasSufficientOverrides = missingOverridePools.length === 0;

  if (!isFullyFinalized && !hasSufficientOverrides) {
    if (phase1Matches.length !== PHASE1_EXPECTED_MATCH_COUNT) {
      missing.push(
        `Phase 1 has ${phase1Matches.length}/${PHASE1_EXPECTED_MATCH_COUNT} scheduled matches`
      );
    } else {
      missing.push(
        `Phase 1 has ${finalizedMatchCount}/${PHASE1_EXPECTED_MATCH_COUNT} finalized matches`
      );
    }

    missing.push(
      `Missing valid phase1 poolOrder overrides for pools: ${missingOverridePools.join(', ')}`
    );

    return {
      ok: false,
      missing,
      isFullyFinalized,
      hasSufficientOverrides,
      placements: null,
    };
  }

  if (!isFullyFinalized && hasSufficientOverrides) {
    return {
      ok: true,
      placements: placementsFromOverrides,
      source: 'overrides',
      isFullyFinalized,
      hasSufficientOverrides,
      missing: [],
    };
  }

  const standings = await computeStandingsBundle(tournamentId, 'phase1');
  const placements = {};
  const standingsByPoolName = new Map(
    (Array.isArray(standings?.pools) ? standings.pools : []).map((pool) => [pool.poolName, pool])
  );
  const standingsErrors = [];

  PHASE1_POOL_NAMES.forEach((poolName) => {
    const poolStandings = standingsByPoolName.get(poolName);
    const rankedTeamIds = normalizeTeamIdList(
      Array.isArray(poolStandings?.teams)
        ? poolStandings.teams.map((team) => team.teamId)
        : []
    );

    if (rankedTeamIds.length !== 3) {
      standingsErrors.push(`Unable to resolve placements for Pool ${poolName}`);
      return;
    }

    placements[poolName] = rankedTeamIds.slice(0, 3);
  });

  if (standingsErrors.length > 0) {
    return {
      ok: false,
      missing: standingsErrors,
      isFullyFinalized,
      hasSufficientOverrides,
      placements: null,
    };
  }

  return {
    ok: true,
    placements,
    source: 'finalized',
    isFullyFinalized,
    hasSufficientOverrides,
    missing: [],
  };
}

async function buildPhase2PoolsFromPhase1Results(tournamentId) {
  const placementResult = await computePhase1PlacementsForPhase2(tournamentId);

  if (!placementResult.ok) {
    return placementResult;
  }

  const playedPairs = await loadFinalizedPhase1PlayedPairs(tournamentId);
  const initialState = buildInitialPhase2State(placementResult.placements);
  const resolved = resolvePhase2Rematches(initialState, playedPairs);
  const pools = buildPhase2PoolPayloadsFromState(resolved.state, resolved.warningsByPool);

  return {
    ok: true,
    pools,
    placements: placementResult.placements,
    source: placementResult.source,
    attempts: resolved.attempts,
    totalConflicts: resolved.totalConflicts,
  };
}

module.exports = {
  MAX_PHASE2_SWAP_ATTEMPTS,
  PHASE1_EXPECTED_MATCH_COUNT,
  PHASE2_MATCH_ORDER,
  PHASE2_POOL_HOME_COURTS,
  PHASE2_POOL_MAPPING,
  PHASE2_POOL_NAMES,
  buildPhase2PoolsFromPhase1Results,
  computePhase1PlacementsForPhase2,
  computeRematchWarningsForPools,
  loadFinalizedPhase1PlayedPairs,
  recomputePhase2RematchWarnings,
  resolvePhase2Rematches,
};

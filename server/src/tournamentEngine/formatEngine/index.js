const Pool = require('../../models/Pool');
const { DEFAULT_15_TEAM_FORMAT_ID } = require('../../tournamentFormats/formatRegistry');
const { getFacilityFromCourt, normalizeCourtCode } = require('../../services/phase1');

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

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

const toPositiveInteger = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.floor(parsed);
};

const unique = (values) => {
  const normalized = [];
  const seen = new Set();

  (Array.isArray(values) ? values : []).forEach((value) => {
    const item = normalizeCourtCode(value);
    if (!item || seen.has(item)) {
      return;
    }

    seen.add(item);
    normalized.push(item);
  });

  return normalized;
};

const normalizeBracketName = (value) =>
  isNonEmptyString(value) ? value.trim().toLowerCase() : 'bracket';

function resolveStage(formatDef, stageKey) {
  if (!formatDef || !Array.isArray(formatDef.stages)) {
    return null;
  }

  return formatDef.stages.find((stage) => stage?.key === stageKey) || null;
}

function resolvePoolPhase(formatDef, stageKey, stageDef) {
  if (stageDef?.type === 'playoffs') {
    return 'playoffs';
  }

  if (formatDef?.id === DEFAULT_15_TEAM_FORMAT_ID && stageKey === 'poolPlay2') {
    return 'phase2';
  }

  return 'phase1';
}

function assignHomeCourts(poolDefinitions, activeCourts) {
  const pools = Array.isArray(poolDefinitions) ? poolDefinitions : [];
  const courts = unique(activeCourts);

  if (courts.length === 0) {
    return pools.map((poolDef) => ({
      ...poolDef,
      homeCourt: null,
    }));
  }

  return pools.map((poolDef, index) => ({
    ...poolDef,
    homeCourt: courts[index % courts.length],
  }));
}

async function instantiatePools(
  tournamentId,
  formatDef,
  stageKey,
  activeCourts,
  options = {}
) {
  const stageDef = resolveStage(formatDef, stageKey);

  if (!stageDef || stageDef.type !== 'poolPlay') {
    return [];
  }

  const normalizedActiveCourts = unique(activeCourts);

  const phase = resolvePoolPhase(formatDef, stageKey, stageDef);
  const clearTeamIds = options.clearTeamIds !== false;
  const poolDefinitions = assignHomeCourts(stageDef.pools || [], normalizedActiveCourts);
  const existingPools = await Pool.find({
    tournamentId,
    phase,
    name: {
      $in: poolDefinitions.map((poolDef) => poolDef.name),
    },
  })
    .select('_id name teamIds')
    .lean();
  const existingByName = new Map(existingPools.map((pool) => [pool.name, pool]));
  const operations = poolDefinitions.map((poolDef) => {
    const requiredTeamCount = toPositiveInteger(poolDef.size);
    const existingPool = existingByName.get(poolDef.name);
    const teamIds = clearTeamIds
      ? []
      : Array.isArray(existingPool?.teamIds)
        ? existingPool.teamIds
        : [];

    return {
      updateOne: {
        filter: {
          tournamentId,
          phase,
          name: poolDef.name,
        },
        update: {
          $set: {
            stageKey,
            requiredTeamCount,
            homeCourt: poolDef.homeCourt || null,
            teamIds,
          },
        },
        upsert: true,
      },
    };
  });

  if (operations.length > 0) {
    await Pool.bulkWrite(operations, { ordered: true });
  }

  const pools = await Pool.find({
    tournamentId,
    phase,
    name: {
      $in: poolDefinitions.map((poolDef) => poolDef.name),
    },
  })
    .populate('teamIds', 'name shortName logoUrl orderIndex seed')
    .lean();
  const orderLookup = new Map(
    poolDefinitions.map((poolDef, index) => [String(poolDef.name), index])
  );

  return pools.sort((left, right) => {
    const leftOrder = orderLookup.get(String(left?.name)) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = orderLookup.get(String(right?.name)) ?? Number.MAX_SAFE_INTEGER;

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return String(left?.name || '').localeCompare(String(right?.name || ''));
  });
}

function resolveOffTeamRef(matchTeamIds, allTeamIds, orderIndexById) {
  const participantSet = new Set(matchTeamIds.map((teamId) => toIdString(teamId)));
  const candidates = allTeamIds
    .filter((teamId) => !participantSet.has(toIdString(teamId)))
    .sort((left, right) => {
      const leftOrder = orderIndexById.get(toIdString(left)) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = orderIndexById.get(toIdString(right)) ?? Number.MAX_SAFE_INTEGER;

      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }

      return String(toIdString(left)).localeCompare(String(toIdString(right)));
    });

  return candidates.length > 0 ? [toIdString(candidates[0])] : [];
}

function buildPoolTeamOrder(poolTeams) {
  const normalizedTeams = (Array.isArray(poolTeams) ? poolTeams : [])
    .map((team, index) => {
      const teamId = toIdString(team?._id || team);
      if (!teamId) {
        return null;
      }

      const explicitOrder = Number(team?.orderIndex);
      const orderIndex =
        Number.isFinite(explicitOrder) && explicitOrder > 0
          ? explicitOrder
          : index + 1;

      return {
        teamId,
        orderIndex,
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.orderIndex !== right.orderIndex) {
        return left.orderIndex - right.orderIndex;
      }

      return left.teamId.localeCompare(right.teamId);
    });

  return {
    orderedTeamIds: normalizedTeams.map((team) => team.teamId),
    orderIndexById: new Map(normalizedTeams.map((team) => [team.teamId, team.orderIndex])),
  };
}

// Deterministic RR templates: { left, right, ref, bye } — indices into orderedTeamIds (0-based positions)
// Pool size 3 schedule (3 matches, no byes):
//   1) 1v3, ref 2  |  2) 2v3, ref 1  |  3) 1v2, ref 3
// Pool size 4 schedule (6 matches, 1 match per block; ref + bye each block):
//   1) 1v3, ref 2, bye 4  |  2) 2v4, ref 1, bye 3  |  3) 1v4, ref 3, bye 2
//   4) 2v3, ref 1, bye 4  |  5) 3v4, ref 2, bye 1  |  6) 1v2, ref 4, bye 3
const RR_TEMPLATES = Object.freeze({
  3: [
    { left: 0, right: 2, ref: 1, bye: null },
    { left: 1, right: 2, ref: 0, bye: null },
    { left: 0, right: 1, ref: 2, bye: null },
  ],
  4: [
    { left: 0, right: 2, ref: 1, bye: 3 },
    { left: 1, right: 3, ref: 0, bye: 2 },
    { left: 0, right: 3, ref: 2, bye: 1 },
    { left: 1, right: 2, ref: 0, bye: 3 },
    { left: 2, right: 3, ref: 1, bye: 0 },
    { left: 0, right: 1, ref: 3, bye: 2 },
  ],
});

function generateRoundRobinMatches(poolTeams, poolSize) {
  const normalizedPoolSize = toPositiveInteger(poolSize);

  if (![3, 4].includes(normalizedPoolSize)) {
    throw new Error('Round robin generation currently supports pool sizes 3 and 4.');
  }

  const { orderedTeamIds } = buildPoolTeamOrder(poolTeams);

  if (orderedTeamIds.length !== normalizedPoolSize) {
    throw new Error(
      `Pool requires ${normalizedPoolSize} teams but received ${orderedTeamIds.length}.`
    );
  }

  const templates = RR_TEMPLATES[normalizedPoolSize];

  return templates.map((template, index) => {
    const teamAId = orderedTeamIds[template.left];
    const teamBId = orderedTeamIds[template.right];
    const offTeamIds = orderedTeamIds.filter(
      (_, teamIndex) => teamIndex !== template.left && teamIndex !== template.right
    );

    return {
      matchIndex: index + 1,
      teamAId,
      teamBId,
      offTeamIds,
      refTeamIds: [orderedTeamIds[template.ref]],
      byeTeamId: template.bye !== null ? orderedTeamIds[template.bye] : null,
    };
  });
}

function scheduleStageMatches(matchesByPool, activeCourts, startRoundBlock = 1) {
  const normalizedStartRoundBlock = toPositiveInteger(startRoundBlock) || 1;
  const pools = Array.isArray(matchesByPool)
    ? matchesByPool.filter((pool) => Array.isArray(pool?.matches) && pool.matches.length > 0)
    : [];

  if (pools.length === 0) {
    return [];
  }

  const normalizedActiveCourts = unique(activeCourts);
  const poolsHaveDistinctHomeCourts =
    pools.length === new Set(pools.map((pool) => normalizeCourtCode(pool.homeCourt))).size;
  const scheduled = [];

  if (poolsHaveDistinctHomeCourts) {
    const maxMatchCount = pools.reduce(
      (maxValue, pool) => Math.max(maxValue, pool.matches.length),
      0
    );

    for (let matchIndex = 0; matchIndex < maxMatchCount; matchIndex += 1) {
      pools.forEach((pool) => {
        const match = pool.matches[matchIndex];
        if (!match) {
          return;
        }

        const court = normalizeCourtCode(pool.homeCourt);
        scheduled.push({
          ...match,
          poolId: pool.poolId || null,
          poolName: pool.poolName || null,
          roundBlock: normalizedStartRoundBlock + matchIndex,
          court,
          facility: getFacilityFromCourt(court),
        });
      });
    }

    return scheduled;
  }

  const orderedCourts =
    normalizedActiveCourts.length > 0
      ? normalizedActiveCourts
      : unique(pools.map((pool) => pool.homeCourt));
  const poolsByCourt = orderedCourts.reduce((lookup, court) => {
    lookup.set(court, []);
    return lookup;
  }, new Map());

  pools.forEach((pool) => {
    const homeCourt = normalizeCourtCode(pool.homeCourt);
    if (!homeCourt) {
      return;
    }

    if (!poolsByCourt.has(homeCourt)) {
      poolsByCourt.set(homeCourt, []);
    }

    poolsByCourt.get(homeCourt).push(pool);
  });

  const nextRoundBlockByCourt = new Map(
    Array.from(poolsByCourt.keys()).map((court) => [court, normalizedStartRoundBlock])
  );

  Array.from(poolsByCourt.entries()).forEach(([court, courtPools]) => {
    courtPools.forEach((pool) => {
      pool.matches.forEach((match) => {
        const nextRoundBlock = nextRoundBlockByCourt.get(court) || normalizedStartRoundBlock;
        scheduled.push({
          ...match,
          poolId: pool.poolId || null,
          poolName: pool.poolName || null,
          roundBlock: nextRoundBlock,
          court,
          facility: getFacilityFromCourt(court),
        });
        nextRoundBlockByCourt.set(court, nextRoundBlock + 1);
      });
    });
  });

  return scheduled.sort((left, right) => {
    if ((left?.roundBlock || 0) !== (right?.roundBlock || 0)) {
      return (left?.roundBlock || 0) - (right?.roundBlock || 0);
    }

    const leftCourt = String(left?.court || '');
    const rightCourt = String(right?.court || '');
    const byCourt = leftCourt.localeCompare(rightCourt);

    if (byCourt !== 0) {
      return byCourt;
    }

    const leftPool = String(left?.poolName || '');
    const rightPool = String(right?.poolName || '');
    return leftPool.localeCompare(rightPool);
  });
}

function buildSingleElimRoundOnePairs(size) {
  const pairingsBySize = {
    4: [
      [1, 4],
      [2, 3],
    ],
    8: [
      [1, 8],
      [4, 5],
      [3, 6],
      [2, 7],
    ],
    16: [
      [1, 16],
      [8, 9],
      [5, 12],
      [4, 13],
      [3, 14],
      [6, 11],
      [7, 10],
      [2, 15],
    ],
  };

  return pairingsBySize[size] || null;
}

function buildPowerOfTwoBracketPlan(bracketKey, seedToTeamId, size) {
  const roundOnePairs = buildSingleElimRoundOnePairs(size);

  if (!roundOnePairs) {
    throw new Error(`Unsupported single elimination bracket size: ${size}`);
  }

  const matches = [];
  let currentRoundMatches = roundOnePairs.map(([seedA, seedB], matchIndex) => ({
    bracket: bracketKey,
    bracketRound: 'R1',
    round: 1,
    bracketMatchKey: `${bracketKey}:R1:M${matchIndex + 1}`,
    seedA,
    seedB,
    teamAId: seedToTeamId.get(seedA) || null,
    teamBId: seedToTeamId.get(seedB) || null,
    teamAFromMatchKey: null,
    teamAFromSlot: null,
    teamBFromMatchKey: null,
    teamBFromSlot: null,
  }));
  matches.push(...currentRoundMatches);

  let round = 2;
  while (currentRoundMatches.length > 1) {
    const nextRoundMatches = [];

    for (let index = 0; index < currentRoundMatches.length; index += 2) {
      const previousA = currentRoundMatches[index];
      const previousB = currentRoundMatches[index + 1];

      nextRoundMatches.push({
        bracket: bracketKey,
        bracketRound: `R${round}`,
        round,
        bracketMatchKey: `${bracketKey}:R${round}:M${Math.floor(index / 2) + 1}`,
        seedA: null,
        seedB: null,
        teamAId: null,
        teamBId: null,
        teamAFromMatchKey: previousA?.bracketMatchKey || null,
        teamAFromSlot: previousA ? 'winner' : null,
        teamBFromMatchKey: previousB?.bracketMatchKey || null,
        teamBFromSlot: previousB ? 'winner' : null,
      });
    }

    matches.push(...nextRoundMatches);
    currentRoundMatches = nextRoundMatches;
    round += 1;
  }

  return matches;
}

function buildSixTeamBracketPlan(bracketKey, seedToTeamId) {
  const roundOneMatchOne = {
    bracket: bracketKey,
    bracketRound: 'R1',
    round: 1,
    bracketMatchKey: `${bracketKey}:R1:M1`,
    seedA: 4,
    seedB: 5,
    teamAId: seedToTeamId.get(4) || null,
    teamBId: seedToTeamId.get(5) || null,
    teamAFromMatchKey: null,
    teamAFromSlot: null,
    teamBFromMatchKey: null,
    teamBFromSlot: null,
  };
  const roundOneMatchTwo = {
    bracket: bracketKey,
    bracketRound: 'R1',
    round: 1,
    bracketMatchKey: `${bracketKey}:R1:M2`,
    seedA: 3,
    seedB: 6,
    teamAId: seedToTeamId.get(3) || null,
    teamBId: seedToTeamId.get(6) || null,
    teamAFromMatchKey: null,
    teamAFromSlot: null,
    teamBFromMatchKey: null,
    teamBFromSlot: null,
  };
  const semiFinalOne = {
    bracket: bracketKey,
    bracketRound: 'R2',
    round: 2,
    bracketMatchKey: `${bracketKey}:R2:M1`,
    seedA: 1,
    seedB: null,
    teamAId: seedToTeamId.get(1) || null,
    teamBId: null,
    teamAFromMatchKey: null,
    teamAFromSlot: null,
    teamBFromMatchKey: roundOneMatchOne.bracketMatchKey,
    teamBFromSlot: 'winner',
  };
  const semiFinalTwo = {
    bracket: bracketKey,
    bracketRound: 'R2',
    round: 2,
    bracketMatchKey: `${bracketKey}:R2:M2`,
    seedA: 2,
    seedB: null,
    teamAId: seedToTeamId.get(2) || null,
    teamBId: null,
    teamAFromMatchKey: null,
    teamAFromSlot: null,
    teamBFromMatchKey: roundOneMatchTwo.bracketMatchKey,
    teamBFromSlot: 'winner',
  };
  const final = {
    bracket: bracketKey,
    bracketRound: 'R3',
    round: 3,
    bracketMatchKey: `${bracketKey}:R3:M1`,
    seedA: null,
    seedB: null,
    teamAId: null,
    teamBId: null,
    teamAFromMatchKey: semiFinalOne.bracketMatchKey,
    teamAFromSlot: 'winner',
    teamBFromMatchKey: semiFinalTwo.bracketMatchKey,
    teamBFromSlot: 'winner',
  };

  return [roundOneMatchOne, roundOneMatchTwo, semiFinalOne, semiFinalTwo, final];
}

function generatePlayoffsFromFormat(tournamentId, bracketDef, overallSeeds) {
  const bracketName = bracketDef?.name || 'Bracket';
  const bracketKey = normalizeBracketName(bracketName);
  const bracketSize = toPositiveInteger(bracketDef?.size);
  const bracketType = String(bracketDef?.type || '');
  const seedOrder = Array.isArray(bracketDef?.seedsFromOverall)
    ? bracketDef.seedsFromOverall
    : [];

  if (!bracketSize || seedOrder.length === 0) {
    throw new Error(`Invalid bracket definition for ${bracketName}.`);
  }

  const seedToTeamId = new Map();
  for (let seed = 1; seed <= bracketSize; seed += 1) {
    const overallSeed = seedOrder[seed - 1];
    const seedIndex = toPositiveInteger(overallSeed);
    const teamId = seedIndex ? toIdString(overallSeeds[seedIndex - 1]) : null;
    if (teamId) {
      seedToTeamId.set(seed, teamId);
    }
  }

  let matches;
  if (bracketType === 'singleElim') {
    matches = buildPowerOfTwoBracketPlan(bracketKey, seedToTeamId, bracketSize);
  } else if (bracketType === 'singleElimWithByes' && bracketSize === 6) {
    matches = buildSixTeamBracketPlan(bracketKey, seedToTeamId);
  } else {
    throw new Error(`Unsupported bracket type ${bracketType} for ${bracketName}.`);
  }

  return matches.map((match) => ({
    tournamentId,
    ...match,
  }));
}

function schedulePlayoffMatches(matchPlans, activeCourts, startRoundBlock = 1) {
  const normalizedCourts = unique(activeCourts);
  const normalizedStartRoundBlock = toPositiveInteger(startRoundBlock) || 1;

  if (!Array.isArray(matchPlans) || matchPlans.length === 0) {
    return [];
  }

  if (normalizedCourts.length === 0) {
    throw new Error('At least one active court is required for playoff scheduling.');
  }

  const matchesByRound = new Map();
  matchPlans.forEach((matchPlan) => {
    const round = toPositiveInteger(matchPlan?.round) || 1;
    if (!matchesByRound.has(round)) {
      matchesByRound.set(round, []);
    }
    matchesByRound.get(round).push(matchPlan);
  });

  const scheduledMatches = [];
  let currentRoundBlock = normalizedStartRoundBlock;

  Array.from(matchesByRound.keys())
    .sort((left, right) => left - right)
    .forEach((round) => {
      const roundMatches = (matchesByRound.get(round) || []).sort((left, right) => {
        const leftBracket = String(left?.bracket || '');
        const rightBracket = String(right?.bracket || '');
        const byBracket = leftBracket.localeCompare(rightBracket);

        if (byBracket !== 0) {
          return byBracket;
        }

        return String(left?.bracketMatchKey || '').localeCompare(
          String(right?.bracketMatchKey || '')
        );
      });

      for (let index = 0; index < roundMatches.length; index += normalizedCourts.length) {
        const chunk = roundMatches.slice(index, index + normalizedCourts.length);

        chunk.forEach((matchPlan, chunkIndex) => {
          const court = normalizedCourts[chunkIndex];
          scheduledMatches.push({
            ...matchPlan,
            roundBlock: currentRoundBlock,
            court,
            facility: getFacilityFromCourt(court),
          });
        });

        currentRoundBlock += 1;
      }
    });

  return scheduledMatches;
}

module.exports = {
  generatePlayoffsFromFormat,
  generateRoundRobinMatches,
  instantiatePools,
  resolvePoolPhase,
  resolveStage,
  schedulePlayoffMatches,
  scheduleStageMatches,
  toIdString,
};

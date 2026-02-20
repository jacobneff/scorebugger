const RR_TEMPLATES = Object.freeze({
  3: [
    { a: 0, b: 2, ref: 1, bye: null },
    { a: 1, b: 2, ref: 0, bye: null },
    { a: 0, b: 1, ref: 2, bye: null },
  ],
  4: [
    { a: 0, b: 2, ref: 1, bye: 3 },
    { a: 1, b: 3, ref: 0, bye: 2 },
    { a: 0, b: 3, ref: 2, bye: 1 },
    { a: 1, b: 2, ref: 0, bye: 3 },
    { a: 2, b: 3, ref: 1, bye: 0 },
    { a: 0, b: 1, ref: 3, bye: 2 },
  ],
});

const DEFAULT_COURTS = Object.freeze(['SRC-1', 'SRC-2', 'SRC-3', 'VC-1', 'VC-2']);

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const normalizeCourtCode = (value) =>
  typeof value === 'string' ? value.trim().toUpperCase() : '';

const uniqueCourts = (values) => {
  const seen = new Set();

  return (Array.isArray(values) ? values : [])
    .map((entry) => normalizeCourtCode(entry))
    .filter((entry) => {
      if (!entry || seen.has(entry)) {
        return false;
      }
      seen.add(entry);
      return true;
    });
};

const getPoolStages = (formatDef) =>
  Array.isArray(formatDef?.stages)
    ? formatDef.stages.filter((stage) => stage?.type === 'poolPlay')
    : [];

const getStageByType = (formatDef, stageType) =>
  Array.isArray(formatDef?.stages)
    ? formatDef.stages.find((stage) => stage?.type === stageType) || null
    : null;

const getPoolRoundCount = (poolSize) => {
  const template = RR_TEMPLATES[Number(poolSize)];
  return Array.isArray(template) ? template.length : 0;
};

const resolveBracketLabel = (name, fallback = 'Bracket') => {
  if (isNonEmptyString(name)) {
    return name.trim();
  }
  return fallback;
};

const assignPoolHomeCourts = (poolDefs, activeCourts) => {
  const courts = uniqueCourts(activeCourts);
  const courtCycle = courts.length > 0 ? courts : [...DEFAULT_COURTS];

  return (Array.isArray(poolDefs) ? poolDefs : []).map((poolDef, index) => ({
    name: String(poolDef?.name || ''),
    size: Number(poolDef?.size || 0),
    homeCourt: courtCycle[index % courtCycle.length] || '',
  }));
};

const buildPoolMatchTemplates = (poolName, poolSize) => {
  const template = RR_TEMPLATES[Number(poolSize)];
  if (!poolName || !Array.isArray(template)) {
    return [];
  }

  return template.map((entry, index) => ({
    id: `${poolName}-rr-${index + 1}`,
    poolName,
    matchupLabel: `${poolName}${entry.a + 1} vs ${poolName}${entry.b + 1}`,
    refLabel: `${poolName}${entry.ref + 1}`,
    byeLabel: entry.bye !== null ? `${poolName}${entry.bye + 1}` : null,
  }));
};

const sortByRoundThenCourt = (rows) =>
  [...(Array.isArray(rows) ? rows : [])].sort((left, right) => {
    const byRound = Number(left?.roundBlock || 0) - Number(right?.roundBlock || 0);
    if (byRound !== 0) {
      return byRound;
    }

    const byCourt = String(left?.court || '').localeCompare(String(right?.court || ''));
    if (byCourt !== 0) {
      return byCourt;
    }

    return String(left?.id || '').localeCompare(String(right?.id || ''));
  });

const buildPoolScheduleRows = ({ poolStageLabel, assignedPools }) => {
  const pools = (Array.isArray(assignedPools) ? assignedPools : []).map((pool) => ({
    ...pool,
    matches: buildPoolMatchTemplates(pool.name, pool.size),
  }));

  if (pools.length === 0) {
    return [];
  }

  const poolsHaveDistinctHomeCourts =
    pools.length === new Set(pools.map((pool) => normalizeCourtCode(pool.homeCourt))).size;
  const rows = [];

  if (poolsHaveDistinctHomeCourts) {
    const maxMatchCount = pools.reduce(
      (maxValue, pool) => Math.max(maxValue, Array.isArray(pool.matches) ? pool.matches.length : 0),
      0
    );

    for (let matchIndex = 0; matchIndex < maxMatchCount; matchIndex += 1) {
      pools.forEach((pool) => {
        const match = pool.matches[matchIndex];
        if (!match) {
          return;
        }

        rows.push({
          id: `${pool.name}-scheduled-${matchIndex + 1}`,
          roundBlock: matchIndex + 1,
          court: pool.homeCourt,
          stageLabel: poolStageLabel,
          matchLabel: match.matchupLabel,
          refLabel: match.refLabel,
          byeLabel: match.byeLabel,
        });
      });
    }

    return sortByRoundThenCourt(rows);
  }

  const poolsByCourt = new Map();
  pools.forEach((pool) => {
    const court = normalizeCourtCode(pool.homeCourt) || 'SRC-1';
    if (!poolsByCourt.has(court)) {
      poolsByCourt.set(court, []);
    }
    poolsByCourt.get(court).push(pool);
  });

  Array.from(poolsByCourt.entries()).forEach(([court, courtPools]) => {
    let nextRound = 1;
    courtPools.forEach((pool) => {
      pool.matches.forEach((match, index) => {
        rows.push({
          id: `${pool.name}-scheduled-${index + 1}`,
          roundBlock: nextRound,
          court,
          stageLabel: poolStageLabel,
          matchLabel: match.matchupLabel,
          refLabel: match.refLabel,
          byeLabel: match.byeLabel,
        });
        nextRound += 1;
      });
    });
  });

  return sortByRoundThenCourt(rows);
};

const buildCrossoverRows = ({
  crossoverStage,
  poolDefsByName,
  crossoverCourts,
}) => {
  if (
    !crossoverStage ||
    !Array.isArray(crossoverStage.fromPools) ||
    crossoverStage.fromPools.length !== 2
  ) {
    return [];
  }

  const leftName = String(crossoverStage.fromPools[0] || '').trim();
  const rightName = String(crossoverStage.fromPools[1] || '').trim();
  if (!leftName || !rightName) {
    return [];
  }

  const leftSize = Number(poolDefsByName.get(leftName)?.size || 0);
  const rightSize = Number(poolDefsByName.get(rightName)?.size || 0);
  const pairingCount = Math.min(leftSize, rightSize);
  if (!Number.isFinite(pairingCount) || pairingCount <= 0) {
    return [];
  }

  const sourceRoundCount = Math.max(getPoolRoundCount(leftSize), getPoolRoundCount(rightSize));
  const startRoundBlock = sourceRoundCount + 1;
  const stageLabel = String(crossoverStage.displayName || 'Crossover');
  const normalizedCourts = uniqueCourts(crossoverCourts);
  const courts = normalizedCourts.length > 0 ? normalizedCourts : ['SRC-1'];

  const getRoundBlock = (index) => {
    if (courts.length >= 2) {
      if (index <= 1) return startRoundBlock;
      return startRoundBlock + (index - 1);
    }
    return startRoundBlock + index;
  };

  const getCourt = (index) => {
    if (courts.length >= 2) {
      if (index === 0) return courts[0];
      if (index === 1) return courts[1];
      return courts[0];
    }
    return courts[0];
  };

  const getRefLabel = (index) => {
    if (index === 0) return leftSize >= 2 ? `${leftName}2` : null;
    if (index === 1) return `${rightName}${pairingCount}`;
    if (index === 2) return rightSize >= 2 ? `${rightName}2` : null;
    return null;
  };

  const getByeLabel = (index) => {
    if (pairingCount !== 3) {
      return null;
    }
    if (index === 0) {
      return `${leftName}3`;
    }
    if (index === 2) {
      return `${leftName}1, ${leftName}2, ${rightName}1`;
    }
    return null;
  };

  const rows = Array.from({ length: pairingCount }, (_, index) => ({
    id: `${leftName}-${rightName}-crossover-${index + 1}`,
    roundBlock: getRoundBlock(index),
    court: getCourt(index),
    stageLabel,
    matchLabel: `${leftName}${index + 1} vs ${rightName}${index + 1}`,
    refLabel: getRefLabel(index),
    byeLabel: getByeLabel(index),
  }));

  return sortByRoundThenCourt(rows);
};

const roundOnePairsForSize = (size) => {
  const lookup = {
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

  return lookup[size] || null;
};

const buildPowerOfTwoBracketPlan = (bracketLabel, bracketSize) => {
  const pairs = roundOnePairsForSize(bracketSize);
  if (!pairs) {
    return [];
  }

  const matches = [];
  let currentRound = pairs.map(([seedA, seedB], index) => ({
    bracketLabel,
    round: 1,
    matchNo: index + 1,
    seedA,
    seedB,
    fromA: null,
    fromB: null,
  }));
  matches.push(...currentRound);

  let round = 2;
  while (currentRound.length > 1) {
    const nextRound = [];
    for (let index = 0; index < currentRound.length; index += 2) {
      const left = currentRound[index];
      const right = currentRound[index + 1];
      if (!left || !right) {
        continue;
      }

      nextRound.push({
        bracketLabel,
        round,
        matchNo: Math.floor(index / 2) + 1,
        seedA: null,
        seedB: null,
        fromA: { round: left.round, matchNo: left.matchNo },
        fromB: { round: right.round, matchNo: right.matchNo },
      });
    }

    matches.push(...nextRound);
    currentRound = nextRound;
    round += 1;
  }

  return matches;
};

const buildSixTeamBracketPlan = (bracketLabel) => [
  {
    bracketLabel,
    round: 1,
    matchNo: 1,
    seedA: 4,
    seedB: 5,
    fromA: null,
    fromB: null,
  },
  {
    bracketLabel,
    round: 1,
    matchNo: 2,
    seedA: 3,
    seedB: 6,
    fromA: null,
    fromB: null,
  },
  {
    bracketLabel,
    round: 2,
    matchNo: 1,
    seedA: 1,
    seedB: null,
    fromA: null,
    fromB: { round: 1, matchNo: 1 },
  },
  {
    bracketLabel,
    round: 2,
    matchNo: 2,
    seedA: 2,
    seedB: null,
    fromA: null,
    fromB: { round: 1, matchNo: 2 },
  },
  {
    bracketLabel,
    round: 3,
    matchNo: 1,
    seedA: null,
    seedB: null,
    fromA: { round: 2, matchNo: 1 },
    fromB: { round: 2, matchNo: 2 },
  },
];

const buildOduFiveTeamOpsBracketPlan = (bracketLabel) => [
  {
    bracketLabel,
    round: 1,
    matchNo: 1,
    seedA: 4,
    seedB: 5,
    fromA: null,
    fromB: null,
  },
  {
    bracketLabel,
    round: 1,
    matchNo: 2,
    seedA: 2,
    seedB: 3,
    fromA: null,
    fromB: null,
  },
  {
    bracketLabel,
    round: 2,
    matchNo: 1,
    seedA: 1,
    seedB: null,
    fromA: null,
    fromB: { round: 1, matchNo: 1 },
  },
  {
    bracketLabel,
    round: 3,
    matchNo: 1,
    seedA: null,
    seedB: null,
    fromA: { round: 2, matchNo: 1 },
    fromB: { round: 1, matchNo: 2 },
  },
];

const buildBracketPlan = (bracketDef) => {
  const bracketLabel = resolveBracketLabel(bracketDef?.name);
  const bracketType = String(bracketDef?.type || '').trim();
  const bracketSize = Number(bracketDef?.size || 0);

  if (bracketType === 'singleElim') {
    return buildPowerOfTwoBracketPlan(bracketLabel, bracketSize);
  }

  if (bracketType === 'singleElimWithByes' && bracketSize === 6) {
    return buildSixTeamBracketPlan(bracketLabel);
  }

  if (bracketType === 'oduFiveTeamOps' && bracketSize === 5) {
    return buildOduFiveTeamOpsBracketPlan(bracketLabel);
  }

  return [];
};

const formatPlayoffSideLabel = ({ bracketLabel, seed, fromMatch }) => {
  if (Number.isFinite(Number(seed))) {
    return `${bracketLabel} ${Number(seed)}`;
  }

  if (fromMatch?.round && fromMatch?.matchNo) {
    return `W(${bracketLabel} R${fromMatch.round} M${fromMatch.matchNo})`;
  }

  return 'TBD';
};

const buildPlayoffRows = ({ playoffStage, activeCourts, startRoundBlock }) => {
  const brackets = Array.isArray(playoffStage?.brackets) ? playoffStage.brackets : [];
  if (brackets.length === 0) {
    return [];
  }

  const bracketOrderLookup = new Map(
    brackets.map((bracket, index) => [resolveBracketLabel(bracket?.name), index])
  );
  const plans = brackets.flatMap((bracketDef) => buildBracketPlan(bracketDef));
  const courts = uniqueCourts(activeCourts);
  const schedulingCourts = courts.length > 0 ? courts : ['SRC-1'];
  const byRound = new Map();

  plans.forEach((plan) => {
    if (!byRound.has(plan.round)) {
      byRound.set(plan.round, []);
    }
    byRound.get(plan.round).push(plan);
  });

  let currentRoundBlock = Number.isFinite(Number(startRoundBlock))
    ? Math.max(1, Math.floor(Number(startRoundBlock)))
    : 1;
  const rows = [];

  Array.from(byRound.keys())
    .sort((left, right) => left - right)
    .forEach((round) => {
      const roundMatches = (byRound.get(round) || []).sort((left, right) => {
        const leftOrder =
          bracketOrderLookup.get(resolveBracketLabel(left.bracketLabel)) ?? Number.MAX_SAFE_INTEGER;
        const rightOrder =
          bracketOrderLookup.get(resolveBracketLabel(right.bracketLabel)) ?? Number.MAX_SAFE_INTEGER;

        if (leftOrder !== rightOrder) {
          return leftOrder - rightOrder;
        }

        return Number(left.matchNo || 0) - Number(right.matchNo || 0);
      });

      for (let index = 0; index < roundMatches.length; index += schedulingCourts.length) {
        const chunk = roundMatches.slice(index, index + schedulingCourts.length);
        chunk.forEach((match, chunkIndex) => {
          const bracketLabel = resolveBracketLabel(match.bracketLabel);
          const teamALabel = formatPlayoffSideLabel({
            bracketLabel,
            seed: match.seedA,
            fromMatch: match.fromA,
          });
          const teamBLabel = formatPlayoffSideLabel({
            bracketLabel,
            seed: match.seedB,
            fromMatch: match.fromB,
          });

          rows.push({
            id: `${bracketLabel}-R${round}-M${match.matchNo}`,
            roundBlock: currentRoundBlock,
            roundLabel: `R${round}`,
            court: schedulingCourts[chunkIndex],
            bracketLabel,
            matchupLabel: `${teamALabel} vs ${teamBLabel}`,
          });
        });

        currentRoundBlock += 1;
      }
    });

  return sortByRoundThenCourt(rows);
};

export function buildFormatPreview({ formatDef, activeCourts }) {
  if (!formatDef || typeof formatDef !== 'object') {
    return {
      poolScheduleRows: [],
      playoffRows: [],
    };
  }

  const normalizedCourts = uniqueCourts(activeCourts);
  const schedulingCourts = normalizedCourts.length > 0 ? normalizedCourts : [...DEFAULT_COURTS];
  const poolStages = getPoolStages(formatDef);
  const firstPoolStage = poolStages[0] || null;
  const poolDefs = Array.isArray(firstPoolStage?.pools) ? firstPoolStage.pools : [];
  const assignedPools = assignPoolHomeCourts(poolDefs, schedulingCourts);
  const poolStageLabel = String(firstPoolStage?.displayName || 'Pool Play');
  const poolRows = buildPoolScheduleRows({
    poolStageLabel,
    assignedPools,
  });

  const poolDefsByName = new Map(assignedPools.map((pool) => [pool.name, pool]));
  const crossoverRows = buildCrossoverRows({
    crossoverStage: getStageByType(formatDef, 'crossover'),
    poolDefsByName,
    crossoverCourts: schedulingCourts,
  });

  const poolScheduleRows = sortByRoundThenCourt([...poolRows, ...crossoverRows]);
  const maxPoolRound = poolScheduleRows.reduce(
    (maxValue, row) => Math.max(maxValue, Number(row?.roundBlock || 0)),
    0
  );
  const playoffRows = buildPlayoffRows({
    playoffStage: getStageByType(formatDef, 'playoffs'),
    activeCourts: schedulingCourts,
    startRoundBlock: maxPoolRound > 0 ? maxPoolRound + 1 : 1,
  });

  return {
    poolScheduleRows,
    playoffRows,
  };
}

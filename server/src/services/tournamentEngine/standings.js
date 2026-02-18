const Match = require('../../models/Match');
const Pool = require('../../models/Pool');
const Tournament = require('../../models/Tournament');
const TournamentTeam = require('../../models/TournamentTeam');

const SUPPORTED_PHASES = new Set(['phase1', 'phase2', 'cumulative']);
const PHASES_WITH_POOLS = new Set(['phase1', 'phase2']);
const CUMULATIVE_PHASE_MATCHES = ['phase1', 'phase2'];
const REQUIRED_SET_WINS = 2;
const MAX_BEST_OF_THREE_SETS = 3;

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

const clampNonNegativeInt = (value, fallback = 0) => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, Math.round(parsed));
};

function normalizeSetScores(set, index) {
  if (!Array.isArray(set?.scores) || set.scores.length !== 2) {
    throw new Error(`Set ${index + 1} is missing valid scores`);
  }

  const [rawA, rawB] = set.scores;
  const a = clampNonNegativeInt(rawA, -1);
  const b = clampNonNegativeInt(rawB, -1);

  if (a < 0 || b < 0) {
    throw new Error(`Set ${index + 1} is missing valid scores`);
  }

  return { setNo: index + 1, a, b };
}

function computeMatchSnapshot(match, scoreboard) {
  const teamAId = match?.teamAId;
  const teamBId = match?.teamBId;

  if (!teamAId || !teamBId) {
    throw new Error('Match is missing team assignments');
  }

  if (!match?.scoreboardId) {
    throw new Error('Match does not have a linked scoreboard');
  }

  if (!Array.isArray(scoreboard?.sets)) {
    throw new Error('Scoreboard does not contain completed set history');
  }

  const setScores = scoreboard.sets.map(normalizeSetScores);

  if (setScores.length < REQUIRED_SET_WINS || setScores.length > MAX_BEST_OF_THREE_SETS) {
    throw new Error('Scoreboard must contain 2 or 3 completed sets for a best-of-3 match');
  }

  let setsWonA = 0;
  let setsWonB = 0;
  let pointsForA = 0;
  let pointsForB = 0;

  setScores.forEach((set) => {
    if (set.a === set.b) {
      throw new Error(`Set ${set.setNo} ended in a tie and cannot be finalized`);
    }

    pointsForA += set.a;
    pointsForB += set.b;

    if (set.a > set.b) {
      setsWonA += 1;
    } else {
      setsWonB += 1;
    }
  });

  if (
    (setsWonA !== REQUIRED_SET_WINS && setsWonB !== REQUIRED_SET_WINS) ||
    (setsWonA === REQUIRED_SET_WINS && setsWonB === REQUIRED_SET_WINS)
  ) {
    throw new Error('Scoreboard does not represent a completed best-of-3 outcome');
  }

  const winnerTeamId = setsWonA > setsWonB ? teamAId : teamBId;
  const loserTeamId = setsWonA > setsWonB ? teamBId : teamAId;

  return {
    winnerTeamId,
    loserTeamId,
    setsWonA,
    setsWonB,
    setsPlayed: setScores.length,
    pointsForA,
    pointsAgainstA: pointsForB,
    pointsForB,
    pointsAgainstB: pointsForA,
    setScores,
  };
}

function createEmptyStats() {
  return {
    matchesPlayed: 0,
    matchesWon: 0,
    matchesLost: 0,
    setsWon: 0,
    setsLost: 0,
    setsPlayed: 0,
    pointsFor: 0,
    pointsAgainst: 0,
  };
}

function ensureStatBucket(statsByTeamId, teamId) {
  if (!statsByTeamId.has(teamId)) {
    statsByTeamId.set(teamId, createEmptyStats());
  }

  return statsByTeamId.get(teamId);
}

function mergeMatchIntoStats(statsByTeamId, match) {
  if (!match?.result) {
    return;
  }

  const teamAId = toIdString(match.teamAId);
  const teamBId = toIdString(match.teamBId);

  if (!teamAId || !teamBId) {
    return;
  }

  if (!statsByTeamId.has(teamAId) || !statsByTeamId.has(teamBId)) {
    return;
  }

  const result = match.result;
  const setsWonA = clampNonNegativeInt(result.setsWonA);
  const setsWonB = clampNonNegativeInt(result.setsWonB);
  const setsPlayed = clampNonNegativeInt(result.setsPlayed, setsWonA + setsWonB);
  const pointsForA = clampNonNegativeInt(result.pointsForA);
  const pointsAgainstA = clampNonNegativeInt(result.pointsAgainstA);
  const pointsForB = clampNonNegativeInt(result.pointsForB);
  const pointsAgainstB = clampNonNegativeInt(result.pointsAgainstB);

  let winnerTeamId = toIdString(result.winnerTeamId);

  if (!winnerTeamId && setsWonA !== setsWonB) {
    winnerTeamId = setsWonA > setsWonB ? teamAId : teamBId;
  }

  const teamAStats = ensureStatBucket(statsByTeamId, teamAId);
  const teamBStats = ensureStatBucket(statsByTeamId, teamBId);

  teamAStats.matchesPlayed += 1;
  teamBStats.matchesPlayed += 1;

  if (winnerTeamId === teamAId) {
    teamAStats.matchesWon += 1;
    teamBStats.matchesLost += 1;
  } else if (winnerTeamId === teamBId) {
    teamBStats.matchesWon += 1;
    teamAStats.matchesLost += 1;
  }

  teamAStats.setsWon += setsWonA;
  teamAStats.setsLost += setsWonB;
  teamAStats.setsPlayed += setsPlayed;
  teamAStats.pointsFor += pointsForA;
  teamAStats.pointsAgainst += pointsAgainstA;

  teamBStats.setsWon += setsWonB;
  teamBStats.setsLost += setsWonA;
  teamBStats.setsPlayed += setsPlayed;
  teamBStats.pointsFor += pointsForB;
  teamBStats.pointsAgainst += pointsAgainstB;
}

const compareRatiosDesc = (aWon, aPlayed, bWon, bPlayed) => {
  const left = aWon * bPlayed;
  const right = bWon * aPlayed;

  if (left === right) {
    return 0;
  }

  return left > right ? -1 : 1;
};

const comparePrimaryCriteria = (teamA, teamB) => {
  if (teamA.matchesWon !== teamB.matchesWon) {
    return teamB.matchesWon - teamA.matchesWon;
  }

  if (teamA.matchesLost !== teamB.matchesLost) {
    return teamA.matchesLost - teamB.matchesLost;
  }

  const setPctCompare = compareRatiosDesc(
    teamA.setsWon,
    Math.max(teamA.setsPlayed, 1),
    teamB.setsWon,
    Math.max(teamB.setsPlayed, 1)
  );

  if (setPctCompare !== 0) {
    return setPctCompare;
  }

  if (teamA.pointDiff !== teamB.pointDiff) {
    return teamB.pointDiff - teamA.pointDiff;
  }

  return 0;
};

const hasSamePrimaryCriteria = (teamA, teamB) =>
  comparePrimaryCriteria(teamA, teamB) === 0;

const compareFallbackIdentity = (teamA, teamB) => {
  const aName = String(teamA.shortName || teamA.name || '');
  const bName = String(teamB.shortName || teamB.name || '');
  const byName = aName.localeCompare(bName);

  if (byName !== 0) {
    return byName;
  }

  return String(teamA.teamId).localeCompare(String(teamB.teamId));
};

function getHeadToHeadWinner(teamAId, teamBId, matches) {
  let teamAWins = 0;
  let teamBWins = 0;

  matches.forEach((match) => {
    const matchTeamAId = toIdString(match.teamAId);
    const matchTeamBId = toIdString(match.teamBId);

    const samePair =
      (matchTeamAId === teamAId && matchTeamBId === teamBId) ||
      (matchTeamAId === teamBId && matchTeamBId === teamAId);

    if (!samePair) {
      return;
    }

    const winnerTeamId = toIdString(match.result?.winnerTeamId);

    if (winnerTeamId === teamAId) {
      teamAWins += 1;
    } else if (winnerTeamId === teamBId) {
      teamBWins += 1;
    }
  });

  if (teamAWins === 0 && teamBWins === 0) {
    return null;
  }

  if (teamAWins === teamBWins) {
    return null;
  }

  return teamAWins > teamBWins ? teamAId : teamBId;
}

function applyTieBreakers(entries, matches, overrideOrder) {
  if (!Array.isArray(entries) || entries.length <= 1) {
    return entries;
  }

  const overrideIndex = Array.isArray(overrideOrder)
    ? new Map(overrideOrder.map((teamId, index) => [teamId, index]))
    : null;
  const resolved = [];
  let cursor = 0;

  while (cursor < entries.length) {
    const tiedGroup = [entries[cursor]];
    let nextIndex = cursor + 1;

    while (
      nextIndex < entries.length &&
      hasSamePrimaryCriteria(entries[cursor], entries[nextIndex])
    ) {
      tiedGroup.push(entries[nextIndex]);
      nextIndex += 1;
    }

    let orderedGroup = [...tiedGroup];

    if (orderedGroup.length === 2) {
      const [left, right] = orderedGroup;
      const headToHeadWinner = getHeadToHeadWinner(left.teamId, right.teamId, matches);

      if (headToHeadWinner === right.teamId) {
        orderedGroup = [right, left];
      }
    }

    if (
      overrideIndex &&
      orderedGroup.length > 1 &&
      orderedGroup.every((entry) => overrideIndex.has(entry.teamId))
    ) {
      orderedGroup.sort(
        (teamA, teamB) => overrideIndex.get(teamA.teamId) - overrideIndex.get(teamB.teamId)
      );
    }

    resolved.push(...orderedGroup);
    cursor = nextIndex;
  }

  return resolved;
}

function buildStandingsEntries({ teamIds, teamLookup, matches, overrideOrder }) {
  const statsByTeamId = new Map(teamIds.map((teamId) => [teamId, createEmptyStats()]));

  matches.forEach((match) => {
    mergeMatchIntoStats(statsByTeamId, match);
  });

  const baseEntries = teamIds.map((teamId) => {
    const team = teamLookup.get(teamId) || {};
    const stats = statsByTeamId.get(teamId) || createEmptyStats();
    const setPct = stats.setsPlayed > 0 ? stats.setsWon / stats.setsPlayed : 0;
    const pointDiff = stats.pointsFor - stats.pointsAgainst;

    return {
      teamId,
      name: team.name || '',
      shortName: team.shortName || '',
      seed: team.seed ?? null,
      matchesPlayed: stats.matchesPlayed,
      matchesWon: stats.matchesWon,
      matchesLost: stats.matchesLost,
      setsWon: stats.setsWon,
      setsLost: stats.setsLost,
      setsPlayed: stats.setsPlayed,
      setPct: Number(setPct.toFixed(4)),
      pointsFor: stats.pointsFor,
      pointsAgainst: stats.pointsAgainst,
      pointDiff,
    };
  });

  const sortedByCriteria = baseEntries.sort((teamA, teamB) => {
    const primary = comparePrimaryCriteria(teamA, teamB);

    if (primary !== 0) {
      return primary;
    }

    return compareFallbackIdentity(teamA, teamB);
  });

  return applyTieBreakers(sortedByCriteria, matches, overrideOrder).map((entry, index) => ({
    ...entry,
    rank: index + 1,
  }));
}

function normalizePoolOrderOverrides(rawPoolOverrides) {
  if (!rawPoolOverrides) {
    return {};
  }

  if (rawPoolOverrides instanceof Map) {
    return Object.fromEntries(
      Array.from(rawPoolOverrides.entries()).map(([poolName, teamIds]) => [
        poolName,
        Array.isArray(teamIds) ? teamIds.map((teamId) => toIdString(teamId)).filter(Boolean) : [],
      ])
    );
  }

  if (typeof rawPoolOverrides === 'object') {
    return Object.fromEntries(
      Object.entries(rawPoolOverrides).map(([poolName, teamIds]) => [
        poolName,
        Array.isArray(teamIds) ? teamIds.map((teamId) => toIdString(teamId)).filter(Boolean) : [],
      ])
    );
  }

  return {};
}

function normalizePhaseOverrides(tournament, phase) {
  const phaseOverrides = tournament?.standingsOverrides?.[phase];

  if (!phaseOverrides) {
    return {
      poolOrderOverrides: {},
      overallOrderOverrides: [],
    };
  }

  return {
    poolOrderOverrides: normalizePoolOrderOverrides(phaseOverrides.poolOrderOverrides),
    overallOrderOverrides: Array.isArray(phaseOverrides.overallOrderOverrides)
      ? phaseOverrides.overallOrderOverrides
          .map((teamId) => toIdString(teamId))
          .filter(Boolean)
      : [],
  };
}

function computePoolStandingsFromData({ pools, teams, matches, phaseOverrides }) {
  const teamLookup = new Map(
    (Array.isArray(teams) ? teams : []).map((team) => [toIdString(team._id), team])
  );
  const finalizedMatches = Array.isArray(matches) ? matches.filter((match) => Boolean(match?.result)) : [];
  const poolOrderOverrides = phaseOverrides?.poolOrderOverrides || {};

  return (Array.isArray(pools) ? pools : [])
    .map((pool) => {
      const poolId = toIdString(pool._id);
      const teamIds = Array.isArray(pool.teamIds)
        ? pool.teamIds.map((teamId) => toIdString(teamId)).filter(Boolean)
        : [];
      const poolMatches = finalizedMatches.filter((match) => toIdString(match.poolId) === poolId);
      const overrideOrder = Array.isArray(poolOrderOverrides[pool.name])
        ? poolOrderOverrides[pool.name]
        : null;

      const teamsForPool = buildStandingsEntries({
        teamIds,
        teamLookup,
        matches: poolMatches,
        overrideOrder,
      });

      return {
        poolId,
        poolName: pool.name,
        teams: teamsForPool,
      };
    })
    .sort((poolA, poolB) => String(poolA.poolName).localeCompare(String(poolB.poolName)));
}

function computeOverallStandingsFromData({ teams, matches, phaseOverrides }) {
  const teamList = Array.isArray(teams) ? teams : [];
  const teamLookup = new Map(teamList.map((team) => [toIdString(team._id), team]));
  const teamIds = teamList.map((team) => toIdString(team._id)).filter(Boolean);
  const finalizedMatches = Array.isArray(matches) ? matches.filter((match) => Boolean(match?.result)) : [];
  const overallOrderOverrides = Array.isArray(phaseOverrides?.overallOrderOverrides)
    ? phaseOverrides.overallOrderOverrides
    : null;

  return buildStandingsEntries({
    teamIds,
    teamLookup,
    matches: finalizedMatches,
    overrideOrder: overallOrderOverrides,
  });
}

async function loadStandingsContext(tournamentId, phase) {
  const matchPhaseQuery =
    phase === 'cumulative' ? { $in: CUMULATIVE_PHASE_MATCHES } : phase;
  const poolsPromise = PHASES_WITH_POOLS.has(phase)
    ? Pool.find({ tournamentId, phase }).select('_id name teamIds').lean()
    : Promise.resolve([]);

  const [tournament, teams, pools, matches] = await Promise.all([
    Tournament.findById(tournamentId).select('standingsOverrides').lean(),
    TournamentTeam.find({ tournamentId }).select('_id name shortName seed').lean(),
    poolsPromise,
    Match.find({
      tournamentId,
      phase: matchPhaseQuery,
      status: 'final',
      result: { $ne: null },
    })
      .select('poolId teamAId teamBId result')
      .lean(),
  ]);

  return {
    tournament,
    teams,
    pools,
    matches,
    phaseOverrides:
      phase === 'cumulative'
        ? { poolOrderOverrides: {}, overallOrderOverrides: [] }
        : normalizePhaseOverrides(tournament, phase),
  };
}

async function computePoolStandings(tournamentId, phase = 'phase1') {
  if (!SUPPORTED_PHASES.has(phase)) {
    throw new Error(`Unsupported phase: ${phase}`);
  }

  if (!PHASES_WITH_POOLS.has(phase)) {
    return [];
  }

  const context = await loadStandingsContext(tournamentId, phase);
  return computePoolStandingsFromData(context);
}

async function computeOverallStandings(tournamentId, phase = 'phase1') {
  if (!SUPPORTED_PHASES.has(phase)) {
    throw new Error(`Unsupported phase: ${phase}`);
  }

  const context = await loadStandingsContext(tournamentId, phase);
  return computeOverallStandingsFromData(context);
}

async function computeStandingsBundle(tournamentId, phase = 'phase1') {
  if (!SUPPORTED_PHASES.has(phase)) {
    throw new Error(`Unsupported phase: ${phase}`);
  }

  const context = await loadStandingsContext(tournamentId, phase);

  return {
    pools: PHASES_WITH_POOLS.has(phase) ? computePoolStandingsFromData(context) : [],
    overall: computeOverallStandingsFromData(context),
  };
}

module.exports = {
  MAX_BEST_OF_THREE_SETS,
  REQUIRED_SET_WINS,
  computeMatchSnapshot,
  computeOverallStandings,
  computeOverallStandingsFromData,
  computePoolStandings,
  computePoolStandingsFromData,
  computeStandingsBundle,
};

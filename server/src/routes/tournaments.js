const express = require('express');
const mongoose = require('mongoose');

const Tournament = require('../models/Tournament');
const TournamentTeam = require('../models/TournamentTeam');
const Pool = require('../models/Pool');
const Match = require('../models/Match');
const Scoreboard = require('../models/Scoreboard');
const { requireAuth } = require('../middleware/auth');
const {
  PHASE1_MATCH_ORDER,
  PHASE1_POOL_HOME_COURTS,
  PHASE1_POOL_NAMES,
  buildSerpentineAssignments,
  getFacilityFromCourt,
  normalizeScoringConfig,
  sortPoolsByPhase1Name,
} = require('../services/phase1');
const {
  PHASE2_MATCH_ORDER,
  PHASE2_POOL_HOME_COURTS,
  PHASE2_POOL_NAMES,
  buildPhase2PoolsFromPhase1Results,
} = require('../services/phase2');
const { createMatchScoreboard, createScoreboard } = require('../services/scoreboards');
const { computeStandingsBundle } = require('../services/tournamentEngine/standings');
const {
  PLAYOFF_BRACKETS,
  buildPlayoffBracketView,
  buildPlayoffOpsSchedule,
  buildPlayoffSeedAssignments,
  createPlayoffMatchPlan,
  recomputePlayoffBracketProgression,
} = require('../services/playoffs');
const {
  CODE_LENGTH,
  createUniqueTournamentPublicCode,
} = require('../utils/tournamentPublicCode');
const {
  TOURNAMENT_EVENT_TYPES,
  cacheTournamentMatchEntry,
  emitTournamentEvent,
} = require('../services/tournamentRealtime');

const router = express.Router();

const TOURNAMENT_STATUSES = ['setup', 'phase1', 'phase2', 'playoffs', 'complete'];
const MATCH_PHASES = ['phase1', 'phase2', 'playoffs'];
const STANDINGS_PHASES = ['phase1', 'phase2', 'cumulative'];
const STANDINGS_OVERRIDE_PHASES = ['phase1', 'phase2'];
const DUPLICATE_KEY_ERROR_CODE = 11000;
const TOURNAMENT_STATUS_ORDER = {
  setup: 0,
  phase1: 1,
  phase2: 2,
  playoffs: 3,
  complete: 4,
};
const TOURNAMENT_SCHEDULE_DEFAULTS = Object.freeze({
  dayStartTime: '09:00',
  matchDurationMinutes: 60,
  lunchDurationMinutes: 45,
});

const phase2PoolNameIndex = PHASE2_POOL_NAMES.reduce((lookup, poolName, index) => {
  lookup[poolName] = index;
  return lookup;
}, {});

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const isDuplicatePublicCodeError = (error) =>
  error?.code === DUPLICATE_KEY_ERROR_CODE &&
  (error?.keyPattern?.publicCode || error?.keyValue?.publicCode);

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const normalizeScheduleString = (value, fallback = null) =>
  isNonEmptyString(value) ? value.trim() : fallback;

const normalizeScheduleMinutes = (value, fallback) => {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed);
  }
  return fallback;
};

function normalizeTournamentSchedule(schedule) {
  return {
    dayStartTime: normalizeScheduleString(
      schedule?.dayStartTime,
      TOURNAMENT_SCHEDULE_DEFAULTS.dayStartTime
    ),
    matchDurationMinutes: normalizeScheduleMinutes(
      schedule?.matchDurationMinutes,
      TOURNAMENT_SCHEDULE_DEFAULTS.matchDurationMinutes
    ),
    lunchStartTime: normalizeScheduleString(schedule?.lunchStartTime, null),
    lunchDurationMinutes: normalizeScheduleMinutes(
      schedule?.lunchDurationMinutes,
      TOURNAMENT_SCHEDULE_DEFAULTS.lunchDurationMinutes
    ),
  };
}

function attachTournamentScheduleDefaults(tournament) {
  if (!tournament || typeof tournament !== 'object') {
    return tournament;
  }

  return {
    ...tournament,
    settings: {
      ...(tournament.settings && typeof tournament.settings === 'object'
        ? tournament.settings
        : {}),
      schedule: normalizeTournamentSchedule(tournament?.settings?.schedule),
    },
  };
}

const parseTournamentDate = (value) => {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const normalizePublicCode = (value) =>
  typeof value === 'string' ? value.trim().toUpperCase() : '';

const normalizeBracket = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const toIdString = (value) => (value ? value.toString() : null);

const normalizeStandingsPhase = (value) =>
  typeof value === 'string' && value.trim() ? value.trim() : 'phase1';

const normalizeTeamIdList = (value) =>
  Array.isArray(value) ? value.map((teamId) => toIdString(teamId)).filter(Boolean) : null;

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

const parseBooleanFlag = (value, fallback = false) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (['true', '1', 'yes', 'y'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'n'].includes(normalized)) {
    return false;
  }

  return fallback;
};

const normalizeTeamOrderIndex = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const rounded = Math.round(parsed);
  return rounded > 0 ? rounded : null;
};

const normalizeCreatedAtMs = (value) => {
  if (!value) {
    return Number.MAX_SAFE_INTEGER;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
};

function compareTeamsByTournamentOrder(teamA, teamB) {
  const orderA = normalizeTeamOrderIndex(teamA?.orderIndex) ?? Number.MAX_SAFE_INTEGER;
  const orderB = normalizeTeamOrderIndex(teamB?.orderIndex) ?? Number.MAX_SAFE_INTEGER;

  if (orderA !== orderB) {
    return orderA - orderB;
  }

  const createdAtA = normalizeCreatedAtMs(teamA?.createdAt);
  const createdAtB = normalizeCreatedAtMs(teamB?.createdAt);

  if (createdAtA !== createdAtB) {
    return createdAtA - createdAtB;
  }

  const nameA = String(teamA?.name || teamA?.shortName || '');
  const nameB = String(teamB?.name || teamB?.shortName || '');
  const byName = nameA.localeCompare(nameB);

  if (byName !== 0) {
    return byName;
  }

  return String(toIdString(teamA?._id) || '').localeCompare(String(toIdString(teamB?._id) || ''));
}

function validateStandingsPhaseFilter(phase) {
  if (!phase) {
    return null;
  }

  return STANDINGS_PHASES.includes(phase) ? null : 'Invalid standings phase';
}

function validateStandingsOverridePhaseFilter(phase) {
  if (!phase) {
    return null;
  }

  return STANDINGS_OVERRIDE_PHASES.includes(phase) ? null : 'Invalid standings override phase';
}

async function ensureTournamentOwnership(tournamentId, userId) {
  return Tournament.exists({
    _id: tournamentId,
    createdByUserId: userId,
  });
}

function validateTeamPayload(rawTeam, index) {
  if (!rawTeam || typeof rawTeam !== 'object') {
    return `Invalid team payload at index ${index}`;
  }

  if (!isNonEmptyString(rawTeam.shortName)) {
    return `Team shortName is required at index ${index}`;
  }

  if (rawTeam.name !== undefined && rawTeam.name !== null && !isNonEmptyString(rawTeam.name)) {
    return `Team name must be a non-empty string at index ${index}`;
  }

  if (
    rawTeam.logoUrl !== undefined &&
    rawTeam.logoUrl !== null &&
    typeof rawTeam.logoUrl !== 'string'
  ) {
    return `logoUrl must be a string at index ${index}`;
  }

  if (rawTeam.seed !== undefined && rawTeam.seed !== null) {
    const parsedSeed = Number(rawTeam.seed);

    if (!Number.isFinite(parsedSeed)) {
      return `seed must be a number at index ${index}`;
    }
  }

  return null;
}

function buildTeamInsertPayload(rawTeam, tournamentId, orderIndex = null) {
  const shortName = rawTeam.shortName.trim();
  const normalizedName = isNonEmptyString(rawTeam.name) ? rawTeam.name.trim() : shortName;
  const team = {
    tournamentId,
    name: normalizedName,
    shortName,
  };

  if (orderIndex !== null) {
    team.orderIndex = orderIndex;
  }

  if (rawTeam.logoUrl !== undefined) {
    team.logoUrl = rawTeam.logoUrl === null ? null : rawTeam.logoUrl.trim() || null;
  }

  if (rawTeam.seed !== undefined) {
    team.seed = rawTeam.seed === null ? null : Number(rawTeam.seed);
  }

  return team;
}

function serializeTeam(team) {
  if (!team) {
    return null;
  }

  return {
    id: toIdString(team._id),
    name: team.name ?? '',
    shortName: team.shortName ?? '',
    logoUrl: team.logoUrl ?? null,
    orderIndex: normalizeTeamOrderIndex(team.orderIndex),
    seed: team.seed ?? null,
  };
}

function serializePool(pool) {
  const teamIds = Array.isArray(pool?.teamIds)
    ? pool.teamIds.map((team) =>
        team && typeof team === 'object' && team._id
          ? {
              _id: toIdString(team._id),
              name: team.name ?? '',
              shortName: team.shortName ?? '',
              logoUrl: team.logoUrl ?? null,
              orderIndex: normalizeTeamOrderIndex(team.orderIndex),
              seed: team.seed ?? null,
            }
          : { _id: toIdString(team) }
      )
    : [];
  const rematchWarnings = Array.isArray(pool?.rematchWarnings)
    ? pool.rematchWarnings
        .map((warning) => ({
          teamIdA: toIdString(warning?.teamIdA),
          teamIdB: toIdString(warning?.teamIdB),
        }))
        .filter((warning) => warning.teamIdA && warning.teamIdB)
    : [];

  return {
    _id: toIdString(pool?._id),
    tournamentId: toIdString(pool?.tournamentId),
    phase: pool?.phase ?? null,
    name: pool?.name ?? '',
    homeCourt: pool?.homeCourt ?? null,
    teamIds,
    rematchWarnings,
    createdAt: pool?.createdAt ?? null,
    updatedAt: pool?.updatedAt ?? null,
  };
}

function serializeMatchResult(result) {
  if (!result) {
    return null;
  }

  return {
    winnerTeamId: toIdString(result.winnerTeamId),
    loserTeamId: toIdString(result.loserTeamId),
    setsWonA: result.setsWonA ?? 0,
    setsWonB: result.setsWonB ?? 0,
    setsPlayed: result.setsPlayed ?? 0,
    pointsForA: result.pointsForA ?? 0,
    pointsAgainstA: result.pointsAgainstA ?? 0,
    pointsForB: result.pointsForB ?? 0,
    pointsAgainstB: result.pointsAgainstB ?? 0,
    setScores: Array.isArray(result.setScores)
      ? result.setScores.map((set) => ({
          setNo: set.setNo,
          a: set.a,
          b: set.b,
        }))
      : [],
  };
}

function serializeMatch(match) {
  const teamA = match?.teamAId && typeof match.teamAId === 'object' ? match.teamAId : null;
  const teamB = match?.teamBId && typeof match.teamBId === 'object' ? match.teamBId : null;
  const pool = match?.poolId && typeof match.poolId === 'object' ? match.poolId : null;
  const scoreboard =
    match?.scoreboardId && typeof match.scoreboardId === 'object' ? match.scoreboardId : null;

  const refTeams = Array.isArray(match?.refTeamIds)
    ? match.refTeamIds.map((team) =>
        team && typeof team === 'object' && team._id ? serializeTeam(team) : { id: toIdString(team) }
      )
    : [];

  return {
    _id: toIdString(match?._id),
    phase: match?.phase ?? null,
    poolId: pool ? toIdString(pool._id) : toIdString(match?.poolId),
    poolName: pool?.name ?? null,
    bracket: match?.bracket ?? null,
    bracketRound: match?.bracketRound ?? null,
    bracketMatchKey: match?.bracketMatchKey ?? null,
    seedA: match?.seedA ?? null,
    seedB: match?.seedB ?? null,
    teamAFromMatchId: toIdString(match?.teamAFromMatchId),
    teamAFromSlot: match?.teamAFromSlot ?? null,
    teamBFromMatchId: toIdString(match?.teamBFromMatchId),
    teamBFromSlot: match?.teamBFromSlot ?? null,
    roundBlock: match?.roundBlock ?? null,
    facility: match?.facility ?? null,
    court: match?.court ?? null,
    teamAId: teamA ? toIdString(teamA._id) : toIdString(match?.teamAId),
    teamBId: teamB ? toIdString(teamB._id) : toIdString(match?.teamBId),
    teamA: teamA ? serializeTeam(teamA) : null,
    teamB: teamB ? serializeTeam(teamB) : null,
    refTeamIds: refTeams.map((team) => team.id),
    refTeams,
    scoreboardId: scoreboard ? toIdString(scoreboard._id) : toIdString(match?.scoreboardId),
    scoreboardCode: scoreboard?.code ?? null,
    status: match?.status ?? null,
    result: serializeMatchResult(match?.result),
    finalizedAt: match?.finalizedAt ?? null,
    finalizedBy: toIdString(match?.finalizedBy),
    createdAt: match?.createdAt ?? null,
    updatedAt: match?.updatedAt ?? null,
  };
}

async function loadPhase1Pools(tournamentId, { populateTeams = true } = {}) {
  let query = Pool.find({
    tournamentId,
    phase: 'phase1',
    name: { $in: PHASE1_POOL_NAMES },
  });

  if (populateTeams) {
    query = query.populate('teamIds', 'name shortName logoUrl orderIndex seed');
  }

  const pools = await query.lean();
  return pools.sort(sortPoolsByPhase1Name);
}

function sortPoolsByPhase2Name(poolA, poolB) {
  const indexA = phase2PoolNameIndex[poolA?.name] ?? Number.MAX_SAFE_INTEGER;
  const indexB = phase2PoolNameIndex[poolB?.name] ?? Number.MAX_SAFE_INTEGER;

  if (indexA !== indexB) {
    return indexA - indexB;
  }

  return String(poolA?.name || '').localeCompare(String(poolB?.name || ''));
}

async function loadPhase2Pools(tournamentId, { populateTeams = true } = {}) {
  let query = Pool.find({
    tournamentId,
    phase: 'phase2',
    name: { $in: PHASE2_POOL_NAMES },
  });

  if (populateTeams) {
    query = query.populate('teamIds', 'name shortName logoUrl orderIndex seed');
  }

  const pools = await query.lean();
  return pools.sort(sortPoolsByPhase2Name);
}

async function loadMatchesForResponse(query) {
  const matches = await Match.find(query)
    .populate('poolId', 'name')
    .populate('teamAId', 'name shortName logoUrl orderIndex seed')
    .populate('teamBId', 'name shortName logoUrl orderIndex seed')
    .populate('refTeamIds', 'name shortName logoUrl orderIndex seed')
    .populate('scoreboardId', 'code')
    .sort({ phase: 1, roundBlock: 1, court: 1, createdAt: 1 })
    .lean();

  return matches.map(serializeMatch);
}

function validateMatchPhaseFilter(phase) {
  if (!phase) {
    return null;
  }

  return MATCH_PHASES.includes(phase) ? null : 'Invalid phase filter';
}

function validatePhase1PoolsForGeneration(pools) {
  const byName = new Map(pools.map((pool) => [pool.name, pool]));
  const allTeamIds = [];

  for (const poolName of PHASE1_POOL_NAMES) {
    const pool = byName.get(poolName);

    if (!pool) {
      return `Pool ${poolName} is missing`;
    }

    if (!Array.isArray(pool.teamIds) || pool.teamIds.length !== 3) {
      return `Pool ${poolName} must have exactly 3 teams`;
    }

    pool.teamIds.forEach((teamId) => allTeamIds.push(toIdString(teamId)));
  }

  if (new Set(allTeamIds).size !== allTeamIds.length) {
    return 'Each Phase 1 team can only appear in one pool';
  }

  return null;
}

function validatePhase2PoolsForGeneration(pools) {
  const byName = new Map((Array.isArray(pools) ? pools : []).map((pool) => [pool.name, pool]));
  const allTeamIds = [];

  for (const poolName of PHASE2_POOL_NAMES) {
    const pool = byName.get(poolName);

    if (!pool) {
      return `Pool ${poolName} is missing`;
    }

    if (!Array.isArray(pool.teamIds) || pool.teamIds.length !== 3) {
      return `Pool ${poolName} must have exactly 3 teams`;
    }

    pool.teamIds.forEach((teamId) => allTeamIds.push(toIdString(teamId)));
  }

  if (new Set(allTeamIds).size !== allTeamIds.length) {
    return 'Each Phase 2 team can only appear in one pool';
  }

  return null;
}

async function ensureTournamentStatusAtLeast(tournamentId, nextStatus) {
  const nextIndex = TOURNAMENT_STATUS_ORDER[nextStatus];

  if (nextIndex === undefined) {
    return;
  }

  const tournament = await Tournament.findById(tournamentId).select('status').lean();
  const currentIndex = TOURNAMENT_STATUS_ORDER[tournament?.status] ?? 0;

  if (currentIndex < nextIndex) {
    await Tournament.updateOne({ _id: tournamentId }, { $set: { status: nextStatus } });
  }
}

async function findTournamentForPublicCode(publicCode) {
  return Tournament.findOne({ publicCode })
    .select('_id name date timezone status facilities publicCode settings.schedule')
    .lean();
}

function emitTournamentEventFromRequest(req, tournamentCode, type, data) {
  const io = req.app?.get('io');
  emitTournamentEvent(io, tournamentCode, type, data);
}

function formatStandingsPayload(standings) {
  return {
    pools: Array.isArray(standings?.pools)
      ? standings.pools.map((pool) => ({
          poolId: pool.poolId ?? null,
          poolName: pool.poolName ?? '',
          teams: Array.isArray(pool.teams)
            ? pool.teams.map((team) => ({
                rank: team.rank ?? null,
                teamId: team.teamId ?? null,
                name: team.name ?? '',
                shortName: team.shortName ?? '',
                seed: team.seed ?? null,
                matchesPlayed: team.matchesPlayed ?? 0,
                matchesWon: team.matchesWon ?? 0,
                matchesLost: team.matchesLost ?? 0,
                setsWon: team.setsWon ?? 0,
                setsLost: team.setsLost ?? 0,
                setsPlayed: team.setsPlayed ?? 0,
                setPct: team.setPct ?? 0,
                pointsFor: team.pointsFor ?? 0,
                pointsAgainst: team.pointsAgainst ?? 0,
                pointDiff: team.pointDiff ?? 0,
              }))
            : [],
        }))
      : [],
    overall: Array.isArray(standings?.overall)
      ? standings.overall.map((team) => ({
          rank: team.rank ?? null,
          teamId: team.teamId ?? null,
          name: team.name ?? '',
          shortName: team.shortName ?? '',
          seed: team.seed ?? null,
          matchesPlayed: team.matchesPlayed ?? 0,
          matchesWon: team.matchesWon ?? 0,
          matchesLost: team.matchesLost ?? 0,
          setsWon: team.setsWon ?? 0,
          setsLost: team.setsLost ?? 0,
          setsPlayed: team.setsPlayed ?? 0,
          setPct: team.setPct ?? 0,
          pointsFor: team.pointsFor ?? 0,
          pointsAgainst: team.pointsAgainst ?? 0,
          pointDiff: team.pointDiff ?? 0,
        }))
      : [],
  };
}

function serializePhaseOverrides(phaseOverrides) {
  const rawPoolOverrides = phaseOverrides?.poolOrderOverrides;
  const poolEntries =
    rawPoolOverrides instanceof Map
      ? Array.from(rawPoolOverrides.entries())
      : rawPoolOverrides && typeof rawPoolOverrides === 'object'
        ? Object.entries(rawPoolOverrides)
        : [];

  const poolOrderOverrides = Object.fromEntries(
    poolEntries.map(([poolName, teamIds]) => [
      poolName,
      Array.isArray(teamIds) ? teamIds.map((teamId) => toIdString(teamId)).filter(Boolean) : [],
    ])
  );

  const overallOrderOverrides = Array.isArray(phaseOverrides?.overallOrderOverrides)
    ? phaseOverrides.overallOrderOverrides
        .map((teamId) => toIdString(teamId))
        .filter(Boolean)
    : [];

  return {
    poolOrderOverrides,
    overallOrderOverrides,
  };
}

const PLAYOFF_EXPECTED_TEAM_COUNT = 15;

const normalizeOverallOrderOverride = (value) =>
  Array.isArray(value) ? value.map((teamId) => toIdString(teamId)).filter(Boolean) : [];

function applyOverallOrderOverride(overallStandings, overallOrderOverride) {
  const normalizedStandings = Array.isArray(overallStandings)
    ? overallStandings.map((entry) => ({
        ...entry,
        teamId: toIdString(entry.teamId),
      }))
    : [];

  const override = normalizeOverallOrderOverride(overallOrderOverride);
  const standingTeamIds = normalizedStandings.map((entry) => entry.teamId).filter(Boolean);

  if (!isPermutation(override, standingTeamIds)) {
    return {
      applied: false,
      standings: normalizedStandings,
    };
  }

  const overrideIndex = new Map(override.map((teamId, index) => [teamId, index]));
  const ordered = [...normalizedStandings]
    .sort((left, right) => {
      const leftIndex = overrideIndex.get(left.teamId);
      const rightIndex = overrideIndex.get(right.teamId);
      return leftIndex - rightIndex;
    })
    .map((entry, index) => ({
      ...entry,
      rank: index + 1,
    }));

  return {
    applied: true,
    standings: ordered,
  };
}

async function computePlayoffGenerationRanking(tournamentId) {
  const [tournament, teams, phase2Matches, standings] = await Promise.all([
    Tournament.findById(tournamentId).select('standingsOverrides').lean(),
    TournamentTeam.find({ tournamentId }).select('_id').lean(),
    Match.find({ tournamentId, phase: 'phase2' }).select('result').lean(),
    computeStandingsBundle(tournamentId, 'cumulative'),
  ]);

  const teamIds = teams.map((team) => toIdString(team._id)).filter(Boolean);
  const phase2FinalizedCount = phase2Matches.filter((match) => Boolean(match?.result)).length;
  const phase2AllFinalized =
    phase2Matches.length > 0 && phase2FinalizedCount === phase2Matches.length;
  const phase2OverallOverride = normalizeOverallOrderOverride(
    tournament?.standingsOverrides?.phase2?.overallOrderOverrides
  );
  const hasValidPhase2Override = isPermutation(phase2OverallOverride, teamIds);
  const missing = [];

  if (!phase2AllFinalized && !hasValidPhase2Override) {
    if (phase2Matches.length === 0) {
      missing.push('Phase 2 matches have not been generated');
    } else {
      missing.push(`Phase 2 has ${phase2FinalizedCount}/${phase2Matches.length} finalized matches`);
    }

    missing.push(
      'Provide a valid phase2 overallOrder standings override to resolve cumulative ranking early'
    );
  }

  const overrideResult = applyOverallOrderOverride(
    standings?.overall || [],
    tournament?.standingsOverrides?.phase2?.overallOrderOverrides
  );
  const cumulativeOverall = overrideResult.standings;

  if (cumulativeOverall.length < PLAYOFF_EXPECTED_TEAM_COUNT) {
    missing.push(
      `Cumulative standings resolved ${cumulativeOverall.length}/${PLAYOFF_EXPECTED_TEAM_COUNT} teams`
    );
  }

  return {
    ok: missing.length === 0,
    missing,
    phase2MatchCount: phase2Matches.length,
    phase2FinalizedCount,
    phase2AllFinalized,
    usedPhase2OverallOverride: overrideResult.applied,
    cumulativeOverall,
  };
}

function sortPlayoffMatches(matches) {
  const bracketOrder = {
    gold: 0,
    silver: 1,
    bronze: 2,
  };
  const roundOrder = {
    R1: 0,
    R2: 1,
    R3: 2,
  };

  return [...(Array.isArray(matches) ? matches : [])].sort((left, right) => {
    const byBracket =
      (bracketOrder[normalizeBracket(left?.bracket)] ?? Number.MAX_SAFE_INTEGER) -
      (bracketOrder[normalizeBracket(right?.bracket)] ?? Number.MAX_SAFE_INTEGER);
    if (byBracket !== 0) {
      return byBracket;
    }

    const byRound =
      (roundOrder[left?.bracketRound] ?? Number.MAX_SAFE_INTEGER) -
      (roundOrder[right?.bracketRound] ?? Number.MAX_SAFE_INTEGER);
    if (byRound !== 0) {
      return byRound;
    }

    if ((left?.roundBlock || 0) !== (right?.roundBlock || 0)) {
      return (left?.roundBlock || 0) - (right?.roundBlock || 0);
    }

    return String(left?.court || '').localeCompare(String(right?.court || ''));
  });
}

function buildPlayoffPayload(matches) {
  const orderedMatches = sortPlayoffMatches(matches);
  return {
    matches: orderedMatches,
    brackets: buildPlayoffBracketView(orderedMatches),
    opsSchedule: buildPlayoffOpsSchedule(orderedMatches),
  };
}

function sanitizePlayoffMatchForPublic(match) {
  return {
    _id: match?._id ?? null,
    phase: match?.phase ?? null,
    bracket: match?.bracket ?? null,
    bracketRound: match?.bracketRound ?? null,
    bracketMatchKey: match?.bracketMatchKey ?? null,
    seedA: match?.seedA ?? null,
    seedB: match?.seedB ?? null,
    teamAFromMatchId: match?.teamAFromMatchId ?? null,
    teamAFromSlot: match?.teamAFromSlot ?? null,
    teamBFromMatchId: match?.teamBFromMatchId ?? null,
    teamBFromSlot: match?.teamBFromSlot ?? null,
    roundBlock: match?.roundBlock ?? null,
    facility: match?.facility ?? null,
    court: match?.court ?? null,
    teamAId: match?.teamAId ?? null,
    teamBId: match?.teamBId ?? null,
    teamA: match?.teamA ?? null,
    teamB: match?.teamB ?? null,
    refTeamIds: Array.isArray(match?.refTeamIds) ? match.refTeamIds : [],
    refTeams: Array.isArray(match?.refTeams) ? match.refTeams : [],
    scoreboardCode: match?.scoreboardCode ?? null,
    status: match?.status ?? null,
    result: match?.result ?? null,
    finalizedAt: match?.finalizedAt ?? null,
  };
}

// GET /api/tournaments/code/:publicCode -> public tournament + teams payload
router.get('/code/:publicCode', async (req, res, next) => {
  try {
    const publicCode = normalizePublicCode(req.params.publicCode);

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode)) {
      return res.status(400).json({ message: 'Invalid tournament code' });
    }

    const tournament = await findTournamentForPublicCode(publicCode);

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const teams = await TournamentTeam.find({ tournamentId: tournament._id })
      .select('name shortName logoUrl orderIndex seed createdAt')
      .lean();
    teams.sort(compareTeamsByTournamentOrder);

    return res.json({
      tournament: {
        id: tournament._id.toString(),
        name: tournament.name,
        date: tournament.date,
        timezone: tournament.timezone,
        status: tournament.status,
        facilities: tournament.facilities,
        settings: {
          schedule: normalizeTournamentSchedule(tournament?.settings?.schedule),
        },
        publicCode: tournament.publicCode,
      },
      teams: teams.map((team) => ({
        id: team._id.toString(),
        name: team.name,
        shortName: team.shortName,
        logoUrl: team.logoUrl || null,
        orderIndex: normalizeTeamOrderIndex(team.orderIndex),
        seed: team.seed ?? null,
      })),
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/code/:publicCode/phase1/pools -> public read-only phase1 pools
router.get('/code/:publicCode/phase1/pools', async (req, res, next) => {
  try {
    const publicCode = normalizePublicCode(req.params.publicCode);

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode)) {
      return res.status(400).json({ message: 'Invalid tournament code' });
    }

    const tournament = await Tournament.findOne({ publicCode }).select('_id').lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const pools = await loadPhase1Pools(tournament._id, { populateTeams: true });
    return res.json(pools.map(serializePool));
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/code/:publicCode/phase2/pools -> public read-only phase2 pools
router.get('/code/:publicCode/phase2/pools', async (req, res, next) => {
  try {
    const publicCode = normalizePublicCode(req.params.publicCode);

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode)) {
      return res.status(400).json({ message: 'Invalid tournament code' });
    }

    const tournament = await Tournament.findOne({ publicCode }).select('_id').lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const pools = await loadPhase2Pools(tournament._id, { populateTeams: true });
    return res.json(pools.map(serializePool));
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/code/:publicCode/matches?phase=phase1|phase2|playoffs
router.get('/code/:publicCode/matches', async (req, res, next) => {
  try {
    const publicCode = normalizePublicCode(req.params.publicCode);

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode)) {
      return res.status(400).json({ message: 'Invalid tournament code' });
    }

    const phaseError = validateMatchPhaseFilter(req.query?.phase);

    if (phaseError) {
      return res.status(400).json({ message: phaseError });
    }

    const tournament = await Tournament.findOne({ publicCode }).select('_id').lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const query = { tournamentId: tournament._id };

    if (req.query?.phase) {
      query.phase = req.query.phase;
    }

    const matches = await loadMatchesForResponse(query);
    return res.json(matches);
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/code/:publicCode/playoffs -> public playoff brackets + ops schedule
router.get('/code/:publicCode/playoffs', async (req, res, next) => {
  try {
    const publicCode = normalizePublicCode(req.params.publicCode);

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode)) {
      return res.status(400).json({ message: 'Invalid tournament code' });
    }

    const tournament = await Tournament.findOne({ publicCode })
      .select('_id name timezone status publicCode settings.schedule')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const matches = await loadMatchesForResponse({
      tournamentId: tournament._id,
      phase: 'playoffs',
    });
    const sanitizedMatches = matches.map(sanitizePlayoffMatchForPublic);
    const payload = buildPlayoffPayload(sanitizedMatches);

    return res.json({
      tournament: {
        id: tournament._id.toString(),
        name: tournament.name,
        timezone: tournament.timezone,
        status: tournament.status,
        settings: {
          schedule: normalizeTournamentSchedule(tournament?.settings?.schedule),
        },
        publicCode: tournament.publicCode,
      },
      ...payload,
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/code/:publicCode/standings?phase=phase1|phase2|cumulative -> public standings
router.get('/code/:publicCode/standings', async (req, res, next) => {
  try {
    const publicCode = normalizePublicCode(req.params.publicCode);
    const phase = normalizeStandingsPhase(req.query?.phase);

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode)) {
      return res.status(400).json({ message: 'Invalid tournament code' });
    }

    const phaseError = validateStandingsPhaseFilter(phase);

    if (phaseError) {
      return res.status(400).json({ message: phaseError });
    }

    const tournament = await Tournament.findOne({ publicCode }).select('_id').lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const standings = await computeStandingsBundle(tournament._id, phase);

    return res.json({
      phase,
      basedOn: 'finalized',
      ...formatStandingsPayload(standings),
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments -> list tournaments created by current user
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const tournaments = await Tournament.find({ createdByUserId: req.user.id })
      .sort({ date: -1, createdAt: -1 })
      .lean();

    return res.json(tournaments);
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments -> create a tournament
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { name, date, timezone } = req.body ?? {};

    if (!isNonEmptyString(name)) {
      return res.status(400).json({ message: 'Tournament name is required' });
    }

    const parsedDate = parseTournamentDate(date);

    if (!parsedDate) {
      return res.status(400).json({ message: 'A valid tournament date is required' });
    }

    if (timezone !== undefined && !isNonEmptyString(timezone)) {
      return res.status(400).json({ message: 'timezone must be a non-empty string' });
    }

    const maxCreateAttempts = 5;

    for (let attempt = 0; attempt < maxCreateAttempts; attempt += 1) {
      const publicCode = await createUniqueTournamentPublicCode(Tournament);

      try {
        const tournament = await Tournament.create({
          name: name.trim(),
          date: parsedDate,
          timezone: timezone?.trim() || undefined,
          publicCode,
          createdByUserId: req.user.id,
        });

        return res.status(201).json(tournament.toObject());
      } catch (error) {
        if (isDuplicatePublicCodeError(error)) {
          continue;
        }

        throw error;
      }
    }

    return res.status(500).json({ message: 'Failed to generate a unique tournament code' });
  } catch (error) {
    return next(error);
  }
});

// PATCH /api/tournaments/:id -> update editable tournament fields
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const updates = {};

    if (req.body?.name !== undefined) {
      if (!isNonEmptyString(req.body.name)) {
        return res.status(400).json({ message: 'Tournament name must be a non-empty string' });
      }

      updates.name = req.body.name.trim();
    }

    if (req.body?.date !== undefined) {
      const parsedDate = parseTournamentDate(req.body.date);

      if (!parsedDate) {
        return res.status(400).json({ message: 'Tournament date must be a valid date' });
      }

      updates.date = parsedDate;
    }

    if (req.body?.timezone !== undefined) {
      if (!isNonEmptyString(req.body.timezone)) {
        return res.status(400).json({ message: 'timezone must be a non-empty string' });
      }

      updates.timezone = req.body.timezone.trim();
    }

    if (req.body?.status !== undefined) {
      if (!TOURNAMENT_STATUSES.includes(req.body.status)) {
        return res.status(400).json({ message: 'Invalid tournament status' });
      }

      updates.status = req.body.status;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No valid fields provided for update' });
    }

    const tournament = await Tournament.findOneAndUpdate(
      {
        _id: id,
        createdByUserId: req.user.id,
      },
      updates,
      {
        new: true,
        runValidators: true,
        omitUndefined: true,
      }
    );

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    return res.json(tournament.toObject());
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments/:id/phase1/pools/init -> create phase1 pools A-E if needed
router.post('/:id/phase1/pools/init', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('publicCode')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const existingPools = await Pool.find({
      tournamentId: id,
      phase: 'phase1',
      name: { $in: PHASE1_POOL_NAMES },
    }).lean();

    const existingByName = new Map(existingPools.map((pool) => [pool.name, pool]));
    const writeOperations = [];

    PHASE1_POOL_NAMES.forEach((poolName) => {
      const expectedHomeCourt = PHASE1_POOL_HOME_COURTS[poolName];
      const existingPool = existingByName.get(poolName);

      if (!existingPool) {
        writeOperations.push({
          insertOne: {
            document: {
              tournamentId: id,
              phase: 'phase1',
              name: poolName,
              teamIds: [],
              homeCourt: expectedHomeCourt,
            },
          },
        });
        return;
      }

      if (existingPool.homeCourt !== expectedHomeCourt) {
        writeOperations.push({
          updateOne: {
            filter: { _id: existingPool._id },
            update: { $set: { homeCourt: expectedHomeCourt } },
          },
        });
      }
    });

    if (writeOperations.length > 0) {
      await Pool.bulkWrite(writeOperations, { ordered: true });
    }

    const pools = await loadPhase1Pools(id, { populateTeams: true });
    emitTournamentEventFromRequest(
      req,
      tournament.publicCode,
      TOURNAMENT_EVENT_TYPES.POOLS_UPDATED,
      {
        phase: 'phase1',
        poolIds: pools.map((pool) => toIdString(pool._id)).filter(Boolean),
      }
    );
    return res.json(pools.map(serializePool));
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments/:id/phase1/pools/autofill -> serpentine fill pools from team order
router.post('/:id/phase1/pools/autofill', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('publicCode')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const forceAutofill = parseBooleanFlag(req.query?.force ?? req.body?.force, false);

    const existingPools = await Pool.find({
      tournamentId: id,
      phase: 'phase1',
      name: { $in: PHASE1_POOL_NAMES },
    })
      .select('_id name teamIds homeCourt')
      .lean();
    const existingByName = new Map(existingPools.map((pool) => [pool.name, pool]));
    const ensurePoolOperations = [];

    PHASE1_POOL_NAMES.forEach((poolName) => {
      const expectedHomeCourt = PHASE1_POOL_HOME_COURTS[poolName];
      const existingPool = existingByName.get(poolName);

      if (!existingPool) {
        ensurePoolOperations.push({
          insertOne: {
            document: {
              tournamentId: id,
              phase: 'phase1',
              name: poolName,
              teamIds: [],
              homeCourt: expectedHomeCourt,
            },
          },
        });
        return;
      }

      if (existingPool.homeCourt !== expectedHomeCourt) {
        ensurePoolOperations.push({
          updateOne: {
            filter: { _id: existingPool._id },
            update: { $set: { homeCourt: expectedHomeCourt } },
          },
        });
      }
    });

    if (ensurePoolOperations.length > 0) {
      await Pool.bulkWrite(ensurePoolOperations, { ordered: true });
    }

    const phase1Pools = await Pool.find({
      tournamentId: id,
      phase: 'phase1',
      name: { $in: PHASE1_POOL_NAMES },
    })
      .select('_id name teamIds homeCourt')
      .lean();
    const poolsByName = new Map(phase1Pools.map((pool) => [pool.name, pool]));

    const hasAnyAssignedTeams = PHASE1_POOL_NAMES.some((poolName) => {
      const pool = poolsByName.get(poolName);
      return Array.isArray(pool?.teamIds) && pool.teamIds.length > 0;
    });

    if (hasAnyAssignedTeams && !forceAutofill) {
      return res.status(409).json({
        message:
          'Phase 1 pools already contain teams. Re-run with ?force=true to overwrite assignments.',
      });
    }

    const teams = await TournamentTeam.find({ tournamentId: id })
      .select('_id name shortName orderIndex createdAt')
      .lean();
    teams.sort(compareTeamsByTournamentOrder);

    const assignments = buildSerpentineAssignments(teams.slice(0, 15));
    const autofillUpdates = PHASE1_POOL_NAMES.map((poolName) => {
      const pool = poolsByName.get(poolName);
      if (!pool) {
        return null;
      }

      const expectedHomeCourt = PHASE1_POOL_HOME_COURTS[poolName];
      return {
        updateOne: {
          filter: { _id: pool._id },
          update: {
            $set: {
              teamIds: assignments[poolName] || [],
              homeCourt: expectedHomeCourt,
            },
          },
        },
      };
    }).filter(Boolean);

    if (autofillUpdates.length > 0) {
      await Pool.bulkWrite(autofillUpdates, { ordered: true });
    }

    const pools = await loadPhase1Pools(id, { populateTeams: true });
    emitTournamentEventFromRequest(
      req,
      tournament.publicCode,
      TOURNAMENT_EVENT_TYPES.POOLS_UPDATED,
      {
        phase: 'phase1',
        poolIds: pools.map((pool) => toIdString(pool._id)).filter(Boolean),
      }
    );
    return res.json(pools.map(serializePool));
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/phase1/pools -> list phase1 pools for an owned tournament
router.get('/:id/phase1/pools', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('publicCode')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const pools = await loadPhase1Pools(id, { populateTeams: true });
    return res.json(pools.map(serializePool));
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/phase2/pools -> list phase2 pools for an owned tournament
router.get('/:id/phase2/pools', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('publicCode')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const pools = await loadPhase2Pools(id, { populateTeams: true });
    return res.json(pools.map(serializePool));
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments/:id/phase2/pools/generate -> generate/update phase2 pools from phase1 results
router.post('/:id/phase2/pools/generate', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('publicCode')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const forceRegenerate = parseBooleanFlag(req.query?.force, false);

    const [existingPhase2Pools, existingPhase2Matches] = await Promise.all([
      Pool.find({
        tournamentId: id,
        phase: 'phase2',
        name: { $in: PHASE2_POOL_NAMES },
      })
        .select('_id name')
        .lean(),
      Match.find({
        tournamentId: id,
        phase: 'phase2',
      })
        .select('_id')
        .limit(1)
        .lean(),
    ]);

    if (existingPhase2Matches.length > 0 && !forceRegenerate) {
      const poolsPrefix =
        existingPhase2Pools.length > 0 ? 'pools already exist and ' : '';
      return res.status(409).json({
        message:
          `Phase 2 ${poolsPrefix}matches have been generated. Re-run with ?force=true to overwrite pools.`,
      });
    }

    const generation = await buildPhase2PoolsFromPhase1Results(id);

    if (!generation.ok) {
      return res.status(400).json({
        message: 'Phase 2 pools cannot be generated yet',
        missing: generation.missing || [],
      });
    }

    await Pool.bulkWrite(
      generation.pools.map((pool) => ({
        updateOne: {
          filter: { tournamentId: id, phase: 'phase2', name: pool.name },
          update: {
            $set: {
              teamIds: pool.teamIds,
              homeCourt: pool.homeCourt,
              rematchWarnings: pool.rematchWarnings,
            },
          },
          upsert: true,
        },
      })),
      { ordered: true }
    );

    await ensureTournamentStatusAtLeast(id, 'phase2');

    const pools = await loadPhase2Pools(id, { populateTeams: true });
    emitTournamentEventFromRequest(
      req,
      tournament.publicCode,
      TOURNAMENT_EVENT_TYPES.POOLS_UPDATED,
      {
        phase: 'phase2',
        poolIds: pools.map((pool) => toIdString(pool._id)).filter(Boolean),
      }
    );
    return res.json({
      source: generation.source,
      pools: pools.map(serializePool),
    });
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments/:id/generate/phase1 -> generate 15 phase1 matches + scoreboards
router.post('/:id/generate/phase1', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('settings status publicCode')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const pools = await Pool.find({
      tournamentId: id,
      phase: 'phase1',
      name: { $in: PHASE1_POOL_NAMES },
    })
      .select('_id name teamIds homeCourt')
      .lean();

    const poolValidationError = validatePhase1PoolsForGeneration(pools);

    if (poolValidationError) {
      return res.status(400).json({ message: poolValidationError });
    }

    const forceRegenerate = parseBooleanFlag(req.query?.force, false);

    const existingPhase1Matches = await Match.find({
      tournamentId: id,
      phase: 'phase1',
    })
      .select('_id scoreboardId')
      .lean();

    if (existingPhase1Matches.length > 0 && !forceRegenerate) {
      return res.status(409).json({
        message: 'Phase 1 matches already generated. Re-run with ?force=true to regenerate.',
      });
    }

    if (existingPhase1Matches.length > 0 && forceRegenerate) {
      const staleScoreboardIds = existingPhase1Matches
        .map((match) => match.scoreboardId)
        .filter(Boolean);

      await Match.deleteMany({
        _id: { $in: existingPhase1Matches.map((match) => match._id) },
      });

      if (staleScoreboardIds.length > 0) {
        await Scoreboard.deleteMany({
          _id: { $in: staleScoreboardIds },
        });
      }
    }

    const teamIds = [...new Set(pools.flatMap((pool) => pool.teamIds.map((teamId) => toIdString(teamId))))];
    const teams = await TournamentTeam.find({
      _id: { $in: teamIds },
      tournamentId: id,
    })
      .select('name shortName logoUrl seed')
      .lean();

    if (teams.length !== teamIds.length) {
      return res.status(400).json({ message: 'Phase 1 pools include teams outside this tournament' });
    }

    const teamsById = new Map(teams.map((team) => [team._id.toString(), team]));
    const poolsByName = new Map(pools.map((pool) => [pool.name, pool]));
    const scoring = normalizeScoringConfig(tournament?.settings?.scoring);
    const createdMatchIds = [];
    const createdScoreboardIds = [];

    try {
      for (const poolName of PHASE1_POOL_NAMES) {
        const pool = poolsByName.get(poolName);
        const orderedTeamIds = pool.teamIds.map((teamId) => toIdString(teamId));
        const homeCourt = pool.homeCourt || PHASE1_POOL_HOME_COURTS[pool.name];
        const facility = getFacilityFromCourt(homeCourt);

        if (!facility) {
          throw new Error(`Pool ${pool.name} has an invalid home court`);
        }

        for (const matchTemplate of PHASE1_MATCH_ORDER) {
          const teamAId = orderedTeamIds[matchTemplate.teamAIndex];
          const teamBId = orderedTeamIds[matchTemplate.teamBIndex];
          const refTeamId = orderedTeamIds[matchTemplate.refIndex];
          const teamA = teamsById.get(teamAId);
          const teamB = teamsById.get(teamBId);

          if (!teamA || !teamB) {
            throw new Error(`Missing team data for Pool ${pool.name}`);
          }

          const scoreboard = await createMatchScoreboard({
            ownerId: req.user.id,
            title: `Pool ${pool.name} - Round ${matchTemplate.roundBlock}`,
            teamA,
            teamB,
            scoring,
          });

          createdScoreboardIds.push(scoreboard._id);

          const match = await Match.create({
            tournamentId: id,
            phase: 'phase1',
            poolId: pool._id,
            roundBlock: matchTemplate.roundBlock,
            facility,
            court: homeCourt,
            teamAId,
            teamBId,
            refTeamIds: [refTeamId],
            scoreboardId: scoreboard._id,
            status: 'scheduled',
          });

          cacheTournamentMatchEntry({
            scoreboardId: scoreboard._id,
            matchId: match._id,
            tournamentCode: tournament.publicCode,
          });
          createdMatchIds.push(match._id);
        }
      }
    } catch (generationError) {
      if (createdMatchIds.length > 0) {
        await Match.deleteMany({ _id: { $in: createdMatchIds } });
      }

      if (createdScoreboardIds.length > 0) {
        await Scoreboard.deleteMany({ _id: { $in: createdScoreboardIds } });
      }

      throw generationError;
    }

    if (tournament.status === 'setup') {
      await Tournament.updateOne({ _id: id }, { $set: { status: 'phase1' } });
    }

    const matches = await loadMatchesForResponse({ _id: { $in: createdMatchIds } });
    emitTournamentEventFromRequest(
      req,
      tournament.publicCode,
      TOURNAMENT_EVENT_TYPES.MATCHES_GENERATED,
      {
        phase: 'phase1',
        matchIds: matches.map((match) => toIdString(match._id)).filter(Boolean),
      }
    );
    return res.status(201).json(matches);
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments/:id/generate/phase2 -> generate 15 phase2 matches + scoreboards
router.post('/:id/generate/phase2', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('settings status publicCode')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const pools = await Pool.find({
      tournamentId: id,
      phase: 'phase2',
      name: { $in: PHASE2_POOL_NAMES },
    })
      .select('_id name teamIds homeCourt')
      .lean();

    const poolValidationError = validatePhase2PoolsForGeneration(pools);

    if (poolValidationError) {
      return res.status(400).json({ message: poolValidationError });
    }

    const forceRegenerate = parseBooleanFlag(req.query?.force, false);

    const existingPhase2Matches = await Match.find({
      tournamentId: id,
      phase: 'phase2',
    })
      .select('_id scoreboardId')
      .lean();

    if (existingPhase2Matches.length > 0 && !forceRegenerate) {
      return res.status(409).json({
        message: 'Phase 2 matches already generated. Re-run with ?force=true to regenerate.',
      });
    }

    if (existingPhase2Matches.length > 0 && forceRegenerate) {
      const staleScoreboardIds = existingPhase2Matches
        .map((match) => match.scoreboardId)
        .filter(Boolean);

      await Match.deleteMany({
        _id: { $in: existingPhase2Matches.map((match) => match._id) },
      });

      if (staleScoreboardIds.length > 0) {
        await Scoreboard.deleteMany({
          _id: { $in: staleScoreboardIds },
        });
      }
    }

    const teamIds = [...new Set(pools.flatMap((pool) => pool.teamIds.map((teamId) => toIdString(teamId))))];
    const teams = await TournamentTeam.find({
      _id: { $in: teamIds },
      tournamentId: id,
    })
      .select('name shortName logoUrl seed')
      .lean();

    if (teams.length !== teamIds.length) {
      return res.status(400).json({ message: 'Phase 2 pools include teams outside this tournament' });
    }

    const teamsById = new Map(teams.map((team) => [team._id.toString(), team]));
    const poolsByName = new Map(pools.map((pool) => [pool.name, pool]));
    const scoring = normalizeScoringConfig(tournament?.settings?.scoring);
    const createdMatchIds = [];
    const createdScoreboardIds = [];

    try {
      for (const poolName of PHASE2_POOL_NAMES) {
        const pool = poolsByName.get(poolName);
        const orderedTeamIds = pool.teamIds.map((teamId) => toIdString(teamId));
        const homeCourt = pool.homeCourt || PHASE2_POOL_HOME_COURTS[pool.name];
        const facility = getFacilityFromCourt(homeCourt);

        if (!facility) {
          throw new Error(`Pool ${pool.name} has an invalid home court`);
        }

        for (const matchTemplate of PHASE2_MATCH_ORDER) {
          const teamAId = orderedTeamIds[matchTemplate.teamAIndex];
          const teamBId = orderedTeamIds[matchTemplate.teamBIndex];
          const refTeamId = orderedTeamIds[matchTemplate.refIndex];
          const teamA = teamsById.get(teamAId);
          const teamB = teamsById.get(teamBId);

          if (!teamA || !teamB) {
            throw new Error(`Missing team data for Pool ${pool.name}`);
          }

          const scoreboard = await createMatchScoreboard({
            ownerId: req.user.id,
            title: `Pool ${pool.name} - Round ${matchTemplate.roundBlock}`,
            teamA,
            teamB,
            scoring,
          });

          createdScoreboardIds.push(scoreboard._id);

          const match = await Match.create({
            tournamentId: id,
            phase: 'phase2',
            poolId: pool._id,
            roundBlock: matchTemplate.roundBlock,
            facility,
            court: homeCourt,
            teamAId,
            teamBId,
            refTeamIds: [refTeamId],
            scoreboardId: scoreboard._id,
            status: 'scheduled',
          });

          cacheTournamentMatchEntry({
            scoreboardId: scoreboard._id,
            matchId: match._id,
            tournamentCode: tournament.publicCode,
          });
          createdMatchIds.push(match._id);
        }
      }
    } catch (generationError) {
      if (createdMatchIds.length > 0) {
        await Match.deleteMany({ _id: { $in: createdMatchIds } });
      }

      if (createdScoreboardIds.length > 0) {
        await Scoreboard.deleteMany({ _id: { $in: createdScoreboardIds } });
      }

      throw generationError;
    }

    await ensureTournamentStatusAtLeast(id, 'phase2');

    const matches = await loadMatchesForResponse({ _id: { $in: createdMatchIds } });
    emitTournamentEventFromRequest(
      req,
      tournament.publicCode,
      TOURNAMENT_EVENT_TYPES.MATCHES_GENERATED,
      {
        phase: 'phase2',
        matchIds: matches.map((match) => toIdString(match._id)).filter(Boolean),
      }
    );
    return res.status(201).json(matches);
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments/:id/generate/playoffs -> generate Gold/Silver/Bronze playoff brackets
router.post('/:id/generate/playoffs', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('settings status standingsOverrides publicCode')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const forceRegenerate = parseBooleanFlag(req.query?.force, false);

    const existingPlayoffMatches = await Match.find({
      tournamentId: id,
      phase: 'playoffs',
    })
      .select('_id scoreboardId')
      .lean();

    if (existingPlayoffMatches.length > 0 && !forceRegenerate) {
      return res.status(409).json({
        message: 'Playoff matches already generated. Re-run with ?force=true to regenerate.',
      });
    }

    if (existingPlayoffMatches.length > 0 && forceRegenerate) {
      const staleScoreboardIds = existingPlayoffMatches
        .map((match) => match.scoreboardId)
        .filter(Boolean);

      await Match.deleteMany({
        _id: { $in: existingPlayoffMatches.map((match) => match._id) },
      });

      if (staleScoreboardIds.length > 0) {
        await Scoreboard.deleteMany({
          _id: { $in: staleScoreboardIds },
        });
      }
    }

    const ranking = await computePlayoffGenerationRanking(id);

    if (!ranking.ok) {
      return res.status(400).json({
        message: 'Playoffs cannot be generated yet',
        missing: ranking.missing,
        phase2: {
          totalMatches: ranking.phase2MatchCount,
          finalizedMatches: ranking.phase2FinalizedCount,
          allFinalized: ranking.phase2AllFinalized,
        },
      });
    }

    const seedAssignments = buildPlayoffSeedAssignments(ranking.cumulativeOverall);

    if (!seedAssignments.ok) {
      return res.status(400).json({
        message: 'Playoffs cannot be generated yet',
        missing: seedAssignments.missing,
      });
    }

    const playoffPlan = createPlayoffMatchPlan(seedAssignments.brackets);
    const scoring = normalizeScoringConfig(tournament?.settings?.scoring);
    const createdMatchIds = [];
    const createdScoreboardIds = [];
    const createdMatchesByKey = new Map();

    try {
      for (const plannedMatch of playoffPlan) {
        const teamAFromMatch = plannedMatch.teamAFromMatchKey
          ? createdMatchesByKey.get(plannedMatch.teamAFromMatchKey)
          : null;
        const teamBFromMatch = plannedMatch.teamBFromMatchKey
          ? createdMatchesByKey.get(plannedMatch.teamBFromMatchKey)
          : null;

        if (plannedMatch.teamAFromMatchKey && !teamAFromMatch) {
          throw new Error(`Missing dependency for ${plannedMatch.bracketMatchKey}: ${plannedMatch.teamAFromMatchKey}`);
        }
        if (plannedMatch.teamBFromMatchKey && !teamBFromMatch) {
          throw new Error(`Missing dependency for ${plannedMatch.bracketMatchKey}: ${plannedMatch.teamBFromMatchKey}`);
        }

        const scoreboard = await createScoreboard({
          ownerId: req.user.id,
          title: plannedMatch.title,
          teams: [{ name: plannedMatch.teamAName }, { name: plannedMatch.teamBName }],
          servingTeamIndex: null,
          temporary: false,
          scoring,
        });

        createdScoreboardIds.push(scoreboard._id);

        const match = await Match.create({
          tournamentId: id,
          phase: 'playoffs',
          poolId: null,
          bracket: plannedMatch.bracket,
          bracketRound: plannedMatch.bracketRound,
          bracketMatchKey: plannedMatch.bracketMatchKey,
          seedA: plannedMatch.seedA ?? null,
          seedB: plannedMatch.seedB ?? null,
          teamAFromMatchId: teamAFromMatch?._id || null,
          teamAFromSlot: plannedMatch.teamAFromSlot || null,
          teamBFromMatchId: teamBFromMatch?._id || null,
          teamBFromSlot: plannedMatch.teamBFromSlot || null,
          roundBlock: plannedMatch.roundBlock,
          facility: plannedMatch.facility,
          court: plannedMatch.court,
          teamAId: plannedMatch.teamAId || null,
          teamBId: plannedMatch.teamBId || null,
          refTeamIds: plannedMatch.refTeamIds || [],
          scoreboardId: scoreboard._id,
          status: 'scheduled',
        });

        cacheTournamentMatchEntry({
          scoreboardId: scoreboard._id,
          matchId: match._id,
          tournamentCode: tournament.publicCode,
        });
        createdMatchIds.push(match._id);
        createdMatchesByKey.set(plannedMatch.bracketMatchKey, match);
      }
    } catch (generationError) {
      if (createdMatchIds.length > 0) {
        await Match.deleteMany({ _id: { $in: createdMatchIds } });
      }

      if (createdScoreboardIds.length > 0) {
        await Scoreboard.deleteMany({ _id: { $in: createdScoreboardIds } });
      }

      throw generationError;
    }

    await Promise.all(
      PLAYOFF_BRACKETS.map((bracket) => recomputePlayoffBracketProgression(id, bracket))
    );

    await ensureTournamentStatusAtLeast(id, 'playoffs');

    const createdMatches = await loadMatchesForResponse({ _id: { $in: createdMatchIds } });
    const payload = buildPlayoffPayload(createdMatches);
    emitTournamentEventFromRequest(
      req,
      tournament.publicCode,
      TOURNAMENT_EVENT_TYPES.MATCHES_GENERATED,
      {
        phase: 'playoffs',
        matchIds: createdMatches.map((match) => toIdString(match._id)).filter(Boolean),
      }
    );
    PLAYOFF_BRACKETS.forEach((bracket) => {
      const affectedMatchIds = createdMatches
        .filter((match) => normalizeBracket(match.bracket) === bracket)
        .map((match) => toIdString(match._id))
        .filter(Boolean);

      emitTournamentEventFromRequest(
        req,
        tournament.publicCode,
        TOURNAMENT_EVENT_TYPES.PLAYOFFS_BRACKET_UPDATED,
        {
          bracket,
          affectedMatchIds,
        }
      );
    });

    return res.status(201).json({
      source: ranking.usedPhase2OverallOverride ? 'override' : 'finalized',
      seeds: seedAssignments.brackets,
      phase2: {
        totalMatches: ranking.phase2MatchCount,
        finalizedMatches: ranking.phase2FinalizedCount,
        allFinalized: ranking.phase2AllFinalized,
      },
      ...payload,
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/playoffs -> owner playoff bracket + ops schedule
router.get('/:id/playoffs', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const ownedTournament = await ensureTournamentOwnership(id, req.user.id);

    if (!ownedTournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const playoffMatches = await loadMatchesForResponse({
      tournamentId: id,
      phase: 'playoffs',
    });

    return res.json(buildPlayoffPayload(playoffMatches));
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/playoffs/ops -> owner printable playoff ops schedule
router.get('/:id/playoffs/ops', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const ownedTournament = await ensureTournamentOwnership(id, req.user.id);

    if (!ownedTournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const playoffMatches = await loadMatchesForResponse({
      tournamentId: id,
      phase: 'playoffs',
    });
    const payload = buildPlayoffPayload(playoffMatches);

    return res.json({
      roundBlocks: payload.opsSchedule,
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/matches?phase=phase1|phase2|playoffs -> owned tournament matches
router.get('/:id/matches', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const phaseError = validateMatchPhaseFilter(req.query?.phase);

    if (phaseError) {
      return res.status(400).json({ message: phaseError });
    }

    const ownedTournament = await ensureTournamentOwnership(id, req.user.id);

    if (!ownedTournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const query = { tournamentId: id };

    if (req.query?.phase) {
      query.phase = req.query.phase;
    }

    const matches = await loadMatchesForResponse(query);
    return res.json(matches);
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/standings?phase=phase1|phase2|cumulative -> owned tournament standings
router.get('/:id/standings', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const phase = normalizeStandingsPhase(req.query?.phase);

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const phaseError = validateStandingsPhaseFilter(phase);

    if (phaseError) {
      return res.status(400).json({ message: phaseError });
    }

    const ownedTournament = await ensureTournamentOwnership(id, req.user.id);

    if (!ownedTournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const standings = await computeStandingsBundle(id, phase);

    return res.json({
      phase,
      basedOn: 'finalized',
      ...formatStandingsPayload(standings),
    });
  } catch (error) {
    return next(error);
  }
});

// PUT /api/tournaments/:id/standings-overrides -> owner-only tie/ordering overrides
router.put('/:id/standings-overrides', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const phase = normalizeStandingsPhase(req.body?.phase);
    const hasPoolOrder = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'poolOrder');
    const hasOverallOrder = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'overallOrder');
    const poolName = req.body?.poolName;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const phaseError = validateStandingsOverridePhaseFilter(phase);

    if (phaseError) {
      return res.status(400).json({ message: phaseError });
    }

    if (!hasPoolOrder && !hasOverallOrder) {
      return res.status(400).json({ message: 'Provide poolOrder and/or overallOrder' });
    }

    const poolOrder = hasPoolOrder ? normalizeTeamIdList(req.body?.poolOrder) : null;
    const overallOrder = hasOverallOrder ? normalizeTeamIdList(req.body?.overallOrder) : null;

    if (hasPoolOrder && !poolOrder) {
      return res.status(400).json({ message: 'poolOrder must be an array of team ids' });
    }

    if (hasOverallOrder && !overallOrder) {
      return res.status(400).json({ message: 'overallOrder must be an array of team ids' });
    }

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('_id standingsOverrides')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const allTeams = await TournamentTeam.find({ tournamentId: id }).select('_id').lean();
    const allTeamIds = allTeams.map((team) => toIdString(team._id));
    const tournamentTeamIdSet = new Set(allTeamIds);

    const updates = {};

    if (hasPoolOrder) {
      if (!isNonEmptyString(poolName)) {
        return res.status(400).json({ message: 'poolName is required when setting poolOrder' });
      }

      if (poolOrder.some((teamId) => !isObjectId(teamId))) {
        return res.status(400).json({ message: 'poolOrder includes an invalid team id' });
      }

      if (!poolOrder.every((teamId) => tournamentTeamIdSet.has(teamId))) {
        return res.status(400).json({ message: 'poolOrder teams must belong to this tournament' });
      }

      const pool = await Pool.findOne({
        tournamentId: id,
        phase,
        name: poolName.trim(),
      })
        .select('teamIds name')
        .lean();

      if (!pool) {
        return res.status(404).json({ message: 'Pool not found for this phase' });
      }

      const poolTeamIds = Array.isArray(pool.teamIds)
        ? pool.teamIds.map((teamId) => toIdString(teamId)).filter(Boolean)
        : [];

      if (!isPermutation(poolOrder, poolTeamIds)) {
        return res.status(400).json({
          message: 'poolOrder must be a permutation of the teams assigned to that pool',
        });
      }

      updates[`standingsOverrides.${phase}.poolOrderOverrides.${pool.name}`] = poolOrder;
    }

    if (hasOverallOrder) {
      if (overallOrder.some((teamId) => !isObjectId(teamId))) {
        return res.status(400).json({ message: 'overallOrder includes an invalid team id' });
      }

      if (!overallOrder.every((teamId) => tournamentTeamIdSet.has(teamId))) {
        return res.status(400).json({ message: 'overallOrder teams must belong to this tournament' });
      }

      if (!isPermutation(overallOrder, allTeamIds)) {
        return res.status(400).json({
          message: 'overallOrder must be a permutation of all tournament teams',
        });
      }

      updates[`standingsOverrides.${phase}.overallOrderOverrides`] = overallOrder;
    }

    const updatedTournament = await Tournament.findOneAndUpdate(
      {
        _id: id,
        createdByUserId: req.user.id,
      },
      { $set: updates },
      {
        new: true,
        runValidators: true,
        omitUndefined: true,
      }
    ).lean();

    return res.json({
      phase,
      overrides: serializePhaseOverrides(updatedTournament?.standingsOverrides?.[phase]),
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id -> fetch tournament details and basic counts
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    }).lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const [teamsCount, poolsCount, matchesCount] = await Promise.all([
      TournamentTeam.countDocuments({ tournamentId: id }),
      Pool.countDocuments({ tournamentId: id }),
      Match.countDocuments({ tournamentId: id }),
    ]);

    return res.json({
      ...attachTournamentScheduleDefaults(tournament),
      teamsCount,
      poolsCount,
      matchesCount,
    });
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments/:id/teams -> create one or many tournament teams
router.post('/:id/teams', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const ownedTournament = await ensureTournamentOwnership(id, req.user.id);

    if (!ownedTournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const rawTeams = Array.isArray(req.body) ? req.body : [req.body];

    if (!rawTeams.length) {
      return res.status(400).json({ message: 'At least one team payload is required' });
    }

    for (let index = 0; index < rawTeams.length; index += 1) {
      const validationError = validateTeamPayload(rawTeams[index], index);

      if (validationError) {
        return res.status(400).json({ message: validationError });
      }
    }

    const existingTeams = await TournamentTeam.find({ tournamentId: id })
      .select('_id orderIndex createdAt name shortName')
      .lean();
    const maxExistingOrderIndex = existingTeams.reduce((maxValue, team) => {
      const normalized = normalizeTeamOrderIndex(team?.orderIndex);
      if (normalized === null) {
        return maxValue;
      }

      return Math.max(maxValue, normalized);
    }, 0);

    let nextOrderIndex =
      maxExistingOrderIndex > 0 ? maxExistingOrderIndex + 1 : existingTeams.length + 1;
    const payload = rawTeams.map((team) => {
      const teamPayload = buildTeamInsertPayload(team, id, nextOrderIndex);
      nextOrderIndex += 1;
      return teamPayload;
    });

    if (Array.isArray(req.body)) {
      const createdTeams = await TournamentTeam.insertMany(payload, { ordered: true });
      return res.status(201).json(createdTeams.map((team) => team.toObject()));
    }

    const createdTeam = await TournamentTeam.create(payload[0]);
    return res.status(201).json(createdTeam.toObject());
  } catch (error) {
    return next(error);
  }
});

// PUT /api/tournaments/:id/teams/order -> update tournament team order indices
router.put('/:id/teams/order', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const ownedTournament = await ensureTournamentOwnership(id, req.user.id);

    if (!ownedTournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    if (!Array.isArray(req.body?.orderedTeamIds)) {
      return res.status(400).json({ message: 'orderedTeamIds must be an array of team ids' });
    }

    const orderedTeamIds = req.body.orderedTeamIds.map((teamId) => toIdString(teamId)).filter(Boolean);

    if (orderedTeamIds.some((teamId) => !isObjectId(teamId))) {
      return res.status(400).json({ message: 'orderedTeamIds includes an invalid team id' });
    }

    const tournamentTeams = await TournamentTeam.find({ tournamentId: id })
      .select('_id')
      .lean();
    const tournamentTeamIds = tournamentTeams.map((team) => toIdString(team._id)).filter(Boolean);

    if (!isPermutation(orderedTeamIds, tournamentTeamIds)) {
      return res.status(400).json({
        message: 'orderedTeamIds must be a permutation of all tournament team ids',
      });
    }

    const writeOperations = orderedTeamIds.map((teamId, index) => ({
      updateOne: {
        filter: { _id: teamId, tournamentId: id },
        update: { $set: { orderIndex: index + 1 } },
      },
    }));

    if (writeOperations.length > 0) {
      await TournamentTeam.bulkWrite(writeOperations, { ordered: true });
    }

    const teams = await TournamentTeam.find({ tournamentId: id }).lean();
    teams.sort(compareTeamsByTournamentOrder);
    return res.json(teams);
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/teams -> list teams for an owned tournament
router.get('/:id/teams', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const ownedTournament = await ensureTournamentOwnership(id, req.user.id);

    if (!ownedTournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const teams = await TournamentTeam.find({ tournamentId: id }).lean();
    teams.sort(compareTeamsByTournamentOrder);

    return res.json(teams);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

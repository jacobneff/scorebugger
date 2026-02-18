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
const { createMatchScoreboard } = require('../services/scoreboards');
const { computeStandingsBundle } = require('../services/tournamentEngine/standings');
const {
  CODE_LENGTH,
  createUniqueTournamentPublicCode,
} = require('../utils/tournamentPublicCode');

const router = express.Router();

const TOURNAMENT_STATUSES = ['setup', 'phase1', 'phase2', 'playoffs', 'complete'];
const MATCH_PHASES = ['phase1', 'phase2', 'playoffs'];
const STANDINGS_PHASES = ['phase1'];
const DUPLICATE_KEY_ERROR_CODE = 11000;

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const isDuplicatePublicCodeError = (error) =>
  error?.code === DUPLICATE_KEY_ERROR_CODE &&
  (error?.keyPattern?.publicCode || error?.keyValue?.publicCode);

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const parseTournamentDate = (value) => {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const normalizePublicCode = (value) =>
  typeof value === 'string' ? value.trim().toUpperCase() : '';

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

function validateStandingsPhaseFilter(phase) {
  if (!phase) {
    return null;
  }

  return STANDINGS_PHASES.includes(phase) ? null : 'Invalid standings phase';
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

  if (!isNonEmptyString(rawTeam.name)) {
    return `Team name is required at index ${index}`;
  }

  if (!isNonEmptyString(rawTeam.shortName)) {
    return `Team shortName is required at index ${index}`;
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

function buildTeamInsertPayload(rawTeam, tournamentId) {
  const team = {
    tournamentId,
    name: rawTeam.name.trim(),
    shortName: rawTeam.shortName.trim(),
  };

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
              seed: team.seed ?? null,
            }
          : { _id: toIdString(team) }
      )
    : [];

  return {
    _id: toIdString(pool?._id),
    tournamentId: toIdString(pool?.tournamentId),
    phase: pool?.phase ?? null,
    name: pool?.name ?? '',
    homeCourt: pool?.homeCourt ?? null,
    teamIds,
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
    query = query.populate('teamIds', 'name shortName logoUrl seed');
  }

  const pools = await query.lean();
  return pools.sort(sortPoolsByPhase1Name);
}

async function loadMatchesForResponse(query) {
  const matches = await Match.find(query)
    .populate('poolId', 'name')
    .populate('teamAId', 'name shortName logoUrl seed')
    .populate('teamBId', 'name shortName logoUrl seed')
    .populate('refTeamIds', 'name shortName logoUrl seed')
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

async function findTournamentForPublicCode(publicCode) {
  return Tournament.findOne({ publicCode }).select('_id name date timezone status facilities publicCode').lean();
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
      .select('name shortName logoUrl seed')
      .sort({ seed: 1, name: 1 })
      .lean();

    return res.json({
      tournament: {
        id: tournament._id.toString(),
        name: tournament.name,
        date: tournament.date,
        timezone: tournament.timezone,
        status: tournament.status,
        facilities: tournament.facilities,
        publicCode: tournament.publicCode,
      },
      teams: teams.map((team) => ({
        id: team._id.toString(),
        name: team.name,
        shortName: team.shortName,
        logoUrl: team.logoUrl || null,
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

// GET /api/tournaments/code/:publicCode/standings?phase=phase1 -> public standings
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

    const ownedTournament = await ensureTournamentOwnership(id, req.user.id);

    if (!ownedTournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const assignSeeds = parseBooleanFlag(
      req.query?.assignSeeds ?? req.body?.assignSeeds,
      true
    );

    const existingPools = await Pool.find({
      tournamentId: id,
      phase: 'phase1',
      name: { $in: PHASE1_POOL_NAMES },
    }).lean();

    let assignments = null;

    if (existingPools.length === 0 && assignSeeds) {
      const teams = await TournamentTeam.find({ tournamentId: id })
        .select('_id name seed')
        .lean();

      teams.sort((teamA, teamB) => {
        const teamASeed = Number.isFinite(Number(teamA.seed))
          ? Number(teamA.seed)
          : Number.MAX_SAFE_INTEGER;
        const teamBSeed = Number.isFinite(Number(teamB.seed))
          ? Number(teamB.seed)
          : Number.MAX_SAFE_INTEGER;

        if (teamASeed !== teamBSeed) {
          return teamASeed - teamBSeed;
        }

        const teamAName = typeof teamA.name === 'string' ? teamA.name : '';
        const teamBName = typeof teamB.name === 'string' ? teamB.name : '';
        return teamAName.localeCompare(teamBName);
      });

      assignments = buildSerpentineAssignments(teams);
    }

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
              teamIds: assignments?.[poolName] || [],
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

    const ownedTournament = await ensureTournamentOwnership(id, req.user.id);

    if (!ownedTournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const pools = await loadPhase1Pools(id, { populateTeams: true });
    return res.json(pools.map(serializePool));
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
      .select('settings status')
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
    return res.status(201).json(matches);
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

// GET /api/tournaments/:id/standings?phase=phase1 -> owned tournament standings
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

    const phaseError = validateStandingsPhaseFilter(phase);

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
      ...tournament,
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

    const payload = rawTeams.map((team) => buildTeamInsertPayload(team, id));

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

    const teams = await TournamentTeam.find({ tournamentId: id })
      .sort({ seed: 1, name: 1 })
      .lean();

    return res.json(teams);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

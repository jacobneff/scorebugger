const express = require('express');
const mongoose = require('mongoose');

const Tournament = require('../models/Tournament');
const TournamentTeam = require('../models/TournamentTeam');
const Pool = require('../models/Pool');
const Match = require('../models/Match');
const { requireAuth } = require('../middleware/auth');
const {
  CODE_LENGTH,
  createUniqueTournamentPublicCode,
} = require('../utils/tournamentPublicCode');

const router = express.Router();

const TOURNAMENT_STATUSES = ['setup', 'phase1', 'phase2', 'playoffs', 'complete'];
const MATCH_PHASES = ['phase1', 'phase2', 'playoffs'];
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

// GET /api/tournaments/code/:publicCode -> public tournament + teams payload
router.get('/code/:publicCode', async (req, res, next) => {
  try {
    const publicCode = normalizePublicCode(req.params.publicCode);

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode)) {
      return res.status(400).json({ message: 'Invalid tournament code' });
    }

    const tournament = await Tournament.findOne({ publicCode })
      .select('name date timezone status facilities publicCode')
      .lean();

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

// GET /api/tournaments/code/:publicCode/matches?phase=phase1|phase2|playoffs
router.get('/code/:publicCode/matches', async (req, res, next) => {
  try {
    const publicCode = normalizePublicCode(req.params.publicCode);

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode)) {
      return res.status(400).json({ message: 'Invalid tournament code' });
    }

    const { phase } = req.query;

    if (phase && !MATCH_PHASES.includes(phase)) {
      return res.status(400).json({ message: 'Invalid phase filter' });
    }

    const tournament = await Tournament.findOne({ publicCode }).select('_id').lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const query = {
      tournamentId: tournament._id,
    };

    if (phase) {
      query.phase = phase;
    }

    const matches = await Match.find(query)
      .select(
        [
          'phase',
          'poolId',
          'bracket',
          'bracketRound',
          'roundBlock',
          'facility',
          'court',
          'teamAId',
          'teamBId',
          'refTeamIds',
          'scoreboardId',
          'status',
          'finalizedAt',
          'createdAt',
          'updatedAt',
        ].join(' ')
      )
      .sort({ phase: 1, roundBlock: 1, createdAt: 1 })
      .lean();

    return res.json(matches);
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

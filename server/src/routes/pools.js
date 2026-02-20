const express = require('express');
const mongoose = require('mongoose');

const Pool = require('../models/Pool');
const TournamentTeam = require('../models/TournamentTeam');
const { DEFAULT_15_TEAM_FORMAT_ID, getFormat } = require('../tournamentFormats/formatRegistry');
const { requireAuth } = require('../middleware/auth');
const { recomputePhase2RematchWarnings } = require('../services/phase2');
const { normalizeCourtCode } = require('../services/phase1');
const { findCourtInVenue } = require('../utils/venue');
const {
  TOURNAMENT_EVENT_TYPES,
  emitTournamentEvent,
} = require('../services/tournamentRealtime');
const { requireTournamentAdminContext } = require('../services/tournamentAccess');

const router = express.Router();

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const toIdString = (value) => (value ? value.toString() : null);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const serializeTeam = (team) => ({
  _id: toIdString(team?._id),
  name: team?.name ?? '',
  shortName: team?.shortName ?? '',
  orderIndex: team?.orderIndex ?? null,
  seed: team?.seed ?? null,
  logoUrl: team?.logoUrl ?? null,
});

const serializePool = (pool) => ({
  _id: toIdString(pool?._id),
  tournamentId: toIdString(pool?.tournamentId),
  phase: pool?.phase ?? null,
  stageKey: pool?.stageKey ?? null,
  name: pool?.name ?? '',
  homeCourt: pool?.homeCourt ?? null,
  assignedCourtId: pool?.assignedCourtId ?? null,
  assignedFacilityId: pool?.assignedFacilityId ?? null,
  requiredTeamCount:
    Number.isFinite(Number(pool?.requiredTeamCount)) && Number(pool.requiredTeamCount) > 0
      ? Math.floor(Number(pool.requiredTeamCount))
      : null,
  teamIds: Array.isArray(pool?.teamIds) ? pool.teamIds.map(serializeTeam) : [],
  rematchWarnings: Array.isArray(pool?.rematchWarnings)
    ? pool.rematchWarnings
        .map((warning) => ({
          teamIdA: toIdString(warning?.teamIdA),
          teamIdB: toIdString(warning?.teamIdB),
        }))
        .filter((warning) => warning.teamIdA && warning.teamIdB)
    : [],
  createdAt: pool?.createdAt ?? null,
  updatedAt: pool?.updatedAt ?? null,
});

async function resolveRequiredTeamCountFromFormat(pool, tournament) {
  if (!pool || !tournament) {
    return null;
  }

  const explicitFormatId = isNonEmptyString(tournament?.settings?.format?.formatId)
    ? tournament.settings.format.formatId.trim()
    : '';
  let formatId = explicitFormatId;

  if (!formatId) {
    const teamCount = await TournamentTeam.countDocuments({ tournamentId: pool.tournamentId });
    if (Number(teamCount) === 15) {
      formatId = DEFAULT_15_TEAM_FORMAT_ID;
    }
  }

  if (!formatId) {
    return null;
  }

  const formatDef = getFormat(formatId);
  if (!formatDef || !Array.isArray(formatDef.stages)) {
    return null;
  }

  const poolPlayStages = formatDef.stages.filter((stage) => stage?.type === 'poolPlay');
  const normalizedStageKey = isNonEmptyString(pool?.stageKey) ? pool.stageKey.trim() : '';
  let stageDef =
    normalizedStageKey &&
    poolPlayStages.find((stage) => isNonEmptyString(stage?.key) && stage.key === normalizedStageKey);

  if (!stageDef) {
    if (pool?.phase === 'phase2') {
      stageDef = poolPlayStages[1] || null;
    } else {
      stageDef = poolPlayStages[0] || null;
    }
  }

  if (!stageDef || !Array.isArray(stageDef.pools)) {
    return null;
  }

  const poolDef = stageDef.pools.find(
    (entry) => isNonEmptyString(entry?.name) && entry.name === pool?.name
  );
  const size = Number(poolDef?.size);

  if (!Number.isFinite(size) || size <= 0) {
    return null;
  }

  return Math.floor(size);
}

// PATCH /api/pools/:poolId -> update ordered teams in a pool
router.patch('/:poolId', requireAuth, async (req, res, next) => {
  try {
    const { poolId } = req.params;
    const hasTeamIds = Object.prototype.hasOwnProperty.call(req.body || {}, 'teamIds');
    const hasHomeCourt = Object.prototype.hasOwnProperty.call(req.body || {}, 'homeCourt');
    const hasAssignedCourtId = Object.prototype.hasOwnProperty.call(
      req.body || {},
      'assignedCourtId'
    );

    if (!isObjectId(poolId)) {
      return res.status(400).json({ message: 'Invalid pool id' });
    }

    if (!hasTeamIds && !hasHomeCourt && !hasAssignedCourtId) {
      return res.status(400).json({ message: 'Provide teamIds, homeCourt, and/or assignedCourtId' });
    }

    if (hasTeamIds && !Array.isArray(req.body?.teamIds)) {
      return res.status(400).json({ message: 'teamIds must be an array' });
    }

    const nextTeamIds = hasTeamIds ? req.body.teamIds.map((teamId) => String(teamId)) : null;

    if (hasTeamIds && new Set(nextTeamIds).size !== nextTeamIds.length) {
      return res.status(400).json({ message: 'Duplicate team id in pool payload' });
    }

    if (hasTeamIds && nextTeamIds.some((teamId) => !isObjectId(teamId))) {
      return res.status(400).json({ message: 'Invalid team id in teamIds payload' });
    }

    let nextHomeCourt = null;
    if (hasHomeCourt) {
      if (req.body.homeCourt === null || req.body.homeCourt === '') {
        nextHomeCourt = null;
      } else if (typeof req.body.homeCourt !== 'string') {
        return res.status(400).json({ message: 'homeCourt must be a string or null' });
      } else {
        nextHomeCourt = normalizeCourtCode(req.body.homeCourt);
      }
    }

    let nextAssignedCourtId = null;
    if (hasAssignedCourtId) {
      if (req.body.assignedCourtId === null || req.body.assignedCourtId === '') {
        nextAssignedCourtId = null;
      } else if (typeof req.body.assignedCourtId !== 'string') {
        return res.status(400).json({ message: 'assignedCourtId must be a string or null' });
      } else {
        nextAssignedCourtId = req.body.assignedCourtId.trim();
      }
    }

    const pool = await Pool.findById(poolId).lean();

    if (!pool) {
      return res.status(404).json({ message: 'Pool not found' });
    }

    const accessContext = await requireTournamentAdminContext(
      pool.tournamentId,
      req.user.id,
      '_id publicCode facilities settings.format settings.venue'
    );
    const ownedTournament = accessContext?.tournament || null;
    if (!ownedTournament) {
      return res.status(404).json({ message: 'Pool not found or unauthorized' });
    }

    const requiredTeamCountFromPool =
      Number.isFinite(Number(pool?.requiredTeamCount)) && Number(pool.requiredTeamCount) > 0
        ? Math.floor(Number(pool.requiredTeamCount))
        : null;
    const requiredTeamCountFromFormat = await resolveRequiredTeamCountFromFormat(
      pool,
      ownedTournament
    );
    const requiredTeamCount =
      requiredTeamCountFromPool || requiredTeamCountFromFormat || 3;

    if (hasTeamIds && nextTeamIds.length > requiredTeamCount) {
      return res.status(400).json({
        message: `A pool can include at most ${requiredTeamCount} teams`,
      });
    }

    const availableCourtSet = new Set(
      [
        ...(Array.isArray(ownedTournament?.facilities?.SRC) ? ownedTournament.facilities.SRC : []),
        ...(Array.isArray(ownedTournament?.facilities?.VC) ? ownedTournament.facilities.VC : []),
      ]
        .map((entry) => normalizeCourtCode(entry))
        .filter(Boolean)
    );

    if (hasHomeCourt && nextHomeCourt && !availableCourtSet.has(nextHomeCourt)) {
      const resolvedVenueCourt = findCourtInVenue(ownedTournament?.settings?.venue, nextHomeCourt);
      if (!resolvedVenueCourt) {
        return res.status(400).json({
          message: 'homeCourt must be one of the configured tournament facilities or venue courts',
        });
      }
    }

    let assignedFacilityIdFromVenue = null;
    if (hasAssignedCourtId && nextAssignedCourtId) {
      const resolvedVenueCourt = findCourtInVenue(
        ownedTournament?.settings?.venue,
        nextAssignedCourtId
      );

      if (!resolvedVenueCourt) {
        return res.status(400).json({
          message: 'assignedCourtId must reference an existing venue court',
        });
      }

      nextAssignedCourtId = resolvedVenueCourt.courtId;
      assignedFacilityIdFromVenue = resolvedVenueCourt.facilityId || null;
    }

    if (hasTeamIds && nextTeamIds.length > 0) {
      const teams = await TournamentTeam.find({
        _id: { $in: nextTeamIds },
        tournamentId: pool.tournamentId,
      })
        .select('_id')
        .lean();

      if (teams.length !== nextTeamIds.length) {
        return res.status(400).json({ message: 'All teams must belong to the same tournament' });
      }

      const sameStageFilter = pool.stageKey
        ? { stageKey: pool.stageKey }
        : {
            phase: pool.phase,
            $or: [{ stageKey: null }, { stageKey: { $exists: false } }],
          };

      const conflictingPool = await Pool.findOne({
        _id: { $ne: pool._id },
        tournamentId: pool.tournamentId,
        teamIds: { $in: nextTeamIds },
        ...sameStageFilter,
      })
        .select('_id name')
        .lean();

      if (conflictingPool) {
        return res.status(400).json({
          message: `A team cannot appear in multiple ${pool.stageKey || pool.phase} pools`,
          conflictingPoolId: conflictingPool._id.toString(),
          conflictingPoolName: conflictingPool.name,
        });
      }
    }

    const updates = {};
    if (hasTeamIds) {
      updates.teamIds = nextTeamIds;
      // Keep requiredTeamCount on the same update so query validators enforce
      // the pool's configured capacity instead of falling back to legacy size 3.
      updates.requiredTeamCount = requiredTeamCount;
    }
    if (hasHomeCourt) {
      updates.homeCourt = nextHomeCourt;
    }
    if (hasAssignedCourtId) {
      updates.assignedCourtId = nextAssignedCourtId;
      updates.assignedFacilityId = nextAssignedCourtId ? assignedFacilityIdFromVenue : null;
    }

    const updatedPool = await Pool.findByIdAndUpdate(
      pool._id,
      { $set: updates },
      {
        new: true,
        runValidators: true,
      }
    )
      .populate('teamIds', 'name shortName orderIndex seed logoUrl')
      .lean();

    if (pool.phase === 'phase2') {
      await recomputePhase2RematchWarnings(pool.tournamentId);
    }

    const finalizedPool = await Pool.findById(updatedPool._id)
      .populate('teamIds', 'name shortName orderIndex seed logoUrl')
      .lean();
    const io = req.app?.get('io');
    emitTournamentEvent(
      io,
      ownedTournament.publicCode,
      TOURNAMENT_EVENT_TYPES.POOLS_UPDATED,
      {
        phase: pool.phase,
        stageKey: pool.stageKey || null,
        poolIds: [toIdString(finalizedPool._id)].filter(Boolean),
      }
    );

    return res.json(serializePool(finalizedPool));
  } catch (error) {
    return next(error);
  }
});

// PUT /api/pools/:poolId/assign-court -> assign a pool to a venue court
router.put('/:poolId/assign-court', requireAuth, async (req, res, next) => {
  try {
    const { poolId } = req.params;
    const assignedCourtId =
      typeof req.body?.assignedCourtId === 'string' ? req.body.assignedCourtId.trim() : '';

    if (!isObjectId(poolId)) {
      return res.status(400).json({ message: 'Invalid pool id' });
    }

    if (!assignedCourtId) {
      return res.status(400).json({ message: 'assignedCourtId is required' });
    }

    const pool = await Pool.findById(poolId).lean();
    if (!pool) {
      return res.status(404).json({ message: 'Pool not found' });
    }

    const adminContext = await requireTournamentAdminContext(
      pool.tournamentId,
      req.user.id,
      '_id publicCode settings.venue'
    );
    const tournament = adminContext?.tournament || null;

    if (!tournament) {
      return res.status(404).json({ message: 'Pool not found or unauthorized' });
    }

    const venueCourt = findCourtInVenue(tournament?.settings?.venue, assignedCourtId);
    if (!venueCourt) {
      return res.status(400).json({ message: 'assignedCourtId must reference an existing venue court' });
    }

    const updatedPool = await Pool.findByIdAndUpdate(
      pool._id,
      {
        $set: {
          assignedCourtId: venueCourt.courtId,
          assignedFacilityId: venueCourt.facilityId || null,
          // Keep legacy homeCourt aligned to preserve older screens.
          homeCourt: venueCourt.courtName || null,
        },
      },
      {
        new: true,
        runValidators: true,
      }
    )
      .populate('teamIds', 'name shortName orderIndex seed logoUrl')
      .lean();

    const io = req.app?.get('io');
    emitTournamentEvent(
      io,
      tournament.publicCode,
      TOURNAMENT_EVENT_TYPES.POOLS_UPDATED,
      {
        phase: updatedPool?.phase || pool.phase,
        stageKey: updatedPool?.stageKey || pool.stageKey || null,
        poolIds: [toIdString(updatedPool?._id || pool._id)].filter(Boolean),
      }
    );

    return res.json(serializePool(updatedPool));
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

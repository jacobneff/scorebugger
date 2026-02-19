const express = require('express');
const mongoose = require('mongoose');

const Pool = require('../models/Pool');
const Tournament = require('../models/Tournament');
const TournamentTeam = require('../models/TournamentTeam');
const { requireAuth } = require('../middleware/auth');
const { recomputePhase2RematchWarnings } = require('../services/phase2');
const { normalizeCourtCode } = require('../services/phase1');
const {
  TOURNAMENT_EVENT_TYPES,
  emitTournamentEvent,
} = require('../services/tournamentRealtime');

const router = express.Router();

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const toIdString = (value) => (value ? value.toString() : null);

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

// PATCH /api/pools/:poolId -> update ordered teams in a pool
router.patch('/:poolId', requireAuth, async (req, res, next) => {
  try {
    const { poolId } = req.params;
    const hasTeamIds = Object.prototype.hasOwnProperty.call(req.body || {}, 'teamIds');
    const hasHomeCourt = Object.prototype.hasOwnProperty.call(req.body || {}, 'homeCourt');

    if (!isObjectId(poolId)) {
      return res.status(400).json({ message: 'Invalid pool id' });
    }

    if (!hasTeamIds && !hasHomeCourt) {
      return res.status(400).json({ message: 'Provide teamIds and/or homeCourt' });
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

    const pool = await Pool.findById(poolId).lean();

    if (!pool) {
      return res.status(404).json({ message: 'Pool not found' });
    }

    const requiredTeamCount =
      Number.isFinite(Number(pool?.requiredTeamCount)) && Number(pool.requiredTeamCount) > 0
        ? Math.floor(Number(pool.requiredTeamCount))
        : 3;

    if (hasTeamIds && nextTeamIds.length > requiredTeamCount) {
      return res.status(400).json({
        message: `A pool can include at most ${requiredTeamCount} teams`,
      });
    }

    const ownedTournament = await Tournament.findOne({
      _id: pool.tournamentId,
      createdByUserId: req.user.id,
    })
      .select('_id publicCode facilities')
      .lean();

    if (!ownedTournament) {
      return res.status(404).json({ message: 'Pool not found or unauthorized' });
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
      return res.status(400).json({
        message: 'homeCourt must be one of the configured tournament facilities',
      });
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

module.exports = router;

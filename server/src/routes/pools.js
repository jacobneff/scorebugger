const express = require('express');
const mongoose = require('mongoose');

const Pool = require('../models/Pool');
const Tournament = require('../models/Tournament');
const TournamentTeam = require('../models/TournamentTeam');
const { requireAuth } = require('../middleware/auth');
const { recomputePhase2RematchWarnings } = require('../services/phase2');

const router = express.Router();

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const toIdString = (value) => (value ? value.toString() : null);

const serializeTeam = (team) => ({
  _id: toIdString(team?._id),
  name: team?.name ?? '',
  shortName: team?.shortName ?? '',
  seed: team?.seed ?? null,
  logoUrl: team?.logoUrl ?? null,
});

const serializePool = (pool) => ({
  _id: toIdString(pool?._id),
  tournamentId: toIdString(pool?.tournamentId),
  phase: pool?.phase ?? null,
  name: pool?.name ?? '',
  homeCourt: pool?.homeCourt ?? null,
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

    if (!isObjectId(poolId)) {
      return res.status(400).json({ message: 'Invalid pool id' });
    }

    if (!Array.isArray(req.body?.teamIds)) {
      return res.status(400).json({ message: 'teamIds must be an array' });
    }

    const nextTeamIds = req.body.teamIds.map((teamId) => String(teamId));

    if (nextTeamIds.length > 3) {
      return res.status(400).json({ message: 'A pool can include at most 3 teams' });
    }

    if (new Set(nextTeamIds).size !== nextTeamIds.length) {
      return res.status(400).json({ message: 'Duplicate team id in pool payload' });
    }

    if (nextTeamIds.some((teamId) => !isObjectId(teamId))) {
      return res.status(400).json({ message: 'Invalid team id in teamIds payload' });
    }

    const pool = await Pool.findById(poolId).lean();

    if (!pool) {
      return res.status(404).json({ message: 'Pool not found' });
    }

    const ownedTournament = await Tournament.exists({
      _id: pool.tournamentId,
      createdByUserId: req.user.id,
    });

    if (!ownedTournament) {
      return res.status(404).json({ message: 'Pool not found or unauthorized' });
    }

    if (nextTeamIds.length > 0) {
      const teams = await TournamentTeam.find({
        _id: { $in: nextTeamIds },
        tournamentId: pool.tournamentId,
      })
        .select('_id')
        .lean();

      if (teams.length !== nextTeamIds.length) {
        return res.status(400).json({ message: 'All teams must belong to the same tournament' });
      }

      const conflictingPool = await Pool.findOne({
        _id: { $ne: pool._id },
        tournamentId: pool.tournamentId,
        phase: pool.phase,
        teamIds: { $in: nextTeamIds },
      })
        .select('_id name')
        .lean();

      if (conflictingPool) {
        return res.status(400).json({
          message: `A team cannot appear in multiple ${pool.phase} pools`,
          conflictingPoolId: conflictingPool._id.toString(),
          conflictingPoolName: conflictingPool.name,
        });
      }
    }

    const updatedPool = await Pool.findByIdAndUpdate(
      pool._id,
      { teamIds: nextTeamIds },
      {
        new: true,
        runValidators: true,
      }
    )
      .populate('teamIds', 'name shortName seed logoUrl')
      .lean();

    if (pool.phase === 'phase2') {
      await recomputePhase2RematchWarnings(pool.tournamentId);
    }

    const finalizedPool = await Pool.findById(updatedPool._id)
      .populate('teamIds', 'name shortName seed logoUrl')
      .lean();

    return res.json(serializePool(finalizedPool));
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

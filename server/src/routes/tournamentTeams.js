const express = require('express');
const mongoose = require('mongoose');

const Tournament = require('../models/Tournament');
const TournamentTeam = require('../models/TournamentTeam');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

async function findOwnedTeam(teamId, userId) {
  const team = await TournamentTeam.findById(teamId);

  if (!team) {
    return null;
  }

  const ownedTournament = await Tournament.exists({
    _id: team.tournamentId,
    createdByUserId: userId,
  });

  if (!ownedTournament) {
    return null;
  }

  return team;
}

// PATCH /api/tournament-teams/:teamId -> update editable team fields
router.patch('/:teamId', requireAuth, async (req, res, next) => {
  try {
    const { teamId } = req.params;

    if (!isObjectId(teamId)) {
      return res.status(400).json({ message: 'Invalid team id' });
    }

    const team = await findOwnedTeam(teamId, req.user.id);

    if (!team) {
      return res.status(404).json({ message: 'Tournament team not found or unauthorized' });
    }

    const updates = {};

    if (req.body?.name !== undefined) {
      if (!isNonEmptyString(req.body.name)) {
        return res.status(400).json({ message: 'Team name must be a non-empty string' });
      }

      updates.name = req.body.name.trim();
    }

    if (req.body?.shortName !== undefined) {
      if (!isNonEmptyString(req.body.shortName)) {
        return res.status(400).json({ message: 'Team shortName must be a non-empty string' });
      }

      updates.shortName = req.body.shortName.trim();
    }

    if (req.body?.logoUrl !== undefined) {
      if (req.body.logoUrl !== null && typeof req.body.logoUrl !== 'string') {
        return res.status(400).json({ message: 'logoUrl must be a string or null' });
      }

      updates.logoUrl = req.body.logoUrl === null ? null : req.body.logoUrl.trim() || null;
    }

    if (req.body?.seed !== undefined) {
      if (req.body.seed !== null) {
        const parsedSeed = Number(req.body.seed);

        if (!Number.isFinite(parsedSeed)) {
          return res.status(400).json({ message: 'seed must be a number or null' });
        }

        updates.seed = parsedSeed;
      } else {
        updates.seed = null;
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No valid fields provided for update' });
    }

    team.set(updates);
    await team.save();

    return res.json(team.toObject());
  } catch (error) {
    return next(error);
  }
});

// DELETE /api/tournament-teams/:teamId -> remove a team from an owned tournament
router.delete('/:teamId', requireAuth, async (req, res, next) => {
  try {
    const { teamId } = req.params;

    if (!isObjectId(teamId)) {
      return res.status(400).json({ message: 'Invalid team id' });
    }

    const team = await findOwnedTeam(teamId, req.user.id);

    if (!team) {
      return res.status(404).json({ message: 'Tournament team not found or unauthorized' });
    }

    await team.deleteOne();

    return res.json({ message: 'Tournament team deleted successfully', id: teamId });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

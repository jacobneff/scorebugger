const express = require('express');
const mongoose = require('mongoose');

const { requireAuth } = require('../middleware/auth');
const Match = require('../models/Match');
const TournamentTeam = require('../models/TournamentTeam');
const {
  TOURNAMENT_EVENT_TYPES,
  emitTournamentEvent,
} = require('../services/tournamentRealtime');
const {
  MATCH_STATUSES,
  finalizeMatchAndEmit,
  findOwnedTournamentContext,
  serializeMatch,
  toIdString,
  unfinalizeMatchAndEmit,
} = require('../services/matchLifecycle');

const router = express.Router();

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

// POST /api/matches/:matchId/finalize -> snapshot scoreboard result to the match doc
router.post('/:matchId/finalize', requireAuth, async (req, res, next) => {
  try {
    const { matchId } = req.params;

    if (!isObjectId(matchId)) {
      return res.status(400).json({ message: 'Invalid match id' });
    }

    const match = await Match.findById(matchId);

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    const tournamentContext = await findOwnedTournamentContext(match.tournamentId, req.user.id);

    if (!tournamentContext) {
      return res.status(404).json({ message: 'Match not found or unauthorized' });
    }

    const responseMatch = await finalizeMatchAndEmit({
      match,
      userId: req.user.id,
      io: req.app?.get('io'),
      tournamentCode: tournamentContext.publicCode,
    });

    return res.json(responseMatch);
  } catch (error) {
    return next(error);
  }
});

// POST /api/matches/:matchId/unfinalize -> clear snapshot and return to scheduled
router.post('/:matchId/unfinalize', requireAuth, async (req, res, next) => {
  try {
    const { matchId } = req.params;

    if (!isObjectId(matchId)) {
      return res.status(400).json({ message: 'Invalid match id' });
    }

    const match = await Match.findById(matchId);

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    const tournamentContext = await findOwnedTournamentContext(match.tournamentId, req.user.id);

    if (!tournamentContext) {
      return res.status(404).json({ message: 'Match not found or unauthorized' });
    }

    const responseMatch = await unfinalizeMatchAndEmit({
      match,
      io: req.app?.get('io'),
      tournamentCode: tournamentContext.publicCode,
    });

    return res.json(responseMatch);
  } catch (error) {
    return next(error);
  }
});

// PATCH /api/matches/:matchId/status -> owner-only status update
router.patch('/:matchId/status', requireAuth, async (req, res, next) => {
  try {
    const { matchId } = req.params;
    const nextStatus =
      typeof req.body?.status === 'string' ? req.body.status.trim().toLowerCase() : '';

    if (!isObjectId(matchId)) {
      return res.status(400).json({ message: 'Invalid match id' });
    }

    if (!MATCH_STATUSES.includes(nextStatus)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const match = await Match.findById(matchId);

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    const tournamentContext = await findOwnedTournamentContext(match.tournamentId, req.user.id);

    if (!tournamentContext) {
      return res.status(404).json({ message: 'Match not found or unauthorized' });
    }

    if (nextStatus === 'final' && !match.result) {
      return res.status(400).json({ message: 'Use finalize to set final status' });
    }

    if (nextStatus !== 'final' && match.result) {
      return res.status(400).json({ message: 'Use unfinalize to clear a finalized result' });
    }

    if (match.status !== nextStatus) {
      match.status = nextStatus;
      await match.save();
    }

    const serializedMatch = serializeMatch(match.toObject());
    const io = req.app?.get('io');

    emitTournamentEvent(
      io,
      tournamentContext.publicCode,
      TOURNAMENT_EVENT_TYPES.MATCH_STATUS_UPDATED,
      {
        matchId: serializedMatch._id,
        status: serializedMatch.status,
      }
    );

    return res.json(serializedMatch);
  } catch (error) {
    return next(error);
  }
});

// PATCH /api/matches/:matchId/refs -> owner-only manual ref assignment
router.patch('/:matchId/refs', requireAuth, async (req, res, next) => {
  try {
    const { matchId } = req.params;
    const rawRefTeamIds = req.body?.refTeamIds;

    if (!isObjectId(matchId)) {
      return res.status(400).json({ message: 'Invalid match id' });
    }

    if (!Array.isArray(rawRefTeamIds)) {
      return res.status(400).json({ message: 'refTeamIds must be an array of team ids' });
    }

    const normalizedRefTeamIds = [
      ...new Set(rawRefTeamIds.map((teamId) => toIdString(teamId)).filter(Boolean)),
    ];

    if (normalizedRefTeamIds.some((teamId) => !isObjectId(teamId))) {
      return res.status(400).json({ message: 'refTeamIds includes an invalid team id' });
    }

    const match = await Match.findById(matchId);

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    const hasAccess = await findOwnedTournamentContext(match.tournamentId, req.user.id);

    if (!hasAccess) {
      return res.status(404).json({ message: 'Match not found or unauthorized' });
    }

    if (normalizedRefTeamIds.length > 0) {
      const validRefTeamsCount = await TournamentTeam.countDocuments({
        _id: { $in: normalizedRefTeamIds },
        tournamentId: match.tournamentId,
      });

      if (validRefTeamsCount !== normalizedRefTeamIds.length) {
        return res.status(400).json({ message: 'refTeamIds must belong to this tournament' });
      }
    }

    match.refTeamIds = normalizedRefTeamIds;
    await match.save();

    return res.json(serializeMatch(match.toObject()));
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

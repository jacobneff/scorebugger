const express = require('express');
const mongoose = require('mongoose');

const { requireAuth } = require('../middleware/auth');
const Match = require('../models/Match');
const TournamentTeam = require('../models/TournamentTeam');
const {
  MATCH_STATUSES,
  emitMatchStatusUpdated,
  finalizeMatchAndEmit,
  findOwnedTournamentContext,
  serializeMatch,
  toIdString,
  unfinalizeMatchAndEmit,
} = require('../services/matchLifecycle');

const router = express.Router();

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(value);
const parseBooleanFlag = (value, fallback = false) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value === 1;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (['true', '1', 'yes', 'y'].includes(normalized)) {
      return true;
    }

    if (['false', '0', 'no', 'n'].includes(normalized)) {
      return false;
    }
  }

  return fallback;
};

// POST /api/matches/:matchId/start -> owner-only match start transition
router.post('/:matchId/start', requireAuth, async (req, res, next) => {
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

    if (match.status === 'final') {
      return res.status(409).json({ message: 'Cannot start a finalized match' });
    }

    match.status = 'live';
    match.startedAt = new Date();
    match.endedAt = null;
    await match.save();

    const serializedMatch = serializeMatch(match.toObject());
    emitMatchStatusUpdated(req.app?.get('io'), tournamentContext.publicCode, serializedMatch);

    return res.json(serializedMatch);
  } catch (error) {
    return next(error);
  }
});

// POST /api/matches/:matchId/end -> owner-only match end transition
router.post('/:matchId/end', requireAuth, async (req, res, next) => {
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

    if (match.status !== 'live') {
      return res.status(409).json({ message: 'Only live matches can be ended' });
    }

    const endedAt = new Date();
    match.status = 'ended';
    match.endedAt = endedAt;

    if (!match.startedAt) {
      match.startedAt = endedAt;
    }

    await match.save();

    const serializedMatch = serializeMatch(match.toObject());
    emitMatchStatusUpdated(req.app?.get('io'), tournamentContext.publicCode, serializedMatch);

    return res.json(serializedMatch);
  } catch (error) {
    return next(error);
  }
});

// POST /api/matches/:matchId/finalize -> snapshot scoreboard result to the match doc
router.post('/:matchId/finalize', requireAuth, async (req, res, next) => {
  try {
    const { matchId } = req.params;
    const override = parseBooleanFlag(
      req.body?.override,
      parseBooleanFlag(req.query?.override, false)
    );

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
      override,
    });

    return res.json(responseMatch);
  } catch (error) {
    return next(error);
  }
});

// POST /api/matches/:matchId/unfinalize -> clear snapshot and return to ended
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

    const nextTransitionTime = new Date();
    let shouldSave = false;

    if (match.status !== nextStatus) {
      match.status = nextStatus;
      shouldSave = true;
    }

    if (nextStatus === 'scheduled') {
      if (match.startedAt || match.endedAt) {
        match.startedAt = null;
        match.endedAt = null;
        shouldSave = true;
      }
    } else if (nextStatus === 'live') {
      match.startedAt = nextTransitionTime;
      match.endedAt = null;
      shouldSave = true;
    } else if (nextStatus === 'ended') {
      if (!match.startedAt) {
        match.startedAt = nextTransitionTime;
        shouldSave = true;
      }
      match.endedAt = nextTransitionTime;
      shouldSave = true;
    } else if (nextStatus === 'final' && !match.endedAt) {
      match.endedAt = nextTransitionTime;
      shouldSave = true;
    }

    if (shouldSave) {
      await match.save();
    }

    const serializedMatch = serializeMatch(match.toObject());
    emitMatchStatusUpdated(req.app?.get('io'), tournamentContext.publicCode, serializedMatch);

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

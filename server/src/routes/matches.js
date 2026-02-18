const express = require('express');
const mongoose = require('mongoose');

const { requireAuth } = require('../middleware/auth');
const Match = require('../models/Match');
const Scoreboard = require('../models/Scoreboard');
const Tournament = require('../models/Tournament');
const { computeMatchSnapshot } = require('../services/tournamentEngine/standings');

const router = express.Router();

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(value);
const toIdString = (value) => (value ? value.toString() : null);

const serializeResult = (result) => {
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
};

const serializeMatch = (match) => ({
  _id: toIdString(match?._id),
  tournamentId: toIdString(match?.tournamentId),
  phase: match?.phase ?? null,
  poolId: toIdString(match?.poolId),
  bracket: match?.bracket ?? null,
  bracketRound: match?.bracketRound ?? null,
  roundBlock: match?.roundBlock ?? null,
  facility: match?.facility ?? null,
  court: match?.court ?? null,
  teamAId: toIdString(match?.teamAId),
  teamBId: toIdString(match?.teamBId),
  refTeamIds: Array.isArray(match?.refTeamIds) ? match.refTeamIds.map(toIdString) : [],
  scoreboardId: toIdString(match?.scoreboardId),
  status: match?.status ?? null,
  result: serializeResult(match?.result),
  finalizedAt: match?.finalizedAt ?? null,
  finalizedBy: toIdString(match?.finalizedBy),
  createdAt: match?.createdAt ?? null,
  updatedAt: match?.updatedAt ?? null,
});

async function ensureOwnerAccess(tournamentId, userId) {
  return Tournament.exists({
    _id: tournamentId,
    createdByUserId: userId,
  });
}

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

    const hasAccess = await ensureOwnerAccess(match.tournamentId, req.user.id);

    if (!hasAccess) {
      return res.status(404).json({ message: 'Match not found or unauthorized' });
    }

    if (!match.scoreboardId) {
      return res.status(400).json({ message: 'Match has no linked scoreboard' });
    }

    const scoreboard = await Scoreboard.findById(match.scoreboardId).lean();

    if (!scoreboard) {
      return res.status(400).json({ message: 'Linked scoreboard not found' });
    }

    let resultSnapshot;

    try {
      resultSnapshot = computeMatchSnapshot(match.toObject(), scoreboard);
    } catch (snapshotError) {
      return res.status(400).json({
        message: snapshotError.message || 'Scoreboard does not represent a completed match',
      });
    }

    match.result = resultSnapshot;
    match.status = 'final';
    match.finalizedAt = new Date();
    match.finalizedBy = req.user.id;

    await match.save();

    return res.json(serializeMatch(match.toObject()));
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

    const hasAccess = await ensureOwnerAccess(match.tournamentId, req.user.id);

    if (!hasAccess) {
      return res.status(404).json({ message: 'Match not found or unauthorized' });
    }

    match.result = null;
    match.finalizedAt = null;
    match.finalizedBy = null;
    match.status = 'scheduled';

    await match.save();

    return res.json(serializeMatch(match.toObject()));
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

const express = require('express');
const mongoose = require('mongoose');

const { requireAuth } = require('../middleware/auth');
const Match = require('../models/Match');
const Scoreboard = require('../models/Scoreboard');
const Tournament = require('../models/Tournament');
const TournamentTeam = require('../models/TournamentTeam');
const { computeMatchSnapshot } = require('../services/tournamentEngine/standings');
const { recomputePlayoffBracketProgression } = require('../services/playoffs');
const {
  TOURNAMENT_EVENT_TYPES,
  emitTournamentEvent,
} = require('../services/tournamentRealtime');

const router = express.Router();

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(value);
const toIdString = (value) => (value ? value.toString() : null);
const MATCH_STATUSES = ['scheduled', 'live', 'final'];

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

async function findOwnedTournamentContext(tournamentId, userId) {
  return Tournament.findOne({
    _id: tournamentId,
    createdByUserId: userId,
  })
    .select('_id publicCode')
    .lean();
}

function emitTournamentEventFromRequest(req, tournamentCode, type, data) {
  const io = req.app?.get('io');
  emitTournamentEvent(io, tournamentCode, type, data);
}

function emitMatchStatusUpdated(req, tournamentCode, match) {
  const matchId = toIdString(match?._id);
  const status = match?.status;

  if (!matchId || !MATCH_STATUSES.includes(status)) {
    return;
  }

  emitTournamentEventFromRequest(
    req,
    tournamentCode,
    TOURNAMENT_EVENT_TYPES.MATCH_STATUS_UPDATED,
    {
      matchId,
      status,
    }
  );
}

async function emitAffectedMatchStatusUpdates(req, tournamentCode, matchIds) {
  const uniqueIds = [...new Set((Array.isArray(matchIds) ? matchIds : []).map(toIdString).filter(Boolean))];

  if (uniqueIds.length === 0) {
    return;
  }

  const affectedMatches = await Match.find({ _id: { $in: uniqueIds } })
    .select('_id status')
    .lean();

  affectedMatches.forEach((affectedMatch) => {
    emitMatchStatusUpdated(req, tournamentCode, affectedMatch);
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

    const tournamentContext = await findOwnedTournamentContext(match.tournamentId, req.user.id);

    if (!tournamentContext) {
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

    let playoffProgression = null;

    if (match.phase === 'playoffs' && match.bracket) {
      playoffProgression = await recomputePlayoffBracketProgression(match.tournamentId, match.bracket);
    }

    const refreshedMatch = await Match.findById(match._id).lean();
    const responseMatch = serializeMatch(refreshedMatch || match.toObject());
    emitMatchStatusUpdated(req, tournamentContext.publicCode, responseMatch);
    emitTournamentEventFromRequest(
      req,
      tournamentContext.publicCode,
      TOURNAMENT_EVENT_TYPES.MATCH_FINALIZED,
      { matchId: responseMatch._id }
    );

    if (playoffProgression && match.bracket) {
      const affectedMatchIds = [
        ...new Set(
          [...(playoffProgression.updatedMatchIds || []), ...(playoffProgression.clearedMatchIds || [])]
            .map(toIdString)
            .filter(Boolean)
        ),
      ];

      emitTournamentEventFromRequest(
        req,
        tournamentContext.publicCode,
        TOURNAMENT_EVENT_TYPES.PLAYOFFS_BRACKET_UPDATED,
        {
          bracket: match.bracket,
          affectedMatchIds,
        }
      );
      await emitAffectedMatchStatusUpdates(req, tournamentContext.publicCode, affectedMatchIds);
    }

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

    match.result = null;
    match.finalizedAt = null;
    match.finalizedBy = null;
    match.status = 'scheduled';

    await match.save();

    let playoffProgression = null;

    if (match.phase === 'playoffs' && match.bracket) {
      playoffProgression = await recomputePlayoffBracketProgression(match.tournamentId, match.bracket);
    }

    const refreshedMatch = await Match.findById(match._id).lean();
    const responseMatch = serializeMatch(refreshedMatch || match.toObject());
    emitMatchStatusUpdated(req, tournamentContext.publicCode, responseMatch);
    emitTournamentEventFromRequest(
      req,
      tournamentContext.publicCode,
      TOURNAMENT_EVENT_TYPES.MATCH_UNFINALIZED,
      { matchId: responseMatch._id }
    );

    if (playoffProgression && match.bracket) {
      const affectedMatchIds = [
        ...new Set(
          [...(playoffProgression.updatedMatchIds || []), ...(playoffProgression.clearedMatchIds || [])]
            .map(toIdString)
            .filter(Boolean)
        ),
      ];

      emitTournamentEventFromRequest(
        req,
        tournamentContext.publicCode,
        TOURNAMENT_EVENT_TYPES.PLAYOFFS_BRACKET_UPDATED,
        {
          bracket: match.bracket,
          affectedMatchIds,
        }
      );
      await emitAffectedMatchStatusUpdates(req, tournamentContext.publicCode, affectedMatchIds);
    }

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
    emitMatchStatusUpdated(req, tournamentContext.publicCode, serializedMatch);

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

    const normalizedRefTeamIds = [...new Set(rawRefTeamIds.map((teamId) => toIdString(teamId)).filter(Boolean))];

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

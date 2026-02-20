const Match = require('../models/Match');
const Scoreboard = require('../models/Scoreboard');
const { requireTournamentAdminContext } = require('./tournamentAccess');
const { PLAYOFF_BRACKETS, recomputePlayoffBracketProgression } = require('./playoffs');
const { computeMatchSnapshot } = require('./tournamentEngine/standings');
const {
  TOURNAMENT_EVENT_TYPES,
  emitTournamentEvent,
} = require('./tournamentRealtime');

const MATCH_STATUSES = ['scheduled', 'live', 'ended', 'final'];
const normalizeBracket = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

function toIdString(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && value._id) {
    return value._id.toString();
  }

  return value.toString();
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function serializeResult(result) {
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
  return {
    _id: toIdString(match?._id),
    tournamentId: toIdString(match?.tournamentId),
    phase: match?.phase ?? null,
    stageKey: match?.stageKey ?? null,
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
    facilityId: match?.facilityId ?? null,
    courtId: match?.courtId ?? null,
    teamAId: toIdString(match?.teamAId),
    teamBId: toIdString(match?.teamBId),
    refTeamIds: Array.isArray(match?.refTeamIds) ? match.refTeamIds.map(toIdString) : [],
    scoreboardId: toIdString(match?.scoreboardId),
    status: match?.status ?? null,
    startedAt: match?.startedAt ?? null,
    endedAt: match?.endedAt ?? null,
    result: serializeResult(match?.result),
    finalizedAt: match?.finalizedAt ?? null,
    finalizedBy: toIdString(match?.finalizedBy),
    createdAt: match?.createdAt ?? null,
    updatedAt: match?.updatedAt ?? null,
  };
}

async function findOwnedTournamentContext(tournamentId, userId) {
  const accessContext = await requireTournamentAdminContext(
    tournamentId,
    userId,
    '_id publicCode'
  );
  return accessContext?.tournament || null;
}

function emitMatchStatusUpdated(io, tournamentCode, match) {
  const matchId = toIdString(match?._id);
  const status = match?.status;
  const startedAt = match?.startedAt ?? null;
  const endedAt = match?.endedAt ?? null;

  if (!io || !tournamentCode || !matchId || !MATCH_STATUSES.includes(status)) {
    return;
  }

  emitTournamentEvent(
    io,
    tournamentCode,
    TOURNAMENT_EVENT_TYPES.MATCH_STATUS_UPDATED,
    {
      matchId,
      status,
      startedAt,
      endedAt,
    }
  );
}

async function emitAffectedMatchStatusUpdates(io, tournamentCode, matchIds) {
  const uniqueIds = [...new Set((Array.isArray(matchIds) ? matchIds : []).map(toIdString).filter(Boolean))];

  if (!io || !tournamentCode || uniqueIds.length === 0) {
    return;
  }

  const affectedMatches = await Match.find({ _id: { $in: uniqueIds } })
    .select('_id status startedAt endedAt')
    .lean();

  affectedMatches.forEach((affectedMatch) => {
    emitMatchStatusUpdated(io, tournamentCode, affectedMatch);
  });
}

function normalizeAffectedMatchIds(playoffProgression) {
  const progressions = Array.isArray(playoffProgression)
    ? playoffProgression
    : playoffProgression
      ? [playoffProgression]
      : [];

  return [
    ...new Set(
      progressions
        .flatMap((entry) => [...(entry?.updatedMatchIds || []), ...(entry?.clearedMatchIds || [])])
        .map(toIdString)
        .filter(Boolean)
    ),
  ];
}

async function finalizeMatchAndEmit({ match, userId, io, tournamentCode, override = false }) {
  if (!match?.scoreboardId) {
    throw createHttpError(400, 'Match has no linked scoreboard');
  }

  if (!override && match.status !== 'ended') {
    throw createHttpError(409, 'Match must be ended before finalizing');
  }

  const scoreboard = await Scoreboard.findById(match.scoreboardId).lean();

  if (!scoreboard) {
    throw createHttpError(400, 'Linked scoreboard not found');
  }

  let resultSnapshot;

  try {
    resultSnapshot = computeMatchSnapshot(match.toObject(), scoreboard);
  } catch (error) {
    throw createHttpError(
      400,
      error.message || 'Scoreboard does not represent a completed match'
    );
  }

  match.result = resultSnapshot;
  match.status = 'final';
  if (!match.endedAt) {
    match.endedAt = new Date();
  }
  match.finalizedAt = new Date();
  match.finalizedBy = userId;

  await match.save();

  let playoffProgression = null;

  if (match.phase === 'playoffs' && match.bracket) {
    const normalizedBracket = normalizeBracket(match.bracket);
    const isLegacyBracket = PLAYOFF_BRACKETS.includes(normalizedBracket);

    playoffProgression = isLegacyBracket
      ? await Promise.all(
          PLAYOFF_BRACKETS.map((bracket) =>
            recomputePlayoffBracketProgression(match.tournamentId, bracket)
          )
        )
      : [
          await recomputePlayoffBracketProgression(match.tournamentId, normalizedBracket, {
            allowUnknownBracket: true,
          }),
        ];
  }

  const refreshedMatch = await Match.findById(match._id).lean();
  const responseMatch = serializeMatch(refreshedMatch || match.toObject());

  emitMatchStatusUpdated(io, tournamentCode, responseMatch);
  emitTournamentEvent(io, tournamentCode, TOURNAMENT_EVENT_TYPES.MATCH_FINALIZED, {
    matchId: responseMatch._id,
  });

  if (playoffProgression && match.bracket) {
    const affectedMatchIds = normalizeAffectedMatchIds(playoffProgression);

    emitTournamentEvent(
      io,
      tournamentCode,
      TOURNAMENT_EVENT_TYPES.PLAYOFFS_BRACKET_UPDATED,
      {
        bracket: match.bracket,
        affectedMatchIds,
      }
    );

    await emitAffectedMatchStatusUpdates(io, tournamentCode, affectedMatchIds);
  }

  return responseMatch;
}

async function unfinalizeMatchAndEmit({ match, io, tournamentCode }) {
  match.result = null;
  match.finalizedAt = null;
  match.finalizedBy = null;
  match.status = 'ended';
  if (!match.endedAt) {
    match.endedAt = new Date();
  }

  await match.save();

  let playoffProgression = null;

  if (match.phase === 'playoffs' && match.bracket) {
    const normalizedBracket = normalizeBracket(match.bracket);
    const isLegacyBracket = PLAYOFF_BRACKETS.includes(normalizedBracket);

    playoffProgression = isLegacyBracket
      ? await Promise.all(
          PLAYOFF_BRACKETS.map((bracket) =>
            recomputePlayoffBracketProgression(match.tournamentId, bracket)
          )
        )
      : [
          await recomputePlayoffBracketProgression(match.tournamentId, normalizedBracket, {
            allowUnknownBracket: true,
          }),
        ];
  }

  const refreshedMatch = await Match.findById(match._id).lean();
  const responseMatch = serializeMatch(refreshedMatch || match.toObject());

  emitMatchStatusUpdated(io, tournamentCode, responseMatch);
  emitTournamentEvent(io, tournamentCode, TOURNAMENT_EVENT_TYPES.MATCH_UNFINALIZED, {
    matchId: responseMatch._id,
  });

  if (playoffProgression && match.bracket) {
    const affectedMatchIds = normalizeAffectedMatchIds(playoffProgression);

    emitTournamentEvent(
      io,
      tournamentCode,
      TOURNAMENT_EVENT_TYPES.PLAYOFFS_BRACKET_UPDATED,
      {
        bracket: match.bracket,
        affectedMatchIds,
      }
    );

    await emitAffectedMatchStatusUpdates(io, tournamentCode, affectedMatchIds);
  }

  return responseMatch;
}

module.exports = {
  MATCH_STATUSES,
  createHttpError,
  emitMatchStatusUpdated,
  finalizeMatchAndEmit,
  findOwnedTournamentContext,
  serializeMatch,
  toIdString,
  unfinalizeMatchAndEmit,
};

const Match = require('../models/Match');
const Tournament = require('../models/Tournament');

const TOURNAMENT_ROOM_PREFIX = 'tournament:';
const TOURNAMENT_EVENT_NAME = 'tournament:event';
const SCOREBOARD_SUMMARY_THROTTLE_MS = 250;

const TOURNAMENT_EVENT_TYPES = Object.freeze({
  POOLS_UPDATED: 'POOLS_UPDATED',
  MATCHES_GENERATED: 'MATCHES_GENERATED',
  MATCH_STATUS_UPDATED: 'MATCH_STATUS_UPDATED',
  MATCH_FINALIZED: 'MATCH_FINALIZED',
  MATCH_UNFINALIZED: 'MATCH_UNFINALIZED',
  PLAYOFFS_BRACKET_UPDATED: 'PLAYOFFS_BRACKET_UPDATED',
  DETAILS_UPDATED: 'DETAILS_UPDATED',
  SCOREBOARD_SUMMARY: 'SCOREBOARD_SUMMARY',
});

const scoreboardMatchCache = new Map();
const scoreboardSummaryThrottle = new Map();

function toIdString(value) {
  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && value._id) {
    return value._id.toString();
  }

  return value.toString();
}

function normalizeTournamentCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function getTournamentRoom(tournamentCode) {
  const normalizedCode = normalizeTournamentCode(tournamentCode);
  return normalizedCode ? `${TOURNAMENT_ROOM_PREFIX}${normalizedCode}` : '';
}

function emitTournamentEvent(io, tournamentCode, type, data = {}) {
  const normalizedCode = normalizeTournamentCode(tournamentCode);
  if (!io || !normalizedCode || typeof type !== 'string' || !type.trim()) {
    return false;
  }

  const payloadData =
    data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const room = getTournamentRoom(normalizedCode);

  if (!room) {
    return false;
  }

  io.to(room).emit(TOURNAMENT_EVENT_NAME, {
    tournamentCode: normalizedCode,
    type: type.trim(),
    data: payloadData,
    ts: Date.now(),
  });

  return true;
}

function cacheTournamentMatchEntry({ scoreboardId, matchId, tournamentCode }) {
  const scoreboardKey = toIdString(scoreboardId);
  const matchKey = toIdString(matchId);
  const normalizedCode = normalizeTournamentCode(tournamentCode);

  if (!scoreboardKey || !matchKey || !normalizedCode) {
    return;
  }

  scoreboardMatchCache.set(scoreboardKey, {
    tournamentCode: normalizedCode,
    matchId: matchKey,
  });
}

function cacheTournamentMatches(matches, tournamentCode) {
  if (!Array.isArray(matches)) {
    return;
  }

  matches.forEach((match) => {
    cacheTournamentMatchEntry({
      scoreboardId: match?.scoreboardId,
      matchId: match?._id,
      tournamentCode,
    });
  });
}

function getCachedTournamentMatchEntry(scoreboardId) {
  const scoreboardKey = toIdString(scoreboardId);
  if (!scoreboardKey || !scoreboardMatchCache.has(scoreboardKey)) {
    return undefined;
  }

  return scoreboardMatchCache.get(scoreboardKey);
}

async function resolveTournamentMatchContextByScoreboard(scoreboardId) {
  const scoreboardKey = toIdString(scoreboardId);

  if (!scoreboardKey) {
    return null;
  }

  if (scoreboardMatchCache.has(scoreboardKey)) {
    return scoreboardMatchCache.get(scoreboardKey);
  }

  const match = await Match.findOne({ scoreboardId: scoreboardKey })
    .select('_id tournamentId')
    .lean();

  if (!match) {
    scoreboardMatchCache.set(scoreboardKey, null);
    return null;
  }

  const tournament = await Tournament.findById(match.tournamentId)
    .select('publicCode')
    .lean();
  const tournamentCode = normalizeTournamentCode(tournament?.publicCode);

  if (!tournamentCode) {
    scoreboardMatchCache.set(scoreboardKey, null);
    return null;
  }

  const entry = {
    tournamentCode,
    matchId: toIdString(match._id),
  };
  scoreboardMatchCache.set(scoreboardKey, entry);
  return entry;
}

function shouldEmitScoreboardSummary(scoreboardId, throttleMs = SCOREBOARD_SUMMARY_THROTTLE_MS) {
  const scoreboardKey = toIdString(scoreboardId);
  if (!scoreboardKey) {
    return false;
  }

  const now = Date.now();
  const lastEmittedAt = scoreboardSummaryThrottle.get(scoreboardKey) || 0;

  if (now - lastEmittedAt < throttleMs) {
    return false;
  }

  scoreboardSummaryThrottle.set(scoreboardKey, now);
  return true;
}

function safeNonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function computeSetWins(sets) {
  return (Array.isArray(sets) ? sets : []).reduce(
    (accumulator, set) => {
      const scores = Array.isArray(set?.scores) ? set.scores : [];
      if (scores.length !== 2) {
        return accumulator;
      }

      const scoreA = safeNonNegativeNumber(scores[0]);
      const scoreB = safeNonNegativeNumber(scores[1]);

      if (scoreA > scoreB) {
        accumulator.a += 1;
      } else if (scoreB > scoreA) {
        accumulator.b += 1;
      }

      return accumulator;
    },
    { a: 0, b: 0 }
  );
}

function buildScoreboardSummaryPayload(matchContext, scoreboard) {
  const scoreboardId = toIdString(scoreboard?._id);
  const servingTeamIndex = scoreboard?.servingTeamIndex;
  const serving =
    servingTeamIndex === 0 ? 'A' : servingTeamIndex === 1 ? 'B' : null;
  const completedSets = Array.isArray(scoreboard?.sets) ? scoreboard.sets.length : 0;

  return {
    matchId: matchContext.matchId,
    scoreboardId,
    sets: computeSetWins(scoreboard?.sets),
    points: {
      a: safeNonNegativeNumber(scoreboard?.teams?.[0]?.score),
      b: safeNonNegativeNumber(scoreboard?.teams?.[1]?.score),
    },
    serving,
    setIndex: Math.max(completedSets + 1, 1),
  };
}

async function emitScoreboardSummaryEvent(io, scoreboard) {
  const scoreboardId = toIdString(scoreboard?._id);

  if (!io || !scoreboardId || !shouldEmitScoreboardSummary(scoreboardId)) {
    return false;
  }

  const matchContext = await resolveTournamentMatchContextByScoreboard(scoreboardId);

  if (!matchContext) {
    return false;
  }

  const payload = buildScoreboardSummaryPayload(matchContext, scoreboard);

  return emitTournamentEvent(
    io,
    matchContext.tournamentCode,
    TOURNAMENT_EVENT_TYPES.SCOREBOARD_SUMMARY,
    payload
  );
}

function resetTournamentRealtimeState() {
  scoreboardMatchCache.clear();
  scoreboardSummaryThrottle.clear();
}

function getTournamentRealtimeCacheSnapshot() {
  return Array.from(scoreboardMatchCache.entries()).reduce(
    (snapshot, [scoreboardId, value]) => {
      snapshot[scoreboardId] = value;
      return snapshot;
    },
    {}
  );
}

module.exports = {
  TOURNAMENT_EVENT_NAME,
  TOURNAMENT_EVENT_TYPES,
  TOURNAMENT_ROOM_PREFIX,
  SCOREBOARD_SUMMARY_THROTTLE_MS,
  cacheTournamentMatchEntry,
  cacheTournamentMatches,
  emitScoreboardSummaryEvent,
  emitTournamentEvent,
  getCachedTournamentMatchEntry,
  getTournamentRealtimeCacheSnapshot,
  getTournamentRoom,
  normalizeTournamentCode,
  resetTournamentRealtimeState,
  resolveTournamentMatchContextByScoreboard,
};

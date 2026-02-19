const express = require('express');
const mongoose = require('mongoose');

const { requireAuth } = require('../middleware/auth');
const Match = require('../models/Match');
const Scoreboard = require('../models/Scoreboard');
const {
  emitScoreboardSummaryEvent,
} = require('../services/tournamentRealtime');
const {
  finalizeMatchAndEmit,
  findOwnedTournamentContext,
  serializeMatch,
} = require('../services/matchLifecycle');
const { requireTournamentAdminContext } = require('../services/tournamentAccess');
const {
  getFacilityFromCourt,
  mapCourtDisplayLabel,
  normalizeCourtCode,
} = require('../services/phase1');
const {
  hasDecisiveWinner,
  normalizeSetScoresInput,
} = require('../utils/setScoreInput');

const router = express.Router();

const MATCH_PHASES = ['phase1', 'phase2', 'playoffs'];
const SCHEDULE_DEFAULTS = {
  dayStartTime: '09:00',
  matchDurationMinutes: 60,
  lunchDurationMinutes: 45,
};

function isObjectId(value) {
  return mongoose.Types.ObjectId.isValid(value);
}

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

function parseBooleanFlag(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return ['true', '1', 'yes', 'y'].includes(normalized);
  }

  if (typeof value === 'number') {
    return value === 1;
  }

  return false;
}

function normalizePhase(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return MATCH_PHASES.includes(normalized) ? normalized : null;
}

function normalizeScheduleString(value, fallback = null) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeScheduleMinutes(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed);
  }

  return fallback;
}

function normalizeTournamentSchedule(schedule) {
  return {
    dayStartTime: normalizeScheduleString(
      schedule?.dayStartTime,
      SCHEDULE_DEFAULTS.dayStartTime
    ),
    matchDurationMinutes: normalizeScheduleMinutes(
      schedule?.matchDurationMinutes,
      SCHEDULE_DEFAULTS.matchDurationMinutes
    ),
    lunchStartTime: normalizeScheduleString(schedule?.lunchStartTime, null),
    lunchDurationMinutes: normalizeScheduleMinutes(
      schedule?.lunchDurationMinutes,
      SCHEDULE_DEFAULTS.lunchDurationMinutes
    ),
  };
}

function parseClockTimeToMinutes(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return 0;
  }

  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());

  if (!match) {
    return 0;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return 0;
  }

  return hours * 60 + minutes;
}

function formatMinutesAsClockTime(minutesSinceMidnight) {
  const normalizedMinutes = ((Math.floor(minutesSinceMidnight) % 1440) + 1440) % 1440;
  const hours24 = Math.floor(normalizedMinutes / 60);
  const minutes = normalizedMinutes % 60;
  const meridiem = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${String(minutes).padStart(2, '0')} ${meridiem}`;
}

function getTimeZoneOffsetMinutes(timeZone, timestamp) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(timestamp));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour);
  const minute = Number(map.minute);
  const second = Number(map.second);

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return 0;
  }

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return Math.round((asUtc - timestamp) / 60000);
}

function formatMinutesInTimezone(minutesSinceMidnight, timezone) {
  const referenceMidnightUtc = Date.UTC(2026, 0, 1, 0, 0, 0);
  const offsetMinutes = getTimeZoneOffsetMinutes(timezone, referenceMidnightUtc);
  const timestamp = referenceMidnightUtc + (minutesSinceMidnight - offsetMinutes) * 60_000;

  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(timestamp));
}

function formatRoundBlockStartTime(roundBlock, tournament) {
  const parsedRoundBlock = Number(roundBlock);

  if (!Number.isFinite(parsedRoundBlock)) {
    return '';
  }

  const schedule = normalizeTournamentSchedule(tournament?.settings?.schedule);
  const dayStartMinutes = parseClockTimeToMinutes(schedule.dayStartTime);
  const timeIndex = Math.max(0, Math.floor(parsedRoundBlock) - 1);
  const minutesSinceMidnight = dayStartMinutes + timeIndex * schedule.matchDurationMinutes;
  const timezone =
    typeof tournament?.timezone === 'string' && tournament.timezone.trim()
      ? tournament.timezone.trim()
      : 'America/New_York';

  try {
    return formatMinutesInTimezone(minutesSinceMidnight, timezone);
  } catch {
    return formatMinutesAsClockTime(minutesSinceMidnight);
  }
}

function safeNonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function computeSetWins(sets) {
  return (Array.isArray(sets) ? sets : []).reduce(
    (accumulator, set) => {
      const scoreA = safeNonNegativeNumber(set?.a ?? set?.scores?.[0]);
      const scoreB = safeNonNegativeNumber(set?.b ?? set?.scores?.[1]);

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

function computeSetPointTotals(setScores) {
  return (Array.isArray(setScores) ? setScores : []).reduce(
    (accumulator, set) => {
      accumulator.a += safeNonNegativeNumber(set?.a);
      accumulator.b += safeNonNegativeNumber(set?.b);
      return accumulator;
    },
    { a: 0, b: 0 }
  );
}

function buildScoreSummaryFromResult(result) {
  if (!result) {
    return null;
  }

  return {
    setsA: safeNonNegativeNumber(result.setsWonA),
    setsB: safeNonNegativeNumber(result.setsWonB),
    pointsA: safeNonNegativeNumber(result.pointsForA),
    pointsB: safeNonNegativeNumber(result.pointsForB),
  };
}

function buildScoreSummaryFromScoreboard(scoreboard) {
  const sets = computeSetWins(scoreboard?.sets);

  return {
    setsA: sets.a,
    setsB: sets.b,
    pointsA: safeNonNegativeNumber(scoreboard?.teams?.[0]?.score),
    pointsB: safeNonNegativeNumber(scoreboard?.teams?.[1]?.score),
  };
}

function buildSetDocumentsForScoreboard(scoreboard, setScores) {
  const existingSets = Array.isArray(scoreboard?.sets) ? scoreboard.sets : [];

  return setScores.map((set, index) => {
    const existingSet = existingSets[index];
    const hasMatchingScores =
      Array.isArray(existingSet?.scores) &&
      existingSet.scores.length === 2 &&
      safeNonNegativeNumber(existingSet.scores[0]) === set.a &&
      safeNonNegativeNumber(existingSet.scores[1]) === set.b;

    const preservedCreatedAt = hasMatchingScores
      ? new Date(existingSet.createdAt)
      : null;

    return {
      scores: [set.a, set.b],
      createdAt:
        preservedCreatedAt && !Number.isNaN(preservedCreatedAt.getTime())
          ? preservedCreatedAt
          : new Date(),
    };
  });
}

function normalizeRoundBlockFilter(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return NaN;
  }

  return Math.floor(parsed);
}

function formatTeamSnippet(team) {
  return {
    teamId: toIdString(team?._id || team),
    shortName: team?.shortName || team?.name || 'TBD',
  };
}

function buildSetScoresForQuickMatch(match, scoreboard) {
  const resultSetScores = Array.isArray(match?.result?.setScores)
    ? match.result.setScores
        .slice()
        .sort((left, right) => (left?.setNo ?? 0) - (right?.setNo ?? 0))
        .map((set) => ({
          a: safeNonNegativeNumber(set?.a),
          b: safeNonNegativeNumber(set?.b),
        }))
    : [];

  if (resultSetScores.length > 0) {
    return resultSetScores;
  }

  const scoreboardSetScores = Array.isArray(scoreboard?.sets)
    ? scoreboard.sets
        .filter((set) => Array.isArray(set?.scores) && set.scores.length === 2)
        .map((set) => ({
          a: safeNonNegativeNumber(set.scores[0]),
          b: safeNonNegativeNumber(set.scores[1]),
        }))
    : [];

  return scoreboardSetScores;
}

router.post('/matches/:matchId/score', requireAuth, async (req, res, next) => {
  try {
    const { matchId } = req.params;

    if (!isObjectId(matchId)) {
      return res.status(400).json({ message: 'Invalid match id' });
    }

    if (req.body?.applyToScoreboard !== true) {
      return res.status(400).json({ message: 'applyToScoreboard must be true' });
    }

    const setScores = normalizeSetScoresInput(req.body?.setScores);
    const shouldFinalize = parseBooleanFlag(req.body?.finalize);

    if (shouldFinalize && !hasDecisiveWinner(setScores)) {
      return res.status(400).json({ message: 'setScores must imply a winner when finalize is true' });
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
      return res.status(409).json({ message: 'Match is finalized; unfinalize first.' });
    }

    if (!match.scoreboardId) {
      return res.status(400).json({ message: 'Match has no linked scoreboard' });
    }

    const scoreboard = await Scoreboard.findById(match.scoreboardId);

    if (!scoreboard) {
      return res.status(400).json({ message: 'Linked scoreboard not found' });
    }

    scoreboard.sets = buildSetDocumentsForScoreboard(scoreboard, setScores);

    if (Array.isArray(scoreboard.teams)) {
      scoreboard.teams.forEach((team) => {
        team.score = 0;
      });
    }

    scoreboard.servingTeamIndex = null;

    await scoreboard.save();

    const io = req.app?.get('io');
    const scoreboardPayload = scoreboard.toObject();

    if (io && scoreboard?._id) {
      io.to(scoreboard._id.toString()).emit('scoreboard:state', scoreboardPayload);
      await emitScoreboardSummaryEvent(io, scoreboardPayload);
    }

    const responseMatch = shouldFinalize
      ? await finalizeMatchAndEmit({
          match,
          userId: req.user.id,
          io,
          tournamentCode: tournamentContext.publicCode,
          override: true,
        })
      : serializeMatch(match.toObject());

    const setWins = computeSetWins(setScores);
    const totalPoints = computeSetPointTotals(setScores);

    return res.json({
      match: responseMatch,
      scoreboard: {
        scoreboardId: toIdString(scoreboard._id),
        code: scoreboard.code,
        setScores: setScores.map((set, index) => ({
          setNo: index + 1,
          a: set.a,
          b: set.b,
        })),
        summary: {
          setsA: setWins.a,
          setsB: setWins.b,
          pointsA: totalPoints.a,
          pointsB: totalPoints.b,
        },
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/tournaments/:id/matches/quick', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const hasPhaseFilter = Object.prototype.hasOwnProperty.call(req.query || {}, 'phase');
    const normalizedPhase = normalizePhase(req.query?.phase);

    if (hasPhaseFilter && !normalizedPhase) {
      return res.status(400).json({ message: 'Invalid phase filter' });
    }

    const phase = normalizedPhase || 'phase1';

    const roundBlockFilter = normalizeRoundBlockFilter(req.query?.roundBlock);

    if (Number.isNaN(roundBlockFilter)) {
      return res.status(400).json({ message: 'Invalid roundBlock filter' });
    }

    const normalizedCourtFilter = req.query?.court
      ? normalizeCourtCode(req.query.court)
      : null;

    const accessContext = await requireTournamentAdminContext(
      id,
      req.user.id,
      '_id timezone settings.schedule'
    );
    const tournament = accessContext?.tournament || null;
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const phaseMatches = await Match.find({ tournamentId: id, phase })
      .populate('teamAId', 'name shortName')
      .populate('teamBId', 'name shortName')
      .populate('scoreboardId', 'code sets teams')
      .sort({ roundBlock: 1, court: 1, createdAt: 1 })
      .lean();

    const roundBlockValues = [...new Set(
      phaseMatches
        .map((match) => Number(match?.roundBlock))
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.floor(value))
    )].sort((left, right) => left - right);

    const courtValues = [...new Set(
      phaseMatches
        .map((match) => normalizeCourtCode(match?.court))
        .filter(Boolean)
    )].sort((left, right) => left.localeCompare(right));

    const filteredMatches = phaseMatches.filter((match) => {
      const normalizedRoundBlock = Number.isFinite(Number(match?.roundBlock))
        ? Math.floor(Number(match.roundBlock))
        : null;
      const normalizedCourt = normalizeCourtCode(match?.court);

      if (roundBlockFilter !== null && normalizedRoundBlock !== roundBlockFilter) {
        return false;
      }

      if (normalizedCourtFilter && normalizedCourt !== normalizedCourtFilter) {
        return false;
      }

      return true;
    });

    return res.json({
      phase,
      filters: {
        roundBlocks: roundBlockValues.map((value) => ({
          value,
          timeLabel: formatRoundBlockStartTime(value, tournament),
        })),
        courts: courtValues.map((courtCode) => ({
          code: courtCode,
          label: mapCourtDisplayLabel(courtCode),
          facility: getFacilityFromCourt(courtCode),
        })),
      },
      matches: filteredMatches.map((match) => {
        const scoreboard =
          match?.scoreboardId && typeof match.scoreboardId === 'object'
            ? match.scoreboardId
            : null;
        const resultSummary = buildScoreSummaryFromResult(match?.result);
        const completedSetScores = buildSetScoresForQuickMatch(match, scoreboard).map((set, index) => ({
          setNo: index + 1,
          a: safeNonNegativeNumber(set?.a),
          b: safeNonNegativeNumber(set?.b),
        }));

        return {
          matchId: toIdString(match?._id),
          phase: match?.phase || phase,
          roundBlock: match?.roundBlock ?? null,
          timeLabel: formatRoundBlockStartTime(match?.roundBlock, tournament),
          facility: match?.facility || getFacilityFromCourt(match?.court),
          court: match?.court || null,
          courtLabel: mapCourtDisplayLabel(match?.court),
          teamA: formatTeamSnippet(match?.teamAId),
          teamB: formatTeamSnippet(match?.teamBId),
          status: match?.status || 'scheduled',
          startedAt: match?.startedAt || null,
          endedAt: match?.endedAt || null,
          finalizedAt: match?.finalizedAt || null,
          scoreSummary: resultSummary || buildScoreSummaryFromScoreboard(scoreboard),
          completedSetScores,
          setScores: completedSetScores.map((set) => ({
            a: set.a,
            b: set.b,
          })),
          scoreboardId: toIdString(scoreboard?._id || match?.scoreboardId),
          scoreboardCode: scoreboard?.code || null,
        };
      }),
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

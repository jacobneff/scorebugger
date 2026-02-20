export const PHASE1_POOL_ORDER = ['A', 'B', 'C', 'D', 'E'];
export const PHASE2_POOL_ORDER = ['F', 'G', 'H', 'I', 'J'];

export const PHASE1_COURT_ORDER = ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1', 'VC-2'];
export const PHASE2_COURT_ORDER = ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1', 'VC-2'];

export const PHASE1_ROUND_BLOCKS = [1, 2, 3];
export const PHASE2_ROUND_BLOCKS = [4, 5, 6];
export const DEFAULT_TOURNAMENT_TIMEZONE = 'America/New_York';
export const DEFAULT_TOURNAMENT_SCHEDULE = Object.freeze({
  dayStartTime: '09:00',
  matchDurationMinutes: 60,
  lunchStartTime: null,
  lunchDurationMinutes: 45,
});

const COURT_DISPLAY_LABELS = Object.freeze({
  'VC-1': 'Volleyball Center 1',
  'VC-2': 'Volleyball Center 2',
  'SRC-1': 'SRC Court 1',
  'SRC-2': 'SRC Court 2',
  'SRC-3': 'SRC Court 3',
});

const poolOrderLookup = PHASE1_POOL_ORDER.reduce((lookup, poolName, index) => {
  lookup[poolName] = index;
  return lookup;
}, {});

const phase2PoolOrderLookup = PHASE2_POOL_ORDER.reduce((lookup, poolName, index) => {
  lookup[poolName] = index;
  return lookup;
}, {});

export const sortPhase1Pools = (pools) =>
  [...(Array.isArray(pools) ? pools : [])].sort((poolA, poolB) => {
    const orderA = poolOrderLookup[poolA?.name] ?? Number.MAX_SAFE_INTEGER;
    const orderB = poolOrderLookup[poolB?.name] ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return String(poolA?.name || '').localeCompare(String(poolB?.name || ''));
  });

export const sortPhase2Pools = (pools) =>
  [...(Array.isArray(pools) ? pools : [])].sort((poolA, poolB) => {
    const orderA = phase2PoolOrderLookup[poolA?.name] ?? Number.MAX_SAFE_INTEGER;
    const orderB = phase2PoolOrderLookup[poolB?.name] ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return String(poolA?.name || '').localeCompare(String(poolB?.name || ''));
  });

export const formatTeamLabel = (team) => {
  if (!team) {
    return 'TBD';
  }

  const baseName = team.shortName || team.name || 'TBD';
  const seedSuffix =
    Number.isFinite(Number(team.seed)) && team.seed !== null ? ` (#${Number(team.seed)})` : '';
  return `${baseName}${seedSuffix}`;
};

export const mapCourtLabel = (courtCode) => {
  if (typeof courtCode !== 'string') {
    return '';
  }

  const normalized = courtCode.trim().toUpperCase();
  return COURT_DISPLAY_LABELS[normalized] || courtCode;
};

const normalizeScheduleTime = (value, fallback) => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) {
    return fallback;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return fallback;
  }

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

const normalizeScheduleMinutes = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.round(parsed);
};

const parseClockTimeToMinutes = (timeString) => {
  const match = /^(\d{2}):(\d{2})$/.exec(timeString);
  if (!match) {
    return 0;
  }

  return Number(match[1]) * 60 + Number(match[2]);
};

const resolveLunchWindow = (schedule) => {
  const hasLunchStart =
    typeof schedule?.lunchStartTime === 'string' && schedule.lunchStartTime.trim().length > 0;
  const lunchDuration = Number(schedule?.lunchDurationMinutes);

  if (!hasLunchStart || !Number.isFinite(lunchDuration) || lunchDuration <= 0) {
    return null;
  }

  return {
    startMinutes: parseClockTimeToMinutes(schedule.lunchStartTime),
    durationMinutes: Math.floor(lunchDuration),
  };
};

const applyLunchDelayToBlockStart = ({ startMinutes, durationMinutes, lunchWindow }) => {
  if (!lunchWindow) {
    return { nextStartMinutes: startMinutes + durationMinutes, lunchApplied: false };
  }

  const lunchStart = lunchWindow.startMinutes;
  const lunchEnd = lunchStart + lunchWindow.durationMinutes;
  const scheduledEnd = startMinutes + durationMinutes;

  if (startMinutes >= lunchStart) {
    const delayedStart = lunchEnd;
    return {
      nextStartMinutes: delayedStart + durationMinutes,
      lunchApplied: true,
    };
  }

  if (scheduledEnd > lunchStart) {
    const delayedStart = lunchEnd;
    return {
      nextStartMinutes: delayedStart + durationMinutes,
      lunchApplied: true,
    };
  }

  return { nextStartMinutes: scheduledEnd, lunchApplied: false };
};

const resolveTournamentTimezone = (tournament) => {
  if (typeof tournament?.timezone === 'string' && tournament.timezone.trim()) {
    return tournament.timezone.trim();
  }

  return DEFAULT_TOURNAMENT_TIMEZONE;
};

export const normalizeTournamentSchedule = (tournament) => {
  const schedule = tournament?.settings?.schedule;
  return {
    dayStartTime: normalizeScheduleTime(
      schedule?.dayStartTime,
      DEFAULT_TOURNAMENT_SCHEDULE.dayStartTime
    ),
    matchDurationMinutes: normalizeScheduleMinutes(
      schedule?.matchDurationMinutes,
      DEFAULT_TOURNAMENT_SCHEDULE.matchDurationMinutes
    ),
    lunchStartTime:
      typeof schedule?.lunchStartTime === 'string' && schedule.lunchStartTime.trim()
        ? schedule.lunchStartTime.trim()
        : DEFAULT_TOURNAMENT_SCHEDULE.lunchStartTime,
    lunchDurationMinutes: normalizeScheduleMinutes(
      schedule?.lunchDurationMinutes,
      DEFAULT_TOURNAMENT_SCHEDULE.lunchDurationMinutes
    ),
  };
};

const formatMinutesAsClockTime = (minutesSinceStart) => {
  const normalizedMinutes = ((Math.floor(minutesSinceStart) % 1440) + 1440) % 1440;
  const hours24 = Math.floor(normalizedMinutes / 60);
  const minutes = normalizedMinutes % 60;
  const meridiem = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${String(minutes).padStart(2, '0')} ${meridiem}`;
};

const getTimeZoneOffsetMinutes = (timeZone, timestamp) => {
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
};

const formatMinutesInTimezone = (minutesSinceMidnight, timezone) => {
  const referenceMidnightUtc = Date.UTC(2026, 0, 1, 0, 0, 0);
  const offsetMinutes = getTimeZoneOffsetMinutes(timezone, referenceMidnightUtc);
  const timestamp = referenceMidnightUtc + (minutesSinceMidnight - offsetMinutes) * 60_000;

  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(timestamp));
};

export const resolveRoundBlockStartMinutes = (roundBlock, tournament) => {
  const parsedRoundBlock = Number(roundBlock);
  if (!Number.isFinite(parsedRoundBlock)) {
    return null;
  }

  const schedule = normalizeTournamentSchedule(tournament);
  const durationMinutes = Number(schedule.matchDurationMinutes) || DEFAULT_TOURNAMENT_SCHEDULE.matchDurationMinutes;
  const targetIndex = Math.max(0, Math.floor(parsedRoundBlock) - 1);
  const lunchWindow = resolveLunchWindow(schedule);

  let nextStartMinutes = parseClockTimeToMinutes(schedule.dayStartTime);
  let lunchApplied = false;

  for (let blockIndex = 0; blockIndex < targetIndex; blockIndex += 1) {
    const activeLunchWindow = lunchApplied ? null : lunchWindow;
    const resolved = applyLunchDelayToBlockStart({
      startMinutes: nextStartMinutes,
      durationMinutes,
      lunchWindow: activeLunchWindow,
    });
    nextStartMinutes = resolved.nextStartMinutes;
    if (resolved.lunchApplied) {
      lunchApplied = true;
    }
  }

  if (!lunchApplied && lunchWindow) {
    const lunchStart = lunchWindow.startMinutes;
    const lunchEnd = lunchStart + lunchWindow.durationMinutes;
    const scheduledEnd = nextStartMinutes + durationMinutes;

    if (nextStartMinutes >= lunchStart || scheduledEnd > lunchStart) {
      return lunchEnd;
    }
  }

  return nextStartMinutes;
};

export const formatRoundBlockStartTime = (roundBlock, tournament) => {
  const minutesSinceMidnight = resolveRoundBlockStartMinutes(roundBlock, tournament);
  if (!Number.isFinite(minutesSinceMidnight)) {
    return '';
  }
  const timezone = resolveTournamentTimezone(tournament);

  try {
    return formatMinutesInTimezone(minutesSinceMidnight, timezone);
  } catch {
    return formatMinutesAsClockTime(minutesSinceMidnight);
  }
};

export const formatSetRecord = (team) => {
  const setsWon = Number(team?.setsWon) || 0;
  const setsLost = Number(team?.setsLost) || 0;
  return `${setsWon}-${setsLost}`;
};

export const buildScheduleLookup = (matches) => {
  const lookup = {};

  (Array.isArray(matches) ? matches : []).forEach((match) => {
    const roundBlock = Number(match?.roundBlock);
    const court = match?.court;

    if (!Number.isFinite(roundBlock) || !court) {
      return;
    }

    lookup[`${roundBlock}-${court}`] = match;
  });

  return lookup;
};

export const buildPhase1ScheduleLookup = (matches) => buildScheduleLookup(matches);
export const buildPhase2ScheduleLookup = (matches) => buildScheduleLookup(matches);

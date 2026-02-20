const express = require('express');
const mongoose = require('mongoose');

const Tournament = require('../models/Tournament');
const TournamentTeam = require('../models/TournamentTeam');
const Pool = require('../models/Pool');
const Match = require('../models/Match');
const Scoreboard = require('../models/Scoreboard');
const TournamentAccess = require('../models/TournamentAccess');
const TournamentInvite = require('../models/TournamentInvite');
const TournamentShareLink = require('../models/TournamentShareLink');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const {
  PHASE1_COURT_ORDER,
  PHASE1_MATCH_ORDER,
  PHASE1_POOL_HOME_COURTS,
  PHASE1_POOL_NAMES,
  buildSerpentineAssignments,
  getFacilityFromCourt,
  isValidHomeCourt,
  mapCourtDisplayLabel,
  normalizeCourtCode,
  normalizeScoringConfig,
  sortPoolsByPhase1Name,
} = require('../services/phase1');
const {
  PHASE2_MATCH_ORDER,
  PHASE2_POOL_NAMES,
  buildPhase2PoolsFromPhase1Results,
} = require('../services/phase2');
const {
  DEFAULT_15_TEAM_FORMAT_ID,
  getFormat,
} = require('../tournamentFormats/formatRegistry');
const {
  generatePlayoffsFromFormat,
  generateRoundRobinMatches,
  instantiatePools,
  resolvePoolPhase,
  resolveStage,
  schedulePlayoffMatches,
} = require('../tournamentEngine/formatEngine');
const { createMatchScoreboard, createScoreboard } = require('../services/scoreboards');
const { computeStandingsBundle } = require('../services/tournamentEngine/standings');
const {
  PLAYOFF_BRACKETS,
  buildPlayoffBracketView,
  buildPlayoffOpsSchedule,
  buildPlayoffSeedAssignments,
  createPlayoffMatchPlan,
  recomputePlayoffBracketProgression,
} = require('../services/playoffs');
const {
  CODE_LENGTH,
  createUniqueTournamentPublicCode,
} = require('../utils/tournamentPublicCode');
const {
  createUniqueTeamPublicCode,
  isValidTeamPublicCode,
  normalizeTeamPublicCode,
} = require('../utils/teamPublicCode');
const {
  TOURNAMENT_EVENT_TYPES,
  cacheTournamentMatchEntry,
  emitTournamentEvent,
} = require('../services/tournamentRealtime');
const {
  formatRankRefLabel: formatScheduleRankRefLabel,
  resolveRoundBlockStartMinutes: resolveSchedulePlanRoundBlockStartMinutes,
  syncSchedulePlan,
} = require('../services/schedulePlan');
const {
  getTournamentAccessContext,
  listTournamentAdminAccessEntries,
  listUserAccessibleTournamentIds,
  normalizeEmail,
  removeTournamentAdminAccess,
  requireTournamentAdminContext,
  requireTournamentOwnerContext,
  transferTournamentOwnership,
  upsertTournamentAdminAccess,
} = require('../services/tournamentAccess');
const { createTokenPair, generateToken } = require('../utils/tokens');
const { sendMail, isEmailConfigured } = require('../config/mailer');
const { buildTournamentInviteEmail } = require('../utils/emailTemplates');
const { resolveAppBaseUrl } = require('../utils/urls');
const {
  DEFAULT_TOTAL_COURTS,
  buildDefaultVenue,
  countVenueCourts,
  findCourtInVenue,
  getEnabledCourts,
  normalizeVenueFacilities,
  venueToLegacyCourtNames,
} = require('../utils/venue');

const router = express.Router();

const TOURNAMENT_STATUSES = ['setup', 'phase1', 'phase2', 'playoffs', 'complete'];
const MATCH_PHASES = ['phase1', 'phase2', 'playoffs'];
const STANDINGS_PHASES = ['phase1', 'phase2', 'cumulative'];
const STANDINGS_OVERRIDE_PHASES = ['phase1', 'phase2'];
const DUPLICATE_KEY_ERROR_CODE = 11000;
const TOURNAMENT_STATUS_ORDER = {
  setup: 0,
  phase1: 1,
  phase2: 2,
  playoffs: 3,
  complete: 4,
};
const TOURNAMENT_SCHEDULE_DEFAULTS = Object.freeze({
  dayStartTime: '09:00',
  matchDurationMinutes: 60,
  lunchDurationMinutes: 45,
});
const POOL_PHASES = ['phase1', 'phase2'];
const PHASE_LABELS = Object.freeze({
  phase1: 'Pool Play 1',
  phase2: 'Pool Play 2',
  playoffs: 'Playoffs',
});
const BRACKET_LABELS = Object.freeze({
  gold: 'Gold',
  silver: 'Silver',
  bronze: 'Bronze',
});
const FACILITY_LABELS = Object.freeze({
  SRC: 'SRC',
  VC: 'Volleyball Center',
});
const TOURNAMENT_DETAILS_MAX_TEXT_LENGTH = 10_000;
const TOURNAMENT_DETAILS_MAX_URL_LENGTH = 2_048;
const TOURNAMENT_DETAILS_MAX_MAP_IMAGES = 3;
const TOURNAMENT_DETAILS_DEFAULTS = Object.freeze({
  specialNotes: '',
  foodInfo: {
    text: '',
    linkUrl: '',
  },
  facilitiesInfo: '',
  parkingInfo: '',
  mapImageUrls: [],
});
const TEAM_LOCATION_LABEL_MAX_LENGTH = 160;
const DEFAULT_COURT_FALLBACK = [...PHASE1_COURT_ORDER];
const DEFAULT_TOURNAMENT_INVITE_TTL_HOURS = 168;
const TOURNAMENT_ADMIN_ROLE = 'admin';
const SHARE_LINK_TOKEN_ATTEMPTS = 5;

const phase2PoolNameIndex = PHASE2_POOL_NAMES.reduce((lookup, poolName, index) => {
  lookup[poolName] = index;
  return lookup;
}, {});

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const isDuplicatePublicCodeError = (error) =>
  error?.code === DUPLICATE_KEY_ERROR_CODE &&
  (error?.keyPattern?.publicCode || error?.keyValue?.publicCode);

const isDuplicateTeamPublicCodeError = (error) =>
  error?.code === DUPLICATE_KEY_ERROR_CODE &&
  (error?.keyPattern?.publicTeamCode || error?.keyValue?.publicTeamCode);
const isDuplicateShareTokenError = (error) =>
  error?.code === DUPLICATE_KEY_ERROR_CODE &&
  (error?.keyPattern?.token || error?.keyValue?.token);

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const resolveInviteTtlHours = () => {
  const parsed = Number(process.env.TOURNAMENT_INVITE_TTL_HOURS);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }

  return DEFAULT_TOURNAMENT_INVITE_TTL_HOURS;
};
const getTournamentJoinBasePath = () => '/tournaments/join';
const buildTournamentJoinPath = (token, query = {}) => {
  const searchParams = new URLSearchParams();

  if (isNonEmptyString(token)) {
    searchParams.set('token', token.trim());
  }

  Object.entries(query || {}).forEach(([key, value]) => {
    const normalizedKey = isNonEmptyString(key) ? key.trim() : '';
    const normalizedValue =
      value === undefined || value === null ? '' : String(value).trim();

    if (!normalizedKey || !normalizedValue) {
      return;
    }

    searchParams.set(normalizedKey, normalizedValue);
  });

  const queryString = searchParams.toString();
  return queryString
    ? `${getTournamentJoinBasePath()}?${queryString}`
    : getTournamentJoinBasePath();
};
const buildTournamentJoinUrl = (token, query = {}) => {
  const baseUrl = resolveAppBaseUrl();
  const joinPath = buildTournamentJoinPath(token, query);
  const url = new URL(joinPath, baseUrl);

  return url.toString();
};

const uniqueValues = (values) => {
  const seen = new Set();
  const normalized = [];

  (Array.isArray(values) ? values : []).forEach((value) => {
    if (!value || seen.has(value)) {
      return;
    }

    seen.add(value);
    normalized.push(value);
  });

  return normalized;
};

const flattenFacilityCourts = (facilities) => {
  const source = facilities && typeof facilities === 'object' ? facilities : {};
  const srcCourts = Array.isArray(source.SRC) ? source.SRC : DEFAULT_COURT_FALLBACK.filter((court) => court.startsWith('SRC-'));
  const vcCourts = Array.isArray(source.VC) ? source.VC : DEFAULT_COURT_FALLBACK.filter((court) => court.startsWith('VC-'));

  return uniqueValues(
    [...srcCourts, ...vcCourts]
      .map((courtCode) => normalizeCourtCode(courtCode))
      .filter(Boolean)
  );
};

const resolveDefaultFormatId = ({ explicitFormatId, teamCount }) => {
  if (isNonEmptyString(explicitFormatId)) {
    return explicitFormatId.trim();
  }

  if (Number(teamCount) === 15) {
    return DEFAULT_15_TEAM_FORMAT_ID;
  }

  return null;
};

const normalizeActiveCourtsSelection = ({ requestedActiveCourts, availableCourts }) => {
  const available = uniqueValues(
    (Array.isArray(availableCourts) ? availableCourts : [])
      .map((entry) => normalizeCourtCode(entry))
      .filter(Boolean)
  );
  const requested = uniqueValues(
    (Array.isArray(requestedActiveCourts) ? requestedActiveCourts : [])
      .map((entry) => normalizeCourtCode(entry))
      .filter(Boolean)
  );

  if (requested.length === 0) {
    return {
      ok: true,
      activeCourts: available,
    };
  }

  if (requested.some((courtCode) => !available.includes(courtCode))) {
    return {
      ok: false,
      message: 'activeCourts must be a subset of tournament facilities',
    };
  }

  return {
    ok: true,
    activeCourts: requested,
  };
};

const toPositiveInteger = (value, fallback = null, { min = 1, max = 64 } = {}) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const normalized = Math.floor(parsed);
  if (normalized < min || normalized > max) {
    return fallback;
  }

  return normalized;
};

function resolveFormatTotalCourts({ formatSettings, availableCourts, venueFacilities }) {
  const fromFormat = toPositiveInteger(formatSettings?.totalCourts);
  if (fromFormat) {
    return fromFormat;
  }

  const fromVenue = countVenueCourts(venueFacilities);
  if (fromVenue > 0) {
    return fromVenue;
  }

  const normalizedActiveCourts = normalizeActiveCourtsSelection({
    requestedActiveCourts: formatSettings?.activeCourts,
    availableCourts,
  });
  if (normalizedActiveCourts.ok && normalizedActiveCourts.activeCourts.length > 0) {
    return normalizedActiveCourts.activeCourts.length;
  }

  const fromFacilities = Array.isArray(availableCourts) ? availableCourts.length : 0;
  if (fromFacilities > 0) {
    return fromFacilities;
  }

  return DEFAULT_TOTAL_COURTS;
}

function resolveTournamentVenueState(tournament, options = {}) {
  const availableCourts = flattenFacilityCourts(tournament?.facilities);
  const formatSettings =
    tournament?.settings?.format && typeof tournament.settings.format === 'object'
      ? tournament.settings.format
      : {};
  const existingVenueFacilities = normalizeVenueFacilities(
    tournament?.settings?.venue?.facilities
  );
  const totalCourts = toPositiveInteger(options.totalCourts)
    || resolveFormatTotalCourts({
      formatSettings,
      availableCourts,
      venueFacilities: existingVenueFacilities,
    });
  const existingVenueCourtCount = countVenueCourts(existingVenueFacilities);

  if (existingVenueCourtCount > 0) {
    return {
      totalCourts,
      venue: {
        facilities: existingVenueFacilities,
      },
    };
  }

  const normalizedActiveCourts = normalizeActiveCourtsSelection({
    requestedActiveCourts: formatSettings?.activeCourts,
    availableCourts,
  });
  const legacyCourtNames =
    normalizedActiveCourts.ok && normalizedActiveCourts.activeCourts.length > 0
      ? normalizedActiveCourts.activeCourts
      : availableCourts;

  return {
    totalCourts,
    venue: buildDefaultVenue(totalCourts, { legacyCourtNames }),
  };
}

const normalizeScheduleString = (value, fallback = null) =>
  isNonEmptyString(value) ? value.trim() : fallback;

const normalizeScheduleMinutes = (value, fallback) => {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed);
  }
  return fallback;
};

function normalizeTournamentSchedule(schedule) {
  return {
    dayStartTime: normalizeScheduleString(
      schedule?.dayStartTime,
      TOURNAMENT_SCHEDULE_DEFAULTS.dayStartTime
    ),
    matchDurationMinutes: normalizeScheduleMinutes(
      schedule?.matchDurationMinutes,
      TOURNAMENT_SCHEDULE_DEFAULTS.matchDurationMinutes
    ),
    lunchStartTime: normalizeScheduleString(schedule?.lunchStartTime, null),
    lunchDurationMinutes: normalizeScheduleMinutes(
      schedule?.lunchDurationMinutes,
      TOURNAMENT_SCHEDULE_DEFAULTS.lunchDurationMinutes
    ),
  };
}

function parseClockTimeToMinutes(value) {
  if (!isNonEmptyString(value)) {
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

function resolveLunchWindow(schedule) {
  const hasLunchStart = isNonEmptyString(schedule?.lunchStartTime);
  const lunchDuration = Number(schedule?.lunchDurationMinutes);

  if (!hasLunchStart || !Number.isFinite(lunchDuration) || lunchDuration <= 0) {
    return null;
  }

  return {
    startMinutes: parseClockTimeToMinutes(schedule.lunchStartTime),
    durationMinutes: Math.floor(lunchDuration),
  };
}

function applyLunchDelayToBlockStart({ startMinutes, durationMinutes, lunchWindow }) {
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
}

function resolveRoundBlockStartMinutes(roundBlock, tournament) {
  const parsedRoundBlock = Number(roundBlock);

  if (!Number.isFinite(parsedRoundBlock)) {
    return null;
  }

  const schedule = normalizeTournamentSchedule(tournament?.settings?.schedule);
  const durationMinutes =
    Number(schedule.matchDurationMinutes) || TOURNAMENT_SCHEDULE_DEFAULTS.matchDurationMinutes;
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
  const partMap = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(partMap.year);
  const month = Number(partMap.month);
  const day = Number(partMap.day);
  const hour = Number(partMap.hour);
  const minute = Number(partMap.minute);
  const second = Number(partMap.second);

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
  const minutesSinceMidnight = resolveRoundBlockStartMinutes(roundBlock, tournament);
  if (!Number.isFinite(minutesSinceMidnight)) {
    return '';
  }
  const timezone = isNonEmptyString(tournament?.timezone)
    ? tournament.timezone.trim()
    : 'America/New_York';

  try {
    return formatMinutesInTimezone(minutesSinceMidnight, timezone);
  } catch {
    return formatMinutesAsClockTime(minutesSinceMidnight);
  }
}

function attachTournamentScheduleDefaults(tournament, options = {}) {
  if (!tournament || typeof tournament !== 'object') {
    return tournament;
  }

  const teamCount = Number.isFinite(Number(options?.teamCount))
    ? Number(options.teamCount)
    : null;
  const availableCourts = flattenFacilityCourts(tournament?.facilities);
  const formatSettings =
    tournament?.settings?.format && typeof tournament.settings.format === 'object'
      ? tournament.settings.format
      : {};
  const venueState = resolveTournamentVenueState(tournament);
  const activeCourtsFromVenue = venueToLegacyCourtNames(venueState.venue, { enabledOnly: true });
  const activeCourts =
    activeCourtsFromVenue.length > 0 ? activeCourtsFromVenue : availableCourts;
  const formatId = resolveDefaultFormatId({
    explicitFormatId: formatSettings.formatId,
    teamCount,
  });

  return {
    ...tournament,
    settings: {
      ...(tournament.settings && typeof tournament.settings === 'object'
        ? tournament.settings
        : {}),
      schedule: normalizeTournamentSchedule(tournament?.settings?.schedule),
      format: {
        formatId,
        totalCourts: venueState.totalCourts,
        activeCourts,
      },
      venue: venueState.venue,
    },
  };
}

const parseTournamentDate = (value) => {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const normalizePublicCode = (value) =>
  typeof value === 'string' ? value.trim().toUpperCase() : '';

const normalizeBracket = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const toIdString = (value) => (value ? value.toString() : null);

const normalizeStandingsPhase = (value) =>
  typeof value === 'string' && value.trim() ? value.trim() : 'phase1';

const normalizeTeamIdList = (value) =>
  Array.isArray(value) ? value.map((teamId) => toIdString(teamId)).filter(Boolean) : null;

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const isPermutation = (candidate, expected) => {
  if (!Array.isArray(candidate) || !Array.isArray(expected)) {
    return false;
  }

  if (candidate.length !== expected.length) {
    return false;
  }

  if (new Set(candidate).size !== candidate.length) {
    return false;
  }

  const expectedSet = new Set(expected);
  return candidate.every((teamId) => expectedSet.has(teamId));
};

const parseBooleanFlag = (value, fallback = false) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (['true', '1', 'yes', 'y'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'n'].includes(normalized)) {
    return false;
  }

  return fallback;
};

const normalizeTeamOrderIndex = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const rounded = Math.round(parsed);
  return rounded > 0 ? rounded : null;
};

const normalizeCreatedAtMs = (value) => {
  if (!value) {
    return Number.MAX_SAFE_INTEGER;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
};

function compareTeamsByTournamentOrder(teamA, teamB) {
  const orderA = normalizeTeamOrderIndex(teamA?.orderIndex) ?? Number.MAX_SAFE_INTEGER;
  const orderB = normalizeTeamOrderIndex(teamB?.orderIndex) ?? Number.MAX_SAFE_INTEGER;

  if (orderA !== orderB) {
    return orderA - orderB;
  }

  const createdAtA = normalizeCreatedAtMs(teamA?.createdAt);
  const createdAtB = normalizeCreatedAtMs(teamB?.createdAt);

  if (createdAtA !== createdAtB) {
    return createdAtA - createdAtB;
  }

  const nameA = String(teamA?.name || teamA?.shortName || '');
  const nameB = String(teamB?.name || teamB?.shortName || '');
  const byName = nameA.localeCompare(nameB);

  if (byName !== 0) {
    return byName;
  }

  return String(toIdString(teamA?._id) || '').localeCompare(String(toIdString(teamB?._id) || ''));
}

function buildSerpentinePoolAssignments(orderedTeams, orderedPools) {
  const pools = Array.isArray(orderedPools)
    ? orderedPools.map((pool) => ({
        poolId: toIdString(pool?._id),
        name: String(pool?.name || ''),
        requiredTeamCount: Number.isFinite(Number(pool?.requiredTeamCount)) && Number(pool.requiredTeamCount) > 0
          ? Math.floor(Number(pool.requiredTeamCount))
          : 3,
        teamIds: [],
      }))
    : [];
  const teams = Array.isArray(orderedTeams) ? orderedTeams : [];

  if (pools.length === 0 || teams.length === 0) {
    return pools;
  }

  const maxSlots = pools.reduce((total, pool) => total + pool.requiredTeamCount, 0);
  const teamCountToAssign = Math.min(teams.length, maxSlots);

  let poolIndex = 0;
  let direction = 1;
  let assignedCount = 0;

  while (assignedCount < teamCountToAssign) {
    const currentPool = pools[poolIndex];

    if (currentPool && currentPool.teamIds.length < currentPool.requiredTeamCount) {
      currentPool.teamIds.push(toIdString(teams[assignedCount]?._id));
      assignedCount += 1;
    }

    const hasCapacityRemaining = pools.some(
      (pool) => pool.teamIds.length < pool.requiredTeamCount
    );
    if (!hasCapacityRemaining) {
      break;
    }

    poolIndex += direction;
    if (poolIndex >= pools.length) {
      direction = -1;
      poolIndex = pools.length - 1;
    } else if (poolIndex < 0) {
      direction = 1;
      poolIndex = 0;
    }
  }

  return pools;
}

function validateStandingsPhaseFilter(phase) {
  if (!phase) {
    return null;
  }

  return STANDINGS_PHASES.includes(phase) ? null : 'Invalid standings phase';
}

function validateStandingsOverridePhaseFilter(phase) {
  if (!phase) {
    return null;
  }

  return STANDINGS_OVERRIDE_PHASES.includes(phase) ? null : 'Invalid standings override phase';
}

async function ensureTournamentAdminAccess(tournamentId, userId) {
  const adminContext = await requireTournamentAdminContext(tournamentId, userId);
  return Boolean(adminContext);
}

function serializeAccessUser(userDoc, fallbackUserId = '') {
  const userId = toIdString(userDoc?._id || fallbackUserId);
  return {
    userId,
    email: typeof userDoc?.email === 'string' ? userDoc.email : '',
    displayName: typeof userDoc?.displayName === 'string' ? userDoc.displayName : '',
  };
}

function serializeAdminAccessRecord(accessEntry) {
  const user = accessEntry?.userId;
  const userId = toIdString(user?._id || user || accessEntry?.userId);
  return {
    userId,
    role: TOURNAMENT_ADMIN_ROLE,
    email: typeof user?.email === 'string' ? user.email : '',
    displayName: typeof user?.displayName === 'string' ? user.displayName : '',
    createdAt: accessEntry?.createdAt || null,
  };
}

function serializePendingInviteRecord(inviteEntry) {
  return {
    inviteId: toIdString(inviteEntry?._id),
    email: inviteEntry?.email || '',
    role: inviteEntry?.role || TOURNAMENT_ADMIN_ROLE,
    expiresAt: inviteEntry?.expiresAt || null,
    createdAt: inviteEntry?.createdAt || null,
    usedAt: inviteEntry?.usedAt || null,
  };
}

async function persistShareLinkWithUniqueToken(shareLink) {
  for (let attempt = 0; attempt < SHARE_LINK_TOKEN_ATTEMPTS; attempt += 1) {
    shareLink.token = generateToken();
    try {
      await shareLink.save();
      return shareLink;
    } catch (error) {
      if (isDuplicateShareTokenError(error)) {
        continue;
      }

      throw error;
    }
  }

  const error = new Error('Failed to generate a unique share token');
  error.status = 500;
  throw error;
}

function getTournamentFormatContext(tournament, teamCount) {
  const availableCourts = flattenFacilityCourts(tournament?.facilities);
  const explicitFormatId = tournament?.settings?.format?.formatId;
  const formatId = resolveDefaultFormatId({
    explicitFormatId,
    teamCount,
  });
  const venueState = resolveTournamentVenueState(tournament);
  const activeCourts = venueToLegacyCourtNames(venueState.venue, { enabledOnly: true });
  const formatDef = formatId ? getFormat(formatId) : null;

  return {
    formatId,
    formatDef,
    availableCourts,
    activeCourts: activeCourts.length > 0 ? activeCourts : availableCourts,
    totalCourts: venueState.totalCourts,
    venue: venueState.venue,
  };
}

async function getOwnedTournamentAndTeamCount(tournamentId, userId, projection = '') {
  const accessContext = await requireTournamentAdminContext(
    tournamentId,
    userId,
    projection || 'settings facilities publicCode status standingsOverrides'
  );
  const tournament = accessContext?.tournament;

  if (!tournament) {
    return null;
  }

  const teamCount = await TournamentTeam.countDocuments({ tournamentId });

  return {
    tournament,
    teamCount,
  };
}

function getFirstPoolPlayStage(formatDef) {
  if (!formatDef || !Array.isArray(formatDef.stages)) {
    return null;
  }

  return formatDef.stages.find((stage) => stage?.type === 'poolPlay') || null;
}

function getPoolPlayStages(formatDef) {
  return Array.isArray(formatDef?.stages)
    ? formatDef.stages.filter((stage) => stage?.type === 'poolPlay')
    : [];
}

function getPlayoffStage(formatDef) {
  if (!formatDef || !Array.isArray(formatDef.stages)) {
    return null;
  }

  return formatDef.stages.find((stage) => stage?.type === 'playoffs') || null;
}

function toTitleCase(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    return '';
  }

  return normalized
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(' ');
}

function resolveBracketLabelFromKey(bracketKey) {
  const normalized = normalizeBracket(bracketKey);
  return BRACKET_LABELS[normalized] || toTitleCase(normalized) || 'Bracket';
}

function buildPhaseLabelLookup(formatDef) {
  const labels = { ...PHASE_LABELS };
  const poolStages = getPoolPlayStages(formatDef);

  if (isNonEmptyString(poolStages?.[0]?.displayName)) {
    labels.phase1 = poolStages[0].displayName.trim();
  }

  if (isNonEmptyString(poolStages?.[1]?.displayName)) {
    labels.phase2 = poolStages[1].displayName.trim();
  }

  return labels;
}

function resolvePhaseLabel(phase, phaseLabels) {
  const normalizedPhase = typeof phase === 'string' ? phase.trim() : '';
  if (!normalizedPhase) {
    return '';
  }

  return phaseLabels?.[normalizedPhase] || PHASE_LABELS[normalizedPhase] || normalizedPhase;
}

function buildStageDefinitionLookup(formatDef) {
  return new Map(
    (Array.isArray(formatDef?.stages) ? formatDef.stages : [])
      .filter((stage) => isNonEmptyString(stage?.key))
      .map((stage) => [stage.key.trim(), stage])
  );
}

function buildStageLabelLookup(formatDef) {
  return new Map(
    (Array.isArray(formatDef?.stages) ? formatDef.stages : [])
      .filter((stage) => isNonEmptyString(stage?.key))
      .map((stage) => [
        stage.key.trim(),
        isNonEmptyString(stage?.displayName) ? stage.displayName.trim() : toTitleCase(stage.key),
      ])
  );
}

function buildStageOrderLookup(formatDef) {
  return new Map(
    (Array.isArray(formatDef?.stages) ? formatDef.stages : []).map((stage, index) => [
      stage.key,
      index,
    ])
  );
}

async function resolveStageStartRoundBlock(tournamentId, formatDef, stageKey) {
  const stageOrderLookup = buildStageOrderLookup(formatDef);
  const targetIndex = stageOrderLookup.get(stageKey);

  if (!Number.isInteger(targetIndex)) {
    return 1;
  }

  const previousStageKeys = (formatDef.stages || [])
    .filter((stage, index) => index < targetIndex)
    .map((stage) => stage.key);

  if (previousStageKeys.length === 0) {
    return 1;
  }

  const previousStageMatches = await Match.find({
    tournamentId,
    stageKey: { $in: previousStageKeys },
  })
    .select('roundBlock')
    .lean();
  const maxRoundBlock = previousStageMatches.reduce((maxValue, match) => {
    const roundBlock = Number(match?.roundBlock);
    if (!Number.isFinite(roundBlock)) {
      return maxValue;
    }

    return Math.max(maxValue, Math.floor(roundBlock));
  }, 0);

  return maxRoundBlock + 1;
}

function getRoundRobinMatchCount(teamCount) {
  const parsed = Number(teamCount);
  if (!Number.isFinite(parsed) || parsed <= 1) {
    return 0;
  }

  const normalized = Math.floor(parsed);
  return Math.floor((normalized * (normalized - 1)) / 2);
}

async function resolveCrossoverStartRoundBlock({
  tournamentId,
  formatDef,
  stageDef,
  previousStage,
  previousPhase,
  sourcePools,
}) {
  const sourcePoolIds = (Array.isArray(sourcePools) ? sourcePools : [])
    .map((pool) => pool?._id)
    .filter(Boolean);

  if (sourcePoolIds.length > 0) {
    const sourcePoolMatches = await Match.find({
      tournamentId,
      poolId: { $in: sourcePoolIds },
      ...(previousStage?.key
        ? { $or: [{ stageKey: previousStage.key }, { stageKey: null }, { stageKey: { $exists: false } }] }
        : previousPhase
          ? { phase: previousPhase }
          : {}),
    })
      .select('roundBlock')
      .lean();
    const maxRoundBlock = sourcePoolMatches.reduce((maxValue, match) => {
      const roundBlock = Number(match?.roundBlock);
      if (!Number.isFinite(roundBlock)) {
        return maxValue;
      }

      return Math.max(maxValue, Math.floor(roundBlock));
    }, 0);

    if (maxRoundBlock > 0) {
      return maxRoundBlock + 1;
    }
  }

  const sourcePoolRoundCounts = (Array.isArray(sourcePools) ? sourcePools : []).map((pool) => {
    const poolName = String(pool?.name || '').trim();
    const stagePoolDef = Array.isArray(previousStage?.pools)
      ? previousStage.pools.find((entry) => String(entry?.name || '').trim() === poolName)
      : null;
    const poolSize =
      toPositiveInteger(stagePoolDef?.size)
      || toPositiveInteger(pool?.requiredTeamCount)
      || 0;
    return getRoundRobinMatchCount(poolSize);
  });
  const sourceRoundCount = sourcePoolRoundCounts.reduce(
    (maxValue, roundCount) => Math.max(maxValue, Number(roundCount) || 0),
    0
  );

  if (sourceRoundCount > 0) {
    return sourceRoundCount + 1;
  }

  return resolveStageStartRoundBlock(tournamentId, formatDef, stageDef.key);
}

function serializeTournamentDetails(details) {
  const source = details && typeof details === 'object' ? details : {};
  const rawFoodInfo = source.foodInfo && typeof source.foodInfo === 'object' ? source.foodInfo : {};
  const rawMapImageUrls = Array.isArray(source.mapImageUrls) ? source.mapImageUrls : [];

  return {
    specialNotes:
      typeof source.specialNotes === 'string'
        ? source.specialNotes
        : TOURNAMENT_DETAILS_DEFAULTS.specialNotes,
    foodInfo: {
      text:
        typeof rawFoodInfo.text === 'string'
          ? rawFoodInfo.text
          : TOURNAMENT_DETAILS_DEFAULTS.foodInfo.text,
      linkUrl:
        typeof rawFoodInfo.linkUrl === 'string'
          ? rawFoodInfo.linkUrl
          : TOURNAMENT_DETAILS_DEFAULTS.foodInfo.linkUrl,
    },
    facilitiesInfo:
      typeof source.facilitiesInfo === 'string'
        ? source.facilitiesInfo
        : TOURNAMENT_DETAILS_DEFAULTS.facilitiesInfo,
    parkingInfo:
      typeof source.parkingInfo === 'string'
        ? source.parkingInfo
        : TOURNAMENT_DETAILS_DEFAULTS.parkingInfo,
    mapImageUrls: rawMapImageUrls
      .filter((url) => typeof url === 'string' && url.trim())
      .map((url) => url.trim())
      .slice(0, TOURNAMENT_DETAILS_MAX_MAP_IMAGES),
  };
}

function normalizeTournamentDetailsPatch(rawBody) {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return {
      updates: {},
      error: 'Request body must be an object',
    };
  }

  const updates = {};
  const addTextUpdate = (path, value, fieldLabel) => {
    if (value === null) {
      updates[path] = '';
      return;
    }

    if (typeof value !== 'string') {
      throw new Error(`${fieldLabel} must be a string`);
    }

    if (value.length > TOURNAMENT_DETAILS_MAX_TEXT_LENGTH) {
      throw new Error(`${fieldLabel} must be ${TOURNAMENT_DETAILS_MAX_TEXT_LENGTH} characters or fewer`);
    }

    updates[path] = value;
  };
  const addUrlUpdate = (path, value, fieldLabel) => {
    if (value === null) {
      updates[path] = '';
      return;
    }

    if (typeof value !== 'string') {
      throw new Error(`${fieldLabel} must be a string`);
    }

    const trimmed = value.trim();

    if (trimmed.length > TOURNAMENT_DETAILS_MAX_URL_LENGTH) {
      throw new Error(`${fieldLabel} must be ${TOURNAMENT_DETAILS_MAX_URL_LENGTH} characters or fewer`);
    }

    if (trimmed && !isValidHttpUrl(trimmed)) {
      throw new Error(`${fieldLabel} must be a valid http or https URL`);
    }

    updates[path] = trimmed;
  };

  try {
    if (rawBody.specialNotes !== undefined) {
      addTextUpdate('details.specialNotes', rawBody.specialNotes, 'specialNotes');
    }

    if (rawBody.facilitiesInfo !== undefined) {
      addTextUpdate('details.facilitiesInfo', rawBody.facilitiesInfo, 'facilitiesInfo');
    }

    if (rawBody.parkingInfo !== undefined) {
      addTextUpdate('details.parkingInfo', rawBody.parkingInfo, 'parkingInfo');
    }

    if (rawBody.foodInfo !== undefined) {
      if (!rawBody.foodInfo || typeof rawBody.foodInfo !== 'object' || Array.isArray(rawBody.foodInfo)) {
        return {
          updates: {},
          error: 'foodInfo must be an object',
        };
      }

      if (rawBody.foodInfo.text !== undefined) {
        addTextUpdate('details.foodInfo.text', rawBody.foodInfo.text, 'foodInfo.text');
      }

      if (rawBody.foodInfo.linkUrl !== undefined) {
        addUrlUpdate('details.foodInfo.linkUrl', rawBody.foodInfo.linkUrl, 'foodInfo.linkUrl');
      }
    }

    if (rawBody.mapImageUrls !== undefined) {
      const value = rawBody.mapImageUrls;
      if (value === null) {
        updates['details.mapImageUrls'] = [];
      } else if (!Array.isArray(value)) {
        return {
          updates: {},
          error: 'mapImageUrls must be an array',
        };
      } else {
        if (value.length > TOURNAMENT_DETAILS_MAX_MAP_IMAGES) {
          return {
            updates: {},
            error: `mapImageUrls cannot contain more than ${TOURNAMENT_DETAILS_MAX_MAP_IMAGES} URLs`,
          };
        }

        const normalizedUrls = [];
        for (let index = 0; index < value.length; index += 1) {
          const entry = value[index];
          if (typeof entry !== 'string') {
            return {
              updates: {},
              error: `mapImageUrls[${index}] must be a string`,
            };
          }

          const trimmed = entry.trim();

          if (!trimmed) {
            continue;
          }

          if (trimmed.length > TOURNAMENT_DETAILS_MAX_URL_LENGTH) {
            return {
              updates: {},
              error: `mapImageUrls[${index}] must be ${TOURNAMENT_DETAILS_MAX_URL_LENGTH} characters or fewer`,
            };
          }

          if (!isValidHttpUrl(trimmed)) {
            return {
              updates: {},
              error: `mapImageUrls[${index}] must be a valid http or https URL`,
            };
          }

          normalizedUrls.push(trimmed);
        }

        updates['details.mapImageUrls'] = normalizedUrls;
      }
    }
  } catch (error) {
    return {
      updates: {},
      error: error.message || 'Invalid details payload',
    };
  }

  return { updates, error: null };
}

function parseTeamLocationCoordinate(value, { min, max, label }) {
  if (value === null || value === undefined || value === '') {
    return { value: null, error: null };
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return { value: null, error: `${label} must be a number` };
  }

  if (parsed < min || parsed > max) {
    return { value: null, error: `${label} must be between ${min} and ${max}` };
  }

  return { value: parsed, error: null };
}

function normalizeTeamLocationPayload(rawLocation, fieldPrefix = 'location') {
  if (rawLocation === undefined) {
    return { location: undefined, error: null };
  }

  if (rawLocation === null) {
    return {
      location: {
        label: '',
        latitude: null,
        longitude: null,
      },
      error: null,
    };
  }

  if (!rawLocation || typeof rawLocation !== 'object' || Array.isArray(rawLocation)) {
    return { location: null, error: `${fieldPrefix} must be an object or null` };
  }

  let label = '';
  if (rawLocation.label !== undefined) {
    if (rawLocation.label !== null && typeof rawLocation.label !== 'string') {
      return { location: null, error: `${fieldPrefix}.label must be a string or null` };
    }

    label = typeof rawLocation.label === 'string' ? rawLocation.label.trim() : '';
    if (label.length > TEAM_LOCATION_LABEL_MAX_LENGTH) {
      return {
        location: null,
        error: `${fieldPrefix}.label must be ${TEAM_LOCATION_LABEL_MAX_LENGTH} characters or fewer`,
      };
    }
  }

  const latitudeResult = parseTeamLocationCoordinate(rawLocation.latitude, {
    min: -90,
    max: 90,
    label: `${fieldPrefix}.latitude`,
  });
  if (latitudeResult.error) {
    return { location: null, error: latitudeResult.error };
  }

  const longitudeResult = parseTeamLocationCoordinate(rawLocation.longitude, {
    min: -180,
    max: 180,
    label: `${fieldPrefix}.longitude`,
  });
  if (longitudeResult.error) {
    return { location: null, error: longitudeResult.error };
  }

  const hasLatitude = Number.isFinite(latitudeResult.value);
  const hasLongitude = Number.isFinite(longitudeResult.value);

  if (hasLatitude !== hasLongitude) {
    return {
      location: null,
      error: `${fieldPrefix}.latitude and ${fieldPrefix}.longitude must both be provided together`,
    };
  }

  return {
    location: {
      label,
      latitude: hasLatitude ? latitudeResult.value : null,
      longitude: hasLongitude ? longitudeResult.value : null,
    },
    error: null,
  };
}

function validateTeamPayload(rawTeam, index) {
  if (!rawTeam || typeof rawTeam !== 'object') {
    return `Invalid team payload at index ${index}`;
  }

  if (!isNonEmptyString(rawTeam.shortName)) {
    return `Team shortName is required at index ${index}`;
  }

  if (rawTeam.name !== undefined && rawTeam.name !== null && !isNonEmptyString(rawTeam.name)) {
    return `Team name must be a non-empty string at index ${index}`;
  }

  if (
    rawTeam.logoUrl !== undefined &&
    rawTeam.logoUrl !== null &&
    typeof rawTeam.logoUrl !== 'string'
  ) {
    return `logoUrl must be a string at index ${index}`;
  }

  if (rawTeam.seed !== undefined && rawTeam.seed !== null) {
    const parsedSeed = Number(rawTeam.seed);

    if (!Number.isFinite(parsedSeed)) {
      return `seed must be a number at index ${index}`;
    }
  }

  const normalizedLocation = normalizeTeamLocationPayload(rawTeam.location, `location at index ${index}`);
  if (normalizedLocation.error) {
    return normalizedLocation.error;
  }

  return null;
}

function buildTeamInsertPayload(rawTeam, tournamentId, orderIndex = null, publicTeamCode = null) {
  const shortName = rawTeam.shortName.trim();
  const normalizedName = isNonEmptyString(rawTeam.name) ? rawTeam.name.trim() : shortName;
  const team = {
    tournamentId,
    name: normalizedName,
    shortName,
  };

  if (orderIndex !== null) {
    team.orderIndex = orderIndex;
  }

  if (rawTeam.logoUrl !== undefined) {
    team.logoUrl = rawTeam.logoUrl === null ? null : rawTeam.logoUrl.trim() || null;
  }

  if (rawTeam.seed !== undefined) {
    team.seed = rawTeam.seed === null ? null : Number(rawTeam.seed);
  }

  if (rawTeam.location !== undefined) {
    const normalizedLocation = normalizeTeamLocationPayload(rawTeam.location);
    if (normalizedLocation.location !== undefined) {
      team.location = normalizedLocation.location;
    }
  }

  if (isValidTeamPublicCode(publicTeamCode)) {
    team.publicTeamCode = normalizeTeamPublicCode(publicTeamCode);
  }

  return team;
}

function hasValidPublicTeamCode(team) {
  return isValidTeamPublicCode(team?.publicTeamCode);
}

async function ensureTournamentTeamPublicCodes(tournamentId, { maxAttempts = 4 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const teams = await TournamentTeam.find({ tournamentId }).lean();
    teams.sort(compareTeamsByTournamentOrder);

    const teamsMissingCodes = teams.filter((team) => !hasValidPublicTeamCode(team));

    if (teamsMissingCodes.length === 0) {
      return teams.map((team) => ({
        ...team,
        publicTeamCode: normalizeTeamPublicCode(team.publicTeamCode),
      }));
    }

    const reservedCodes = new Set(
      teams
        .map((team) => normalizeTeamPublicCode(team.publicTeamCode))
        .filter((code) => isValidTeamPublicCode(code))
    );

    const writeOperations = [];

    for (const team of teamsMissingCodes) {
      const nextCode = await createUniqueTeamPublicCode(TournamentTeam, tournamentId, {
        excludeTeamId: team._id,
        reservedCodes,
      });
      reservedCodes.add(nextCode);
      writeOperations.push({
        updateOne: {
          filter: {
            _id: team._id,
            tournamentId,
          },
          update: {
            $set: {
              publicTeamCode: nextCode,
            },
          },
        },
      });
    }

    try {
      await TournamentTeam.bulkWrite(writeOperations, { ordered: true });
    } catch (error) {
      if (isDuplicateTeamPublicCodeError(error)) {
        continue;
      }

      throw error;
    }
  }

  throw new Error('Failed to backfill team public codes');
}

function serializeTeam(team) {
  if (!team) {
    return null;
  }

  const location = normalizeTeamLocationPayload(team.location).location;

  return {
    id: toIdString(team._id),
    name: team.name ?? '',
    shortName: team.shortName ?? '',
    logoUrl: team.logoUrl ?? null,
    location: location || {
      label: '',
      latitude: null,
      longitude: null,
    },
    orderIndex: normalizeTeamOrderIndex(team.orderIndex),
    seed: team.seed ?? null,
  };
}

function serializePool(pool) {
  const teamIds = Array.isArray(pool?.teamIds)
    ? pool.teamIds.map((team) =>
        team && typeof team === 'object' && team._id
          ? {
              _id: toIdString(team._id),
              name: team.name ?? '',
              shortName: team.shortName ?? '',
              logoUrl: team.logoUrl ?? null,
              location:
                normalizeTeamLocationPayload(team.location).location || {
                  label: '',
                  latitude: null,
                  longitude: null,
                },
              orderIndex: normalizeTeamOrderIndex(team.orderIndex),
              seed: team.seed ?? null,
            }
          : { _id: toIdString(team) }
      )
    : [];
  const rematchWarnings = Array.isArray(pool?.rematchWarnings)
    ? pool.rematchWarnings
        .map((warning) => ({
          teamIdA: toIdString(warning?.teamIdA),
          teamIdB: toIdString(warning?.teamIdB),
        }))
        .filter((warning) => warning.teamIdA && warning.teamIdB)
    : [];

  return {
    _id: toIdString(pool?._id),
    tournamentId: toIdString(pool?.tournamentId),
    phase: pool?.phase ?? null,
    stageKey: pool?.stageKey ?? null,
    name: pool?.name ?? '',
    homeCourt: pool?.homeCourt ?? null,
    assignedCourtId: pool?.assignedCourtId ?? null,
    assignedFacilityId: pool?.assignedFacilityId ?? null,
    requiredTeamCount:
      Number.isFinite(Number(pool?.requiredTeamCount)) && Number(pool.requiredTeamCount) > 0
        ? Math.floor(Number(pool.requiredTeamCount))
        : null,
    teamIds,
    rematchWarnings,
    createdAt: pool?.createdAt ?? null,
    updatedAt: pool?.updatedAt ?? null,
  };
}

function serializeMatchResult(result) {
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
  const teamA = match?.teamAId && typeof match.teamAId === 'object' ? match.teamAId : null;
  const teamB = match?.teamBId && typeof match.teamBId === 'object' ? match.teamBId : null;
  const byeTeam = match?.byeTeamId && typeof match.byeTeamId === 'object' ? match.byeTeamId : null;
  const pool = match?.poolId && typeof match.poolId === 'object' ? match.poolId : null;
  const scoreboard =
    match?.scoreboardId && typeof match.scoreboardId === 'object' ? match.scoreboardId : null;
  const resultScoreSummary = serializeCourtScheduleScore(match?.result);
  const scoreboardScoreSummary = serializeScoreSummaryFromScoreboard(scoreboard);
  const completedSetScores = resolveCompletedSetScores(match?.result, scoreboard);

  const refTeams = Array.isArray(match?.refTeamIds)
    ? match.refTeamIds.map((team) =>
        team && typeof team === 'object' && team._id ? serializeTeam(team) : { id: toIdString(team) }
      )
    : [];

  return {
    _id: toIdString(match?._id),
    phase: match?.phase ?? null,
    stageKey: match?.stageKey ?? null,
    plannedSlotId: isNonEmptyString(match?.plannedSlotId) ? match.plannedSlotId.trim() : null,
    poolId: pool ? toIdString(pool._id) : toIdString(match?.poolId),
    poolName: pool?.name ?? null,
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
    facilityLabel: match?.facility ?? null,
    courtLabel: match?.court ? mapCourtDisplayLabel(match.court) : null,
    teamAId: teamA ? toIdString(teamA._id) : toIdString(match?.teamAId),
    teamBId: teamB ? toIdString(teamB._id) : toIdString(match?.teamBId),
    teamA: teamA ? serializeTeam(teamA) : null,
    teamB: teamB ? serializeTeam(teamB) : null,
    refTeamIds: refTeams.map((team) => team.id),
    refTeams,
    byeTeamId: byeTeam ? toIdString(byeTeam._id) : toIdString(match?.byeTeamId),
    scoreboardId: scoreboard ? toIdString(scoreboard._id) : toIdString(match?.scoreboardId),
    scoreboardCode: scoreboard?.code ?? null,
    status: match?.status ?? null,
    startedAt: match?.startedAt ?? null,
    endedAt: match?.endedAt ?? null,
    scoreSummary: resultScoreSummary || scoreboardScoreSummary || null,
    completedSetScores,
    result: serializeMatchResult(match?.result),
    finalizedAt: match?.finalizedAt ?? null,
    finalizedBy: toIdString(match?.finalizedBy),
    createdAt: match?.createdAt ?? null,
    updatedAt: match?.updatedAt ?? null,
  };
}

async function loadPhase1Pools(tournamentId, { populateTeams = true } = {}) {
  let query = Pool.find({
    tournamentId,
    phase: 'phase1',
    name: { $in: PHASE1_POOL_NAMES },
  });

  if (populateTeams) {
    query = query.populate('teamIds', 'name shortName logoUrl orderIndex seed');
  }

  const pools = await query.lean();
  return pools.sort(sortPoolsByPhase1Name);
}

function sortPoolsByPhase2Name(poolA, poolB) {
  const indexA = phase2PoolNameIndex[poolA?.name] ?? Number.MAX_SAFE_INTEGER;
  const indexB = phase2PoolNameIndex[poolB?.name] ?? Number.MAX_SAFE_INTEGER;

  if (indexA !== indexB) {
    return indexA - indexB;
  }

  return String(poolA?.name || '').localeCompare(String(poolB?.name || ''));
}

async function loadPhase2Pools(tournamentId, { populateTeams = true } = {}) {
  let query = Pool.find({
    tournamentId,
    phase: 'phase2',
    name: { $in: PHASE2_POOL_NAMES },
  });

  if (populateTeams) {
    query = query.populate('teamIds', 'name shortName logoUrl orderIndex seed');
  }

  const pools = await query.lean();
  return pools.sort(sortPoolsByPhase2Name);
}

async function loadMatchesForResponse(query) {
  const matches = await Match.find(query)
    .populate('poolId', 'name')
    .populate('teamAId', 'name shortName logoUrl orderIndex seed')
    .populate('teamBId', 'name shortName logoUrl orderIndex seed')
    .populate('refTeamIds', 'name shortName logoUrl orderIndex seed')
    .populate('byeTeamId', 'name shortName logoUrl orderIndex seed')
    .populate('scoreboardId', 'code teams.score sets')
    .sort({ phase: 1, roundBlock: 1, court: 1, createdAt: 1 })
    .lean();

  return matches.map(serializeMatch);
}

function getPoolNamesForPhase(phase) {
  if (phase === 'phase1') {
    return PHASE1_POOL_NAMES;
  }

  if (phase === 'phase2') {
    return PHASE2_POOL_NAMES;
  }

  return [];
}

function hasAnyMatchesForPhase(tournamentId, phase) {
  return Match.findOne({ tournamentId, phase }).select('_id').lean();
}

function validateMatchPhaseFilter(phase) {
  if (!phase) {
    return null;
  }

  return MATCH_PHASES.includes(phase) ? null : 'Invalid phase filter';
}

function validatePoolsForGeneration(pools, phase) {
  const requiredPoolNames = getPoolNamesForPhase(phase);
  const byName = new Map((Array.isArray(pools) ? pools : []).map((pool) => [pool.name, pool]));
  const allTeamIds = [];
  const seenHomeCourts = new Set();

  for (const poolName of requiredPoolNames) {
    const pool = byName.get(poolName);

    if (!pool) {
      return `Pool ${poolName} is missing`;
    }

    if (!Array.isArray(pool.teamIds) || pool.teamIds.length !== 3) {
      return `Pool ${poolName} must have exactly 3 teams`;
    }

    if (!isValidHomeCourt(pool.homeCourt)) {
      return `Pool ${poolName} must have a valid home court before generating matches`;
    }

    const normalizedHomeCourt = normalizeCourtCode(pool.homeCourt);
    if (seenHomeCourts.has(normalizedHomeCourt)) {
      return `Each ${PHASE_LABELS[phase] || phase} pool must use a unique home court`;
    }
    seenHomeCourts.add(normalizedHomeCourt);

    pool.teamIds.forEach((teamId) => allTeamIds.push(toIdString(teamId)));
  }

  if (new Set(allTeamIds).size !== allTeamIds.length) {
    return `Each ${PHASE_LABELS[phase] || phase} team can only appear in one pool`;
  }

  return null;
}

function validatePhase1PoolsForGeneration(pools) {
  return validatePoolsForGeneration(pools, 'phase1');
}

function validatePhase2PoolsForGeneration(pools) {
  return validatePoolsForGeneration(pools, 'phase2');
}

async function ensureTournamentStatusAtLeast(tournamentId, nextStatus) {
  const nextIndex = TOURNAMENT_STATUS_ORDER[nextStatus];

  if (nextIndex === undefined) {
    return;
  }

  const tournament = await Tournament.findById(tournamentId).select('status').lean();
  const currentIndex = TOURNAMENT_STATUS_ORDER[tournament?.status] ?? 0;

  if (currentIndex < nextIndex) {
    await Tournament.updateOne({ _id: tournamentId }, { $set: { status: nextStatus } });
  }
}

async function findTournamentForPublicCode(publicCode) {
  return Tournament.findOne({ publicCode })
    .select('_id name date timezone status facilities publicCode settings.schedule')
    .lean();
}

function emitTournamentEventFromRequest(req, tournamentCode, type, data) {
  const io = req.app?.get('io');
  emitTournamentEvent(io, tournamentCode, type, data);
}

function formatStandingsPayload(standings) {
  return {
    pools: Array.isArray(standings?.pools)
      ? standings.pools.map((pool) => ({
          poolId: pool.poolId ?? null,
          poolName: pool.poolName ?? '',
          teams: Array.isArray(pool.teams)
            ? pool.teams.map((team) => ({
                rank: team.rank ?? null,
                teamId: team.teamId ?? null,
                name: team.name ?? '',
                shortName: team.shortName ?? '',
                seed: team.seed ?? null,
                matchesPlayed: team.matchesPlayed ?? 0,
                matchesWon: team.matchesWon ?? 0,
                matchesLost: team.matchesLost ?? 0,
                setsWon: team.setsWon ?? 0,
                setsLost: team.setsLost ?? 0,
                setsPlayed: team.setsPlayed ?? 0,
                setPct: team.setPct ?? 0,
                pointsFor: team.pointsFor ?? 0,
                pointsAgainst: team.pointsAgainst ?? 0,
                pointDiff: team.pointDiff ?? 0,
              }))
            : [],
        }))
      : [],
    overall: Array.isArray(standings?.overall)
      ? standings.overall.map((team) => ({
          rank: team.rank ?? null,
          teamId: team.teamId ?? null,
          name: team.name ?? '',
          shortName: team.shortName ?? '',
          seed: team.seed ?? null,
          matchesPlayed: team.matchesPlayed ?? 0,
          matchesWon: team.matchesWon ?? 0,
          matchesLost: team.matchesLost ?? 0,
          setsWon: team.setsWon ?? 0,
          setsLost: team.setsLost ?? 0,
          setsPlayed: team.setsPlayed ?? 0,
          setPct: team.setPct ?? 0,
          pointsFor: team.pointsFor ?? 0,
          pointsAgainst: team.pointsAgainst ?? 0,
          pointDiff: team.pointDiff ?? 0,
        }))
      : [],
  };
}

function serializePhaseOverrides(phaseOverrides) {
  const rawPoolOverrides = phaseOverrides?.poolOrderOverrides;
  const poolEntries =
    rawPoolOverrides instanceof Map
      ? Array.from(rawPoolOverrides.entries())
      : rawPoolOverrides && typeof rawPoolOverrides === 'object'
        ? Object.entries(rawPoolOverrides)
        : [];

  const poolOrderOverrides = Object.fromEntries(
    poolEntries.map(([poolName, teamIds]) => [
      poolName,
      Array.isArray(teamIds) ? teamIds.map((teamId) => toIdString(teamId)).filter(Boolean) : [],
    ])
  );

  const overallOrderOverrides = Array.isArray(phaseOverrides?.overallOrderOverrides)
    ? phaseOverrides.overallOrderOverrides
        .map((teamId) => toIdString(teamId))
        .filter(Boolean)
    : [];

  return {
    poolOrderOverrides,
    overallOrderOverrides,
  };
}

const PLAYOFF_EXPECTED_TEAM_COUNT = 15;

const normalizeOverallOrderOverride = (value) =>
  Array.isArray(value) ? value.map((teamId) => toIdString(teamId)).filter(Boolean) : [];

function applyOverallOrderOverride(overallStandings, overallOrderOverride) {
  const normalizedStandings = Array.isArray(overallStandings)
    ? overallStandings.map((entry) => ({
        ...entry,
        teamId: toIdString(entry.teamId),
      }))
    : [];

  const override = normalizeOverallOrderOverride(overallOrderOverride);
  const standingTeamIds = normalizedStandings.map((entry) => entry.teamId).filter(Boolean);

  if (!isPermutation(override, standingTeamIds)) {
    return {
      applied: false,
      standings: normalizedStandings,
    };
  }

  const overrideIndex = new Map(override.map((teamId, index) => [teamId, index]));
  const ordered = [...normalizedStandings]
    .sort((left, right) => {
      const leftIndex = overrideIndex.get(left.teamId);
      const rightIndex = overrideIndex.get(right.teamId);
      return leftIndex - rightIndex;
    })
    .map((entry, index) => ({
      ...entry,
      rank: index + 1,
    }));

  return {
    applied: true,
    standings: ordered,
  };
}

async function computePlayoffGenerationRanking(tournamentId) {
  const [tournament, teams, phase2Matches, standings] = await Promise.all([
    Tournament.findById(tournamentId).select('standingsOverrides').lean(),
    TournamentTeam.find({ tournamentId }).select('_id').lean(),
    Match.find({ tournamentId, phase: 'phase2' }).select('result').lean(),
    computeStandingsBundle(tournamentId, 'cumulative'),
  ]);

  const teamIds = teams.map((team) => toIdString(team._id)).filter(Boolean);
  const phase2FinalizedCount = phase2Matches.filter((match) => Boolean(match?.result)).length;
  const phase2AllFinalized =
    phase2Matches.length > 0 && phase2FinalizedCount === phase2Matches.length;
  const phase2OverallOverride = normalizeOverallOrderOverride(
    tournament?.standingsOverrides?.phase2?.overallOrderOverrides
  );
  const hasValidPhase2Override = isPermutation(phase2OverallOverride, teamIds);
  const missing = [];

  if (!phase2AllFinalized && !hasValidPhase2Override) {
    if (phase2Matches.length === 0) {
      missing.push('Phase 2 matches have not been generated');
    } else {
      missing.push(`Phase 2 has ${phase2FinalizedCount}/${phase2Matches.length} finalized matches`);
    }

    missing.push(
      'Provide a valid phase2 overallOrder standings override to resolve cumulative ranking early'
    );
  }

  const overrideResult = applyOverallOrderOverride(
    standings?.overall || [],
    tournament?.standingsOverrides?.phase2?.overallOrderOverrides
  );
  const cumulativeOverall = overrideResult.standings;

  if (cumulativeOverall.length < PLAYOFF_EXPECTED_TEAM_COUNT) {
    missing.push(
      `Cumulative standings resolved ${cumulativeOverall.length}/${PLAYOFF_EXPECTED_TEAM_COUNT} teams`
    );
  }

  return {
    ok: missing.length === 0,
    missing,
    phase2MatchCount: phase2Matches.length,
    phase2FinalizedCount,
    phase2AllFinalized,
    usedPhase2OverallOverride: overrideResult.applied,
    cumulativeOverall,
  };
}

const parseRoundRank = (roundLabel) => {
  const normalized = typeof roundLabel === 'string' ? roundLabel.trim().toUpperCase() : '';
  const matched = /^R(\d+)$/.exec(normalized);
  if (!matched) {
    return Number.MAX_SAFE_INTEGER;
  }

  return Number(matched[1]);
};

function buildBracketOrder(formatDef, matches) {
  const fromFormat = (getPlayoffStage(formatDef)?.brackets || [])
    .map((bracketDef) => normalizeBracket(bracketDef?.name))
    .filter(Boolean);
  const fromMatches = uniqueValues(
    (Array.isArray(matches) ? matches : [])
      .map((match) => normalizeBracket(match?.bracket))
      .filter(Boolean)
  );

  return uniqueValues([...fromFormat, ...fromMatches]);
}

function sortPlayoffMatches(matches, options = {}) {
  const bracketOrderList = Array.isArray(options?.bracketOrder)
    ? options.bracketOrder.map((entry) => normalizeBracket(entry)).filter(Boolean)
    : [];
  const bracketOrderLookup = new Map(
    bracketOrderList.map((bracketKey, index) => [bracketKey, index])
  );

  return [...(Array.isArray(matches) ? matches : [])].sort((left, right) => {
    const leftBracket = normalizeBracket(left?.bracket);
    const rightBracket = normalizeBracket(right?.bracket);
    const byBracket =
      (bracketOrderLookup.get(leftBracket) ?? Number.MAX_SAFE_INTEGER) -
      (bracketOrderLookup.get(rightBracket) ?? Number.MAX_SAFE_INTEGER);
    if (byBracket !== 0) {
      return byBracket;
    }

    const byBracketName = leftBracket.localeCompare(rightBracket);
    if (byBracketName !== 0) {
      return byBracketName;
    }

    const byRound = parseRoundRank(left?.bracketRound) - parseRoundRank(right?.bracketRound);
    if (byRound !== 0) {
      return byRound;
    }

    const byRoundLabel = String(left?.bracketRound || '').localeCompare(
      String(right?.bracketRound || '')
    );
    if (byRoundLabel !== 0) {
      return byRoundLabel;
    }

    if ((left?.roundBlock || 0) !== (right?.roundBlock || 0)) {
      return (left?.roundBlock || 0) - (right?.roundBlock || 0);
    }

    const byCourt = String(left?.court || '').localeCompare(String(right?.court || ''));
    if (byCourt !== 0) {
      return byCourt;
    }

    return String(toIdString(left?._id) || '').localeCompare(String(toIdString(right?._id) || ''));
  });
}

function buildLegacyPlayoffPayload(matches) {
  const bracketOrder = [...PLAYOFF_BRACKETS];
  const orderedMatches = sortPlayoffMatches(matches, { bracketOrder });
  const brackets = buildPlayoffBracketView(orderedMatches);

  bracketOrder.forEach((bracketKey) => {
    if (brackets?.[bracketKey] && !Array.isArray(brackets[bracketKey].roundOrder)) {
      brackets[bracketKey].roundOrder = ['R1', 'R2', 'R3'];
    }
  });

  return {
    matches: orderedMatches,
    brackets,
    opsSchedule: buildPlayoffOpsSchedule(orderedMatches),
    bracketOrder,
  };
}

function createDynamicRoundLabel(match, bracketLabel) {
  if (Number.isFinite(Number(match?.seedA)) && Number.isFinite(Number(match?.seedB))) {
    return `${bracketLabel} ${Number(match.seedA)}v${Number(match.seedB)}`;
  }

  if (isNonEmptyString(match?.bracketRound)) {
    return `${bracketLabel} ${match.bracketRound.trim()}`;
  }

  return bracketLabel;
}

function resolveTeamName(team) {
  if (!team) {
    return 'TBD';
  }

  if (typeof team === 'string') {
    const trimmed = team.trim();
    return trimmed || 'TBD';
  }

  if (typeof team === 'object') {
    const shortName =
      typeof team.shortName === 'string' ? team.shortName.trim() : '';
    if (shortName) {
      return shortName;
    }

    const name = typeof team.name === 'string' ? team.name.trim() : '';
    if (name) {
      return name;
    }
  }

  return 'TBD';
}

function buildGenericPlayoffBracketView(matches, bracketOrder, formatDef) {
  const orderedBracketKeys = uniqueValues(
    (Array.isArray(bracketOrder) ? bracketOrder : []).map((entry) => normalizeBracket(entry)).filter(Boolean)
  );
  const playoffStage = getPlayoffStage(formatDef);
  const bracketDefsByKey = new Map(
    (Array.isArray(playoffStage?.brackets) ? playoffStage.brackets : [])
      .map((bracketDef) => [normalizeBracket(bracketDef?.name), bracketDef])
      .filter(([bracketKey]) => Boolean(bracketKey))
  );
  const bracketState = {};
  const seedBuckets = new Map();

  orderedBracketKeys.forEach((bracketKey) => {
    bracketState[bracketKey] = {
      bracket: bracketKey,
      label: resolveBracketLabelFromKey(bracketKey),
      seeds: [],
      rounds: {},
      roundOrder: [],
    };
    seedBuckets.set(bracketKey, new Map());
  });

  const ensureBracketState = (bracketKey) => {
    if (!bracketState[bracketKey]) {
      bracketState[bracketKey] = {
        bracket: bracketKey,
        label: resolveBracketLabelFromKey(bracketKey),
        seeds: [],
        rounds: {},
        roundOrder: [],
      };
      seedBuckets.set(bracketKey, new Map());
    }
    return bracketState[bracketKey];
  };

  const addSeedEntry = (bracketKey, bracketSeed, teamId, team) => {
    const normalizedBracketKey = normalizeBracket(bracketKey);
    const parsedBracketSeed = Number(bracketSeed);
    const normalizedTeamId = toIdString(teamId);

    if (!Number.isFinite(parsedBracketSeed) || !normalizedTeamId) {
      return;
    }

    const bucket = seedBuckets.get(normalizedBracketKey);
    if (!bucket) {
      return;
    }

    const bracketDef = bracketDefsByKey.get(normalizedBracketKey);
    const seedsFromOverall = Array.isArray(bracketDef?.seedsFromOverall)
      ? bracketDef.seedsFromOverall
      : [];
    const overallSeed = Number(seedsFromOverall[parsedBracketSeed - 1]);

    bucket.set(parsedBracketSeed, {
      seed: Number.isFinite(overallSeed) ? overallSeed : parsedBracketSeed,
      bracketSeed: parsedBracketSeed,
      overallSeed: Number.isFinite(overallSeed) ? overallSeed : null,
      teamId: normalizedTeamId,
      team,
    });
  };

  (Array.isArray(matches) ? matches : []).forEach((match) => {
    const bracketKey = normalizeBracket(match?.bracket);
    if (!bracketKey) {
      return;
    }

    const currentBracketState = ensureBracketState(bracketKey);
    const roundKey = isNonEmptyString(match?.bracketRound) ? match.bracketRound.trim() : 'R1';

    if (!Array.isArray(currentBracketState.rounds[roundKey])) {
      currentBracketState.rounds[roundKey] = [];
    }
    currentBracketState.rounds[roundKey].push(match);

    addSeedEntry(bracketKey, match?.seedA, match?.teamAId?._id || match?.teamAId, match?.teamA);
    addSeedEntry(bracketKey, match?.seedB, match?.teamBId?._id || match?.teamBId, match?.teamB);
  });

  Object.keys(bracketState).forEach((bracketKey) => {
    const bucket = seedBuckets.get(bracketKey);
    const state = bracketState[bracketKey];
    state.seeds = bucket
      ? [...bucket.values()].sort(
          (left, right) => (left?.bracketSeed ?? Number.MAX_SAFE_INTEGER) - (right?.bracketSeed ?? Number.MAX_SAFE_INTEGER)
        )
      : [];
    state.roundOrder = Object.keys(state.rounds).sort((left, right) => {
      const byRank = parseRoundRank(left) - parseRoundRank(right);
      if (byRank !== 0) {
        return byRank;
      }
      return left.localeCompare(right);
    });
    state.roundOrder.forEach((roundKey) => {
      state.rounds[roundKey].sort((left, right) => {
        const bySeedA = (Number(left?.seedA) || Number.MAX_SAFE_INTEGER) - (Number(right?.seedA) || Number.MAX_SAFE_INTEGER);
        if (bySeedA !== 0) {
          return bySeedA;
        }

        return String(left?.bracketMatchKey || '').localeCompare(String(right?.bracketMatchKey || ''));
      });
    });
  });

  return bracketState;
}

function buildGenericPlayoffOpsSchedule(matches, bracketView) {
  const orderedRoundBlocks = uniqueValues(
    (Array.isArray(matches) ? matches : [])
      .map((match) => Number(match?.roundBlock))
      .filter((roundBlock) => Number.isFinite(roundBlock))
      .map((roundBlock) => Math.floor(roundBlock))
      .sort((left, right) => left - right)
  );
  const labelByBracket = new Map(
    Object.entries(bracketView || {}).map(([key, value]) => [
      normalizeBracket(key),
      value?.label || resolveBracketLabelFromKey(key),
    ])
  );

  return orderedRoundBlocks.map((roundBlock, index) => {
    const slots = (Array.isArray(matches) ? matches : [])
      .filter((match) => Number(match?.roundBlock) === roundBlock)
      .sort((left, right) => {
        const byCourt = String(left?.court || '').localeCompare(String(right?.court || ''));
        if (byCourt !== 0) {
          return byCourt;
        }

        const byBracket = normalizeBracket(left?.bracket).localeCompare(normalizeBracket(right?.bracket));
        if (byBracket !== 0) {
          return byBracket;
        }

        return String(left?.bracketMatchKey || '').localeCompare(String(right?.bracketMatchKey || ''));
      })
      .map((match) => {
        const bracketKey = normalizeBracket(match?.bracket);
        const bracketLabel = labelByBracket.get(bracketKey) || resolveBracketLabelFromKey(bracketKey);
        return {
          roundBlock,
          facility: match?.facility || getFacilityFromCourt(match?.court),
          court: match?.court || null,
          matchId: match?._id || null,
          matchLabel: createDynamicRoundLabel(match, bracketLabel),
          bracket: match?.bracket || null,
          bracketRound: match?.bracketRound || null,
          teams: {
            a: resolveTeamName(match?.teamA),
            b: resolveTeamName(match?.teamB),
          },
          refs:
            Array.isArray(match?.refTeams) && match.refTeams.length > 0
              ? match.refTeams.map((team) => resolveTeamName(team))
              : [],
          status: match?.status || null,
        };
      });

    return {
      roundBlock,
      label: `Playoff Round ${index + 1}`,
      slots,
    };
  });
}

function buildPlayoffOpsScheduleFromSchedulePlanSlots(slotViews) {
  const playoffSlots = (Array.isArray(slotViews) ? slotViews : [])
    .filter((slot) => normalizeSchedulePlanSlotKind(slot?.kind) === 'match')
    .filter((slot) => Number.isFinite(Number(slot?.roundBlock)))
    .sort((left, right) => {
      const byRound = Number(left?.roundBlock) - Number(right?.roundBlock);
      if (byRound !== 0) {
        return byRound;
      }

      const byCourt = String(left?.courtCode || left?.courtLabel || '').localeCompare(
        String(right?.courtCode || right?.courtLabel || '')
      );
      if (byCourt !== 0) {
        return byCourt;
      }

      return String(left?.slotId || '').localeCompare(String(right?.slotId || ''));
    });
  const orderedRoundBlocks = uniqueValues(
    playoffSlots
      .map((slot) => Number(slot?.roundBlock))
      .filter((roundBlock) => Number.isFinite(roundBlock))
      .map((roundBlock) => Math.floor(roundBlock))
      .sort((left, right) => left - right)
  );

  return orderedRoundBlocks.map((roundBlock, index) => {
    const slots = playoffSlots
      .filter((slot) => Number(slot?.roundBlock) === roundBlock)
      .map((slot) => {
        const participantA = slot?.participants?.[0] || null;
        const participantB = slot?.participants?.[1] || null;
        const teams = {
          a: participantA?.label || slot?.teamA?.shortName || 'TBD',
          b: participantB?.label || slot?.teamB?.shortName || 'TBD',
        };

        return {
          roundBlock,
          facility: slot?.facilityLabel || slot?.facility || getFacilityFromCourt(slot?.courtCode),
          court: slot?.courtCode || slot?.courtLabel || null,
          matchId: slot?.matchId || null,
          matchLabel:
            slot?.roundLabel
            || slot?.matchupReferenceLabel
            || slot?.matchupLabel
            || 'Playoff Match',
          bracket: slot?.bracket || null,
          bracketRound: slot?.roundLabel || null,
          teams,
          refs:
            slot?.refLabel && slot.refLabel !== 'TBD'
              ? [slot.refLabel]
              : [],
          status: slot?.status === 'scheduled_tbd' ? 'scheduled' : slot?.status || 'scheduled',
        };
      });

    return {
      roundBlock,
      label: `Playoff Round ${index + 1}`,
      slots,
    };
  });
}

function buildGenericPlayoffPayload(matches, formatDef) {
  const bracketOrder = buildBracketOrder(formatDef, matches);
  const orderedMatches = sortPlayoffMatches(matches, { bracketOrder });
  const brackets = buildGenericPlayoffBracketView(orderedMatches, bracketOrder, formatDef);

  return {
    matches: orderedMatches,
    brackets,
    opsSchedule: buildGenericPlayoffOpsSchedule(orderedMatches, brackets),
    bracketOrder,
  };
}

function buildFormatAwarePlayoffPayload(matches, formatDef) {
  if (!formatDef || formatDef?.id === DEFAULT_15_TEAM_FORMAT_ID) {
    return buildLegacyPlayoffPayload(matches);
  }

  return buildGenericPlayoffPayload(matches, formatDef);
}

function getPhaseSortOrder(phase) {
  if (phase === 'phase1') {
    return 1;
  }

  if (phase === 'phase2') {
    return 2;
  }

  if (phase === 'playoffs') {
    return 3;
  }

  return Number.MAX_SAFE_INTEGER;
}

function formatTeamShortName(team) {
  if (!team || typeof team !== 'object') {
    return 'TBD';
  }

  return team.shortName || team.name || 'TBD';
}

function serializeCourtScheduleScore(result) {
  if (!result) {
    return null;
  }

  return {
    setsA: result.setsWonA ?? 0,
    setsB: result.setsWonB ?? 0,
    pointsA: result.pointsForA ?? 0,
    pointsB: result.pointsForB ?? 0,
  };
}

function serializeMatchForCourtSchedule(match, phaseLabels = PHASE_LABELS) {
  return {
    matchId: toIdString(match?._id),
    phase: match?.phase ?? null,
    phaseLabel: resolvePhaseLabel(match?.phase, phaseLabels),
    roundBlock: match?.roundBlock ?? null,
    poolName: match?.poolId?.name ?? null,
    status: match?.status ?? 'scheduled',
    teamA: formatTeamShortName(match?.teamAId),
    teamB: formatTeamShortName(match?.teamBId),
    refs: Array.isArray(match?.refTeamIds) ? match.refTeamIds.map(formatTeamShortName) : [],
    score: serializeCourtScheduleScore(match?.result),
  };
}

function sortMatchesForCourtSchedule(matches) {
  return [...(Array.isArray(matches) ? matches : [])].sort((left, right) => {
    const roundA = Number.isFinite(Number(left?.roundBlock)) ? Number(left.roundBlock) : Number.MAX_SAFE_INTEGER;
    const roundB = Number.isFinite(Number(right?.roundBlock)) ? Number(right.roundBlock) : Number.MAX_SAFE_INTEGER;

    if (roundA !== roundB) {
      return roundA - roundB;
    }

    const phaseOrderA = getPhaseSortOrder(left?.phase);
    const phaseOrderB = getPhaseSortOrder(right?.phase);

    if (phaseOrderA !== phaseOrderB) {
      return phaseOrderA - phaseOrderB;
    }

    const createdA = normalizeCreatedAtMs(left?.createdAt);
    const createdB = normalizeCreatedAtMs(right?.createdAt);

    if (createdA !== createdB) {
      return createdA - createdB;
    }

    return String(toIdString(left?._id) || '').localeCompare(String(toIdString(right?._id) || ''));
  });
}

function safeNonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function computeSetWinsFromScoreboard(sets) {
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

function serializeScoreSummaryFromScoreboard(scoreboard) {
  if (!scoreboard || typeof scoreboard !== 'object') {
    return null;
  }

  const sets = computeSetWinsFromScoreboard(scoreboard.sets);

  return {
    setsA: sets.a,
    setsB: sets.b,
    pointsA: safeNonNegativeNumber(scoreboard?.teams?.[0]?.score),
    pointsB: safeNonNegativeNumber(scoreboard?.teams?.[1]?.score),
  };
}

function serializeCompletedSetScoresFromResult(result) {
  return Array.isArray(result?.setScores)
    ? result.setScores
        .slice()
        .sort((left, right) => (left?.setNo ?? 0) - (right?.setNo ?? 0))
        .map((set, index) => ({
          setNo: Number.isFinite(Number(set?.setNo)) ? Number(set.setNo) : index + 1,
          a: safeNonNegativeNumber(set?.a),
          b: safeNonNegativeNumber(set?.b),
        }))
    : [];
}

function serializeCompletedSetScoresFromScoreboard(scoreboard) {
  return Array.isArray(scoreboard?.sets)
    ? scoreboard.sets
        .filter((set) => Array.isArray(set?.scores) && set.scores.length === 2)
        .map((set, index) => ({
          setNo: index + 1,
          a: safeNonNegativeNumber(set.scores[0]),
          b: safeNonNegativeNumber(set.scores[1]),
        }))
    : [];
}

function resolveCompletedSetScores(result, scoreboard) {
  const fromResult = serializeCompletedSetScoresFromResult(result);

  if (fromResult.length > 0) {
    return fromResult;
  }

  return serializeCompletedSetScoresFromScoreboard(scoreboard);
}

function normalizeMatchStatus(status) {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';

  if (normalized === 'live') {
    return 'live';
  }

  if (normalized === 'final') {
    return 'final';
  }

  if (normalized === 'ended') {
    return 'ended';
  }

  return 'scheduled';
}

function formatPublicTeamSnippet(team) {
  if (!team || typeof team !== 'object') {
    return null;
  }

  return {
    teamId: toIdString(team._id),
    shortName: team.shortName || team.name || 'TBD',
    logoUrl: team.logoUrl || null,
  };
}

function resolveVenueCourtForMatch(match, tournament) {
  return findCourtInVenue(
    tournament?.settings?.venue,
    match?.courtId || match?.court || match?.homeCourt || null
  );
}

function resolveFacilityLabel(match, tournament) {
  const venueCourt = resolveVenueCourtForMatch(match, tournament);
  const facilityCode =
    venueCourt?.facilityName
    || match?.facility
    || getFacilityFromCourt(match?.court);
  return FACILITY_LABELS[facilityCode] || facilityCode || '';
}

function serializeMatchForLiveView(match, tournament, phaseLabels = PHASE_LABELS) {
  const teamA = match?.teamAId && typeof match.teamAId === 'object' ? match.teamAId : null;
  const teamB = match?.teamBId && typeof match.teamBId === 'object' ? match.teamBId : null;
  const scoreboard = match?.scoreboardId && typeof match.scoreboardId === 'object' ? match.scoreboardId : null;
  const venueCourt = resolveVenueCourtForMatch(match, tournament);
  const resultScore = serializeCourtScheduleScore(match?.result);
  const scoreboardScore = serializeScoreSummaryFromScoreboard(scoreboard);
  const completedSetScores = resolveCompletedSetScores(match?.result, scoreboard);
  const courtCode = match?.courtId || match?.court || null;
  const courtLabel =
    venueCourt?.courtName || mapCourtDisplayLabel(match?.court) || mapCourtDisplayLabel(courtCode);

  return {
    matchId: toIdString(match?._id),
    phase: match?.phase ?? null,
    phaseLabel: resolvePhaseLabel(match?.phase, phaseLabels),
    bracket: match?.bracket ?? null,
    roundBlock: match?.roundBlock ?? null,
    timeLabel: formatRoundBlockStartTime(match?.roundBlock, tournament),
    facility: match?.facilityId || match?.facility || getFacilityFromCourt(match?.court),
    facilityLabel: resolveFacilityLabel(match, tournament),
    courtCode,
    courtLabel,
    teamA: formatPublicTeamSnippet(teamA),
    teamB: formatPublicTeamSnippet(teamB),
    status: normalizeMatchStatus(match?.status),
    startedAt: match?.startedAt ?? null,
    endedAt: match?.endedAt ?? null,
    scoreSummary: resultScore || scoreboardScore || null,
    completedSetScores,
    scoreboardCode: scoreboard?.code ?? null,
  };
}

function sortLiveMatchCards(matchCards) {
  return [...(Array.isArray(matchCards) ? matchCards : [])].sort((left, right) => {
    const leftRound = Number.isFinite(Number(left?.roundBlock))
      ? Number(left.roundBlock)
      : Number.MAX_SAFE_INTEGER;
    const rightRound = Number.isFinite(Number(right?.roundBlock))
      ? Number(right.roundBlock)
      : Number.MAX_SAFE_INTEGER;

    if (leftRound !== rightRound) {
      return leftRound - rightRound;
    }

    const leftCourt = String(left?.courtLabel || left?.courtCode || '');
    const rightCourt = String(right?.courtLabel || right?.courtCode || '');
    const byCourt = leftCourt.localeCompare(rightCourt);

    if (byCourt !== 0) {
      return byCourt;
    }

    return String(left?.matchId || '').localeCompare(String(right?.matchId || ''));
  });
}

function serializeMatchForTeamView(match, focusTeamId, tournament, phaseLabels = PHASE_LABELS) {
  const teamA = match?.teamAId && typeof match.teamAId === 'object' ? match.teamAId : null;
  const teamB = match?.teamBId && typeof match.teamBId === 'object' ? match.teamBId : null;
  const teamAId = toIdString(teamA?._id || match?.teamAId);
  const teamBId = toIdString(teamB?._id || match?.teamBId);
  const normalizedFocusTeamId = toIdString(focusTeamId);
  const isTeamHome = normalizedFocusTeamId && teamAId === normalizedFocusTeamId;
  const opponentTeam = isTeamHome ? teamB : teamA;
  const status = normalizeMatchStatus(match?.status);
  const resultScore = serializeCourtScheduleScore(match?.result);
  const scoreboard =
    match?.scoreboardId && typeof match.scoreboardId === 'object' ? match.scoreboardId : null;
  const pool = match?.poolId && typeof match.poolId === 'object' ? match.poolId : null;
  const venueCourt = resolveVenueCourtForMatch(match, tournament);
  const scoreboardScore = serializeScoreSummaryFromScoreboard(scoreboard);
  const completedSetScores = resolveCompletedSetScores(match?.result, scoreboard);
  const courtCode = match?.courtId || match?.court || null;
  const courtLabel =
    venueCourt?.courtName || mapCourtDisplayLabel(match?.court) || mapCourtDisplayLabel(courtCode);

  return {
    matchId: toIdString(match?._id),
    phase: match?.phase ?? null,
    phaseLabel: resolvePhaseLabel(match?.phase, phaseLabels),
    stageKey: match?.stageKey ?? null,
    plannedSlotId: isNonEmptyString(match?.plannedSlotId) ? match.plannedSlotId.trim() : null,
    poolName: pool?.name ?? null,
    bracket: match?.bracket ?? null,
    bracketLabel: BRACKET_LABELS[normalizeBracket(match?.bracket)] || null,
    roundLabel: match?.bracketRound ?? null,
    roundBlock: match?.roundBlock ?? null,
    timeLabel: formatRoundBlockStartTime(match?.roundBlock, tournament),
    facility: match?.facilityId || match?.facility || getFacilityFromCourt(match?.court),
    facilityLabel: resolveFacilityLabel(match, tournament),
    courtCode,
    courtLabel,
    opponent: formatPublicTeamSnippet(opponentTeam),
    teamA: formatPublicTeamSnippet(teamA),
    teamB: formatPublicTeamSnippet(teamB),
    isTeamHome: Boolean(isTeamHome),
    status,
    startedAt: match?.startedAt ?? null,
    endedAt: match?.endedAt ?? null,
    scoreSummary: resultScore || scoreboardScore,
    completedSetScores,
    setSummary: resultScore || scoreboardScore
      ? {
          setsA: Number(resultScore?.setsA ?? scoreboardScore?.setsA) || 0,
          setsB: Number(resultScore?.setsB ?? scoreboardScore?.setsB) || 0,
          setScores: completedSetScores,
        }
      : null,
    scoreboardCode: scoreboard?.code ?? null,
    refBy: Array.isArray(match?.refTeamIds)
      ? match.refTeamIds
          .map((team) => (team && typeof team === 'object' ? { shortName: team.shortName || team.name || 'TBD' } : null))
          .filter(Boolean)
      : [],
  };
}

function normalizeSchedulePlanSlotKind(value) {
  return String(value || '').trim().toLowerCase() === 'lunch' ? 'lunch' : 'match';
}

function normalizeSchedulePlanSlotTimeIndex(slot, tournament) {
  const explicitTimeIndex = Number(slot?.timeIndex);
  if (Number.isFinite(explicitTimeIndex)) {
    return explicitTimeIndex;
  }

  const roundBlock = Number(slot?.roundBlock);
  if (Number.isFinite(roundBlock) && roundBlock > 0) {
    const minutesSinceMidnight = resolveSchedulePlanRoundBlockStartMinutes(
      Math.floor(roundBlock),
      tournament
    );
    return Number.isFinite(minutesSinceMidnight) ? minutesSinceMidnight : null;
  }

  return null;
}

function formatSchedulePlanTimeLabel(timeIndex, tournament) {
  if (!Number.isFinite(Number(timeIndex))) {
    return '';
  }

  const timezone = isNonEmptyString(tournament?.timezone)
    ? tournament.timezone.trim()
    : 'America/New_York';

  try {
    return formatMinutesInTimezone(Number(timeIndex), timezone);
  } catch {
    return formatMinutesAsClockTime(Number(timeIndex));
  }
}

function normalizeCourtLookupKey(value) {
  return isNonEmptyString(value) ? value.trim().toLowerCase() : '';
}

function formatPublicTeamSnippetFromRecord(team, fallbackTeamId = null) {
  const teamId = toIdString(team?._id) || toIdString(fallbackTeamId);
  const shortName = team?.shortName || team?.name || 'TBD';
  const logoUrl = isNonEmptyString(team?.logoUrl) ? team.logoUrl : null;

  if (!teamId && shortName === 'TBD' && !logoUrl) {
    return null;
  }

  return {
    teamId: teamId || null,
    shortName,
    logoUrl,
  };
}

function serializeSchedulePlanEntry(entry, teamsById = new Map()) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  if (entry.type === 'rankRef') {
    const label = formatScheduleRankRefLabel(entry);
    if (!label) {
      return null;
    }

    return {
      type: 'rankRef',
      teamId: null,
      label,
      referenceLabel: label,
      team: null,
    };
  }

  if (entry.type === 'teamId') {
    const teamId = toIdString(entry.teamId);
    if (!teamId) {
      return null;
    }

    const team = teamsById.get(teamId) || null;
    const teamSnippet = formatPublicTeamSnippetFromRecord(team, teamId);
    const label = teamSnippet?.shortName || 'TBD';
    const referenceLabel =
      entry?.sourceRankRef && typeof entry.sourceRankRef === 'object'
        ? formatScheduleRankRefLabel(entry.sourceRankRef)
        : '';

    return {
      type: 'teamId',
      teamId,
      label,
      referenceLabel,
      team: teamSnippet,
    };
  }

  return null;
}

function resolveSchedulePlanSlotStatus({ kind, participants, match }) {
  if (kind === 'lunch') {
    return 'scheduled';
  }

  const normalizedParticipants = Array.isArray(participants) ? participants : [];
  const hasRankReferences = normalizedParticipants.some((entry) => entry?.type === 'rankRef');

  if (hasRankReferences) {
    return 'scheduled_tbd';
  }

  if (match) {
    return normalizeMatchStatus(match.status);
  }

  return 'scheduled';
}

function resolveSchedulePlanSlotPhase({
  match,
  stageKey,
  formatDef,
  stageDefinitions,
}) {
  if (isNonEmptyString(match?.phase)) {
    return match.phase.trim();
  }

  if (!isNonEmptyString(stageKey)) {
    return null;
  }

  const stageDef = stageDefinitions.get(stageKey.trim());
  if (!stageDef) {
    return null;
  }

  return resolvePoolPhase(formatDef, stageDef.key, stageDef);
}

function serializeSchedulePlanSlotView({
  slot,
  tournament,
  formatDef,
  phaseLabels = PHASE_LABELS,
  stageDefinitions = new Map(),
  stageLabels = new Map(),
  teamsById = new Map(),
  matchById = new Map(),
} = {}) {
  const kind = normalizeSchedulePlanSlotKind(slot?.kind);
  const slotId = isNonEmptyString(slot?.slotId) ? slot.slotId.trim() : '';
  const rawMatchId = toIdString(slot?.matchId);
  const matchId = rawMatchId && matchById.has(rawMatchId) ? rawMatchId : rawMatchId || null;
  const match = matchId ? matchById.get(matchId) || null : null;
  const scoreboard =
    match?.scoreboardId && typeof match.scoreboardId === 'object' ? match.scoreboardId : null;
  const rawParticipants = Array.isArray(slot?.participants) ? slot.participants : [];
  const participants = rawParticipants
    .slice(0, 2)
    .map((entry) => serializeSchedulePlanEntry(entry, teamsById))
    .filter(Boolean);
  const matchTeamAParticipant = serializeSchedulePlanEntry(
    { type: 'teamId', teamId: match?.teamAId?._id || match?.teamAId },
    teamsById
  );
  const matchTeamBParticipant = serializeSchedulePlanEntry(
    { type: 'teamId', teamId: match?.teamBId?._id || match?.teamBId },
    teamsById
  );
  const slotParticipantA = participants[0] || null;
  const slotParticipantB = participants[1] || null;
  const resolvedParticipantA = matchTeamAParticipant
    ? {
      ...matchTeamAParticipant,
      referenceLabel:
        slotParticipantA?.referenceLabel
        || matchTeamAParticipant?.referenceLabel
        || '',
    }
    : slotParticipantA;
  const resolvedParticipantB = matchTeamBParticipant
    ? {
      ...matchTeamBParticipant,
      referenceLabel:
        slotParticipantB?.referenceLabel
        || matchTeamBParticipant?.referenceLabel
        || '',
    }
    : slotParticipantB;
  const resolvedParticipants = [resolvedParticipantA, resolvedParticipantB].filter(Boolean);
  const refFromSlot = serializeSchedulePlanEntry(slot?.ref, teamsById);
  const refFromMatch =
    Array.isArray(match?.refTeamIds) &&
    match.refTeamIds.length > 0
      ? serializeSchedulePlanEntry(
        {
          type: 'teamId',
          teamId: match.refTeamIds[0]?._id || match.refTeamIds[0],
        },
        teamsById
      )
      : null;
  const ref = kind === 'lunch' ? null : refFromMatch || refFromSlot || null;
  const byeEntries = (Array.isArray(slot?.byeRefs) ? slot.byeRefs : [])
    .map((entry) => serializeSchedulePlanEntry(entry, teamsById))
    .filter(Boolean);
  if (byeEntries.length === 0 && match?.byeTeamId) {
    const byeFromMatch = serializeSchedulePlanEntry(
      { type: 'teamId', teamId: match?.byeTeamId?._id || match?.byeTeamId },
      teamsById
    );
    if (byeFromMatch) {
      byeEntries.push(byeFromMatch);
    }
  }

  const roundBlock =
    Number.isFinite(Number(slot?.roundBlock)) && Number(slot.roundBlock) > 0
      ? Math.floor(Number(slot.roundBlock))
      : Number.isFinite(Number(match?.roundBlock)) && Number(match.roundBlock) > 0
        ? Math.floor(Number(match.roundBlock))
        : null;
  const timeIndex = normalizeSchedulePlanSlotTimeIndex(slot, tournament);
  const timeLabel =
    formatSchedulePlanTimeLabel(timeIndex, tournament)
    || formatRoundBlockStartTime(roundBlock, tournament)
    || '';
  const stageKey = isNonEmptyString(slot?.stageKey)
    ? slot.stageKey.trim()
    : isNonEmptyString(match?.stageKey)
      ? match.stageKey.trim()
      : '';
  const stageLabel = stageKey === 'lunch'
    ? 'Lunch'
    : stageLabels.get(stageKey)
      || (isNonEmptyString(match?.phase) ? resolvePhaseLabel(match.phase, phaseLabels) : '')
      || toTitleCase(stageKey)
      || 'Stage';
  const phase = resolveSchedulePlanSlotPhase({
    match,
    stageKey,
    formatDef,
    stageDefinitions,
  });
  const phaseLabel = phase ? resolvePhaseLabel(phase, phaseLabels) : stageLabel;
  const poolName = match?.poolId && typeof match.poolId === 'object' ? match.poolId.name || null : null;
  const requestedCourtKey = isNonEmptyString(slot?.courtId)
    ? slot.courtId.trim()
    : isNonEmptyString(match?.courtId)
      ? match.courtId.trim()
      : isNonEmptyString(match?.court)
        ? match.court.trim()
        : '';
  const venueCourt = findCourtInVenue(tournament?.settings?.venue, requestedCourtKey);
  const courtCode = toIdString(venueCourt?.courtId)
    || (isNonEmptyString(slot?.courtId) ? slot.courtId.trim() : '')
    || (isNonEmptyString(match?.courtId) ? match.courtId.trim() : '')
    || (isNonEmptyString(match?.court) ? match.court.trim() : '')
    || null;
  const facility = toIdString(venueCourt?.facilityId)
    || (isNonEmptyString(slot?.facilityId) ? slot.facilityId.trim() : '')
    || (isNonEmptyString(match?.facilityId) ? match.facilityId.trim() : '')
    || (isNonEmptyString(match?.facility) ? match.facility.trim() : '')
    || null;
  const courtLabel = venueCourt?.courtName
    || mapCourtDisplayLabel(match?.court)
    || mapCourtDisplayLabel(courtCode)
    || courtCode
    || '';
  const facilityLabel = venueCourt?.facilityName
    || FACILITY_LABELS[match?.facility]
    || match?.facility
    || FACILITY_LABELS[getFacilityFromCourt(courtCode)]
    || getFacilityFromCourt(courtCode)
    || '';
  const matchupLabel = kind === 'lunch'
    ? 'Lunch Break'
    : resolvedParticipants.length >= 2
      ? `${resolvedParticipants[0]?.label || 'TBD'} vs ${resolvedParticipants[1]?.label || 'TBD'}`
      : 'TBD vs TBD';
  const matchupReferenceLabel = kind === 'lunch'
    ? ''
    : resolvedParticipants.length >= 2
      ? `${resolvedParticipants[0]?.referenceLabel || resolvedParticipants[0]?.label || 'TBD'} vs ${resolvedParticipants[1]?.referenceLabel || resolvedParticipants[1]?.label || 'TBD'}`
      : '';
  const refLabel = kind === 'lunch' ? null : ref?.label || 'TBD';
  const refReferenceLabel = kind === 'lunch' ? null : ref?.referenceLabel || ref?.label || '';
  const byeLabel = byeEntries.map((entry) => entry?.label).filter(Boolean).join(', ');
  const scoreSummary = serializeCourtScheduleScore(match?.result)
    || serializeScoreSummaryFromScoreboard(scoreboard)
    || null;
  const completedSetScores = resolveCompletedSetScores(match?.result, scoreboard);
  const status = resolveSchedulePlanSlotStatus({
    kind,
    participants: resolvedParticipants,
    match,
  });

  return {
    slotId,
    kind,
    stageKey: stageKey || null,
    stageLabel,
    phase: phase || null,
    phaseLabel,
    roundBlock,
    timeIndex,
    timeLabel,
    status,
    matchId,
    plannedSlotId: isNonEmptyString(match?.plannedSlotId) ? match.plannedSlotId.trim() : null,
    poolName,
    bracket: match?.bracket ?? null,
    roundLabel: match?.bracketRound ?? null,
    startedAt: match?.startedAt ?? null,
    endedAt: match?.endedAt ?? null,
    courtCode,
    courtLabel,
    facility,
    facilityLabel,
    matchupLabel,
    matchupReferenceLabel,
    participants: resolvedParticipants,
    ref,
    refLabel,
    refReferenceLabel,
    byeParticipants: byeEntries,
    byeLabel: byeLabel || null,
    teamA: resolvedParticipants[0]?.team || null,
    teamB: resolvedParticipants[1]?.team || null,
    scoreSummary,
    completedSetScores,
    setSummary: scoreSummary
      ? {
          setsA: Number(scoreSummary?.setsA) || 0,
          setsB: Number(scoreSummary?.setsB) || 0,
          setScores: completedSetScores,
        }
      : null,
    scoreboardCode: scoreboard?.code || null,
    lunchDurationMinutes:
      kind === 'lunch'
        ? (
          toPositiveInteger(tournament?.settings?.schedule?.lunchDurationMinutes)
          || TOURNAMENT_SCHEDULE_DEFAULTS.lunchDurationMinutes
        )
        : null,
  };
}

function sortSchedulePlanSlotsByTime(slots) {
  return [...(Array.isArray(slots) ? slots : [])].sort((left, right) => {
    const leftTime = Number.isFinite(Number(left?.timeIndex))
      ? Number(left.timeIndex)
      : Number.isFinite(Number(left?.roundBlock))
        ? Number(left.roundBlock) * 100
        : Number.MAX_SAFE_INTEGER;
    const rightTime = Number.isFinite(Number(right?.timeIndex))
      ? Number(right.timeIndex)
      : Number.isFinite(Number(right?.roundBlock))
        ? Number(right.roundBlock) * 100
        : Number.MAX_SAFE_INTEGER;

    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    const leftRound = Number.isFinite(Number(left?.roundBlock))
      ? Number(left.roundBlock)
      : Number.MAX_SAFE_INTEGER;
    const rightRound = Number.isFinite(Number(right?.roundBlock))
      ? Number(right.roundBlock)
      : Number.MAX_SAFE_INTEGER;
    if (leftRound !== rightRound) {
      return leftRound - rightRound;
    }

    const byCourt = String(left?.courtCode || '').localeCompare(String(right?.courtCode || ''));
    if (byCourt !== 0) {
      return byCourt;
    }

    return String(left?.slotId || '').localeCompare(String(right?.slotId || ''));
  });
}

const SCHEDULE_PLAN_MATCH_SELECT = [
  'phase',
  'stageKey',
  'plannedSlotId',
  'poolId',
  'bracket',
  'bracketRound',
  'roundBlock',
  'facility',
  'court',
  'facilityId',
  'courtId',
  'teamAId',
  'teamBId',
  'refTeamIds',
  'byeTeamId',
  'status',
  'startedAt',
  'endedAt',
  'result',
  'scoreboardId',
  'createdAt',
].join(' ');

function splitCommaQueryValues(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => splitCommaQueryValues(entry))
      .filter(Boolean);
  }

  if (!isNonEmptyString(value)) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeSchedulePlanStageKeysFilter(value) {
  return uniqueValues(splitCommaQueryValues(value));
}

function normalizeSchedulePlanKindsFilter(value) {
  return uniqueValues(
    splitCommaQueryValues(value)
      .map((entry) => normalizeSchedulePlanSlotKind(entry))
      .filter((entry) => entry === 'match' || entry === 'lunch')
  );
}

function shouldIncludeSchedulePlanSlot(slot, stageKeysFilter = [], kindsFilter = []) {
  const stageKeySet = new Set(Array.isArray(stageKeysFilter) ? stageKeysFilter : []);
  const kindSet = new Set(Array.isArray(kindsFilter) ? kindsFilter : []);
  const normalizedStageKey = isNonEmptyString(slot?.stageKey) ? slot.stageKey.trim() : '';
  const normalizedKind = normalizeSchedulePlanSlotKind(slot?.kind);

  if (stageKeySet.size > 0 && !stageKeySet.has(normalizedStageKey)) {
    return false;
  }

  if (kindSet.size > 0 && !kindSet.has(normalizedKind)) {
    return false;
  }

  return true;
}

function buildLegacySchedulePlanSlotFromMatch(match, index, tournament) {
  const roundBlock = Number(match?.roundBlock);
  const normalizedRoundBlock =
    Number.isFinite(roundBlock) && roundBlock > 0
      ? Math.floor(roundBlock)
      : null;
  const normalizedStageKey = isNonEmptyString(match?.stageKey)
    ? match.stageKey.trim()
    : isNonEmptyString(match?.phase)
      ? match.phase.trim()
      : 'match';
  const fallbackSlotId = isNonEmptyString(match?.plannedSlotId)
    ? match.plannedSlotId.trim()
    : `legacy:${toIdString(match?._id) || index}`;

  return {
    slotId: fallbackSlotId,
    stageKey: normalizedStageKey,
    roundBlock: normalizedRoundBlock,
    timeIndex:
      normalizedRoundBlock !== null
        ? resolveSchedulePlanRoundBlockStartMinutes(normalizedRoundBlock, tournament)
        : null,
    courtId:
      (isNonEmptyString(match?.courtId) ? match.courtId.trim() : '')
      || (isNonEmptyString(match?.court) ? match.court.trim() : '')
      || null,
    facilityId:
      (isNonEmptyString(match?.facilityId) ? match.facilityId.trim() : '')
      || (isNonEmptyString(match?.facility) ? match.facility.trim() : '')
      || null,
    kind: 'match',
    participants: [],
    ref: null,
    byeRefs: [],
    matchId: match?._id || null,
  };
}

async function loadSchedulePlanSlotViews({
  tournament,
  formatContext,
  phaseLabels = PHASE_LABELS,
  stageDefinitions = new Map(),
  stageLabels = new Map(),
  stageKeysFilter = [],
  kindsFilter = [],
  includeLegacyFallback = true,
  io = null,
} = {}) {
  const normalizedStageKeys = normalizeSchedulePlanStageKeysFilter(stageKeysFilter);
  const normalizedKinds = normalizeSchedulePlanKindsFilter(kindsFilter);
  const tournamentForTimeLabels = {
    timezone: tournament?.timezone,
    settings: {
      schedule: normalizeTournamentSchedule(tournament?.settings?.schedule),
      venue: formatContext?.venue,
    },
  };

  let schedulePlanSlots = Array.isArray(tournament?.settings?.schedulePlan?.slots)
    ? tournament.settings.schedulePlan.slots
    : [];
  if (schedulePlanSlots.length === 0) {
    const synced = await syncSchedulePlan({
      tournamentId: tournament?._id,
      actorUserId: null,
      io,
      emitEvents: false,
    });
    schedulePlanSlots = Array.isArray(synced?.slots) ? synced.slots : [];
  }

  const filteredSchedulePlanSlots = schedulePlanSlots.filter((slot) =>
    shouldIncludeSchedulePlanSlot(slot, normalizedStageKeys, normalizedKinds)
  );

  const scheduleSlotIds = uniqueValues(
    filteredSchedulePlanSlots
      .map((slot) => (isNonEmptyString(slot?.slotId) ? slot.slotId.trim() : ''))
      .filter(Boolean)
  );
  const scheduleSlotMatchIds = uniqueValues(
    filteredSchedulePlanSlots.map((slot) => toIdString(slot?.matchId)).filter(Boolean)
  );
  const scheduleMatchFilters = [];
  if (scheduleSlotMatchIds.length > 0) {
    scheduleMatchFilters.push({ _id: { $in: scheduleSlotMatchIds } });
  }
  if (scheduleSlotIds.length > 0) {
    scheduleMatchFilters.push({ plannedSlotId: { $in: scheduleSlotIds } });
  }

  const scheduleMatches = scheduleMatchFilters.length > 0
    ? await Match.find({
        tournamentId: tournament._id,
        $or: scheduleMatchFilters,
      })
        .select(SCHEDULE_PLAN_MATCH_SELECT)
        .populate('poolId', 'name')
        .populate('teamAId', 'name shortName logoUrl')
        .populate('teamBId', 'name shortName logoUrl')
        .populate('refTeamIds', 'name shortName logoUrl')
        .populate('byeTeamId', 'name shortName logoUrl')
        .populate('scoreboardId', 'code teams.score sets')
        .lean()
    : [];
  const scheduleMatchByPlannedSlotId = new Map(
    scheduleMatches
      .map((match) => [
        isNonEmptyString(match?.plannedSlotId) ? match.plannedSlotId.trim() : '',
        match,
      ])
      .filter(([plannedSlotId]) => Boolean(plannedSlotId))
  );
  const scheduleMatchById = new Map(
    scheduleMatches
      .map((match) => [toIdString(match?._id), match])
      .filter(([matchId]) => Boolean(matchId))
  );
  const hydratedSchedulePlanSlots = filteredSchedulePlanSlots.map((slot) => {
    if (toIdString(slot?.matchId)) {
      return slot;
    }

    const slotId = isNonEmptyString(slot?.slotId) ? slot.slotId.trim() : '';
    if (!slotId || !scheduleMatchByPlannedSlotId.has(slotId)) {
      return slot;
    }

    return {
      ...slot,
      matchId: scheduleMatchByPlannedSlotId.get(slotId)?._id || null,
    };
  });

  const scheduleTeamIds = uniqueValues(
    [
      ...hydratedSchedulePlanSlots.flatMap((slot) => {
        const participantIds = (Array.isArray(slot?.participants) ? slot.participants : [])
          .map((entry) => (entry?.type === 'teamId' ? toIdString(entry.teamId) : ''))
          .filter(Boolean);
        const refId = slot?.ref?.type === 'teamId' ? toIdString(slot.ref.teamId) : '';
        const byeIds = (Array.isArray(slot?.byeRefs) ? slot.byeRefs : [])
          .map((entry) => (entry?.type === 'teamId' ? toIdString(entry.teamId) : ''))
          .filter(Boolean);
        return [...participantIds, refId, ...byeIds].filter(Boolean);
      }),
      ...scheduleMatches.flatMap((match) => [
        toIdString(match?.teamAId?._id || match?.teamAId),
        toIdString(match?.teamBId?._id || match?.teamBId),
        ...(Array.isArray(match?.refTeamIds)
          ? match.refTeamIds.map((refTeam) => toIdString(refTeam?._id || refTeam))
          : []),
        toIdString(match?.byeTeamId?._id || match?.byeTeamId),
      ]),
    ].filter(Boolean)
  );
  const scheduleTeams = scheduleTeamIds.length > 0
    ? await TournamentTeam.find({
        _id: { $in: scheduleTeamIds },
        tournamentId: tournament._id,
      })
        .select('name shortName logoUrl')
        .lean()
    : [];
  const scheduleTeamsById = new Map(
    scheduleTeams.map((scheduleTeam) => [toIdString(scheduleTeam?._id), scheduleTeam])
  );

  let scheduleSlotViews = sortSchedulePlanSlotsByTime(
    hydratedSchedulePlanSlots.map((slot) =>
      serializeSchedulePlanSlotView({
        slot,
        tournament: tournamentForTimeLabels,
        formatDef: formatContext?.formatDef,
        phaseLabels,
        stageDefinitions,
        stageLabels,
        teamsById: scheduleTeamsById,
        matchById: scheduleMatchById,
      })
    )
  );

  const shouldReturnMatchFallback =
    includeLegacyFallback
    && scheduleSlotViews.length === 0
    && (normalizedKinds.length === 0 || normalizedKinds.includes('match'));
  if (shouldReturnMatchFallback) {
    const legacyMatchQuery = { tournamentId: tournament._id };
    if (normalizedStageKeys.length > 0) {
      legacyMatchQuery.$or = [
        { stageKey: { $in: normalizedStageKeys } },
        { phase: { $in: normalizedStageKeys } },
      ];
    }

    const legacyMatches = await Match.find(legacyMatchQuery)
      .select(SCHEDULE_PLAN_MATCH_SELECT)
      .populate('poolId', 'name')
      .populate('teamAId', 'name shortName logoUrl')
      .populate('teamBId', 'name shortName logoUrl')
      .populate('refTeamIds', 'name shortName logoUrl')
      .populate('byeTeamId', 'name shortName logoUrl')
      .populate('scoreboardId', 'code teams.score sets')
      .lean();
    const fallbackMatchById = new Map(
      legacyMatches
        .map((match) => [toIdString(match?._id), match])
        .filter(([matchId]) => Boolean(matchId))
    );
    const fallbackTeamsById = new Map();
    legacyMatches.forEach((match) => {
      const teamAId = toIdString(match?.teamAId?._id || match?.teamAId);
      const teamBId = toIdString(match?.teamBId?._id || match?.teamBId);
      if (teamAId && match?.teamAId && typeof match.teamAId === 'object') {
        fallbackTeamsById.set(teamAId, match.teamAId);
      }
      if (teamBId && match?.teamBId && typeof match.teamBId === 'object') {
        fallbackTeamsById.set(teamBId, match.teamBId);
      }

      (Array.isArray(match?.refTeamIds) ? match.refTeamIds : []).forEach((refTeam) => {
        const refTeamId = toIdString(refTeam?._id || refTeam);
        if (refTeamId && refTeam && typeof refTeam === 'object') {
          fallbackTeamsById.set(refTeamId, refTeam);
        }
      });

      const byeTeamId = toIdString(match?.byeTeamId?._id || match?.byeTeamId);
      if (byeTeamId && match?.byeTeamId && typeof match.byeTeamId === 'object') {
        fallbackTeamsById.set(byeTeamId, match.byeTeamId);
      }
    });

    scheduleSlotViews = sortSchedulePlanSlotsByTime(
      legacyMatches.map((match, index) =>
        serializeSchedulePlanSlotView({
          slot: buildLegacySchedulePlanSlotFromMatch(match, index, tournamentForTimeLabels),
          tournament: tournamentForTimeLabels,
          formatDef: formatContext?.formatDef,
          phaseLabels,
          stageDefinitions,
          stageLabels,
          teamsById: fallbackTeamsById,
          matchById: fallbackMatchById,
        })
      )
    );
  }

  return {
    slots: scheduleSlotViews,
    stageKeys: normalizedStageKeys,
    kinds: normalizedKinds,
  };
}

function serializeLegacyCourtScheduleMatch(slotView) {
  return {
    matchId: slotView?.matchId || null,
    phase: slotView?.phase || null,
    phaseLabel: slotView?.phaseLabel || slotView?.stageLabel || '',
    roundBlock: slotView?.roundBlock ?? null,
    poolName: slotView?.poolName ?? null,
    status: slotView?.status === 'scheduled_tbd' ? 'scheduled' : slotView?.status || 'scheduled',
    teamA: slotView?.participants?.[0]?.label || 'TBD',
    teamB: slotView?.participants?.[1]?.label || 'TBD',
    refs: slotView?.refLabel && slotView.refLabel !== 'TBD' ? [slotView.refLabel] : [],
    score: slotView?.scoreSummary || null,
    stageKey: slotView?.stageKey || null,
  };
}

const TEAM_TIMELINE_ROLE_META = Object.freeze({
  PLAY: {
    roleLabel: 'PLAY',
    iconKey: 'play',
  },
  REF: {
    roleLabel: 'REF',
    iconKey: 'ref',
  },
  BYE: {
    roleLabel: 'BYE',
    iconKey: 'bye',
  },
  LUNCH: {
    roleLabel: 'LUNCH',
    iconKey: 'lunch',
  },
});

const TEAM_TIMELINE_ROLE_PRIORITY = Object.freeze({
  PLAY: 0,
  REF: 1,
  BYE: 2,
  LUNCH: 3,
});

function createTeamTimelineEntry({ slotView, role, focusTeamId, index = 0 } = {}) {
  const roleMeta = TEAM_TIMELINE_ROLE_META[role] || TEAM_TIMELINE_ROLE_META.PLAY;
  const slotId = isNonEmptyString(slotView?.slotId) ? slotView.slotId.trim() : '';
  const normalizedRole = String(role || '').trim().toUpperCase();
  const isLunch = normalizedRole === 'LUNCH';
  const suppressRef = isLunch || normalizedRole === 'BYE';
  const participants = Array.isArray(slotView?.participants) ? slotView.participants : [];
  const teamA = slotView?.teamA || participants?.[0]?.team || null;
  const teamB = slotView?.teamB || participants?.[1]?.team || null;
  const teamAId = toIdString(teamA?.teamId || participants?.[0]?.teamId);
  const teamBId = toIdString(teamB?.teamId || participants?.[1]?.teamId);
  const normalizedFocusTeamId = toIdString(focusTeamId);
  const opponent =
    normalizedRole === 'PLAY'
      ? teamAId === normalizedFocusTeamId
        ? teamB
        : teamA
      : null;
  const scoreSummary = slotView?.scoreSummary || null;
  const completedSetScores = Array.isArray(slotView?.completedSetScores)
    ? slotView.completedSetScores
    : [];
  const setsA = Number(slotView?.setSummary?.setsA ?? scoreSummary?.setsA);
  const setsB = Number(slotView?.setSummary?.setsB ?? scoreSummary?.setsB);
  const setSummary =
    Number.isFinite(setsA) && Number.isFinite(setsB)
      ? {
          setsA: safeNonNegativeNumber(setsA),
          setsB: safeNonNegativeNumber(setsB),
          setScores: completedSetScores,
        }
      : null;

  let summaryLabel = slotView?.matchupLabel || '';
  if (normalizedRole === 'PLAY') {
    summaryLabel = `vs ${opponent?.shortName || 'TBD'}`;
  } else if (normalizedRole === 'REF') {
    summaryLabel = slotView?.matchupLabel || 'TBD vs TBD';
  } else if (normalizedRole === 'BYE') {
    summaryLabel = slotView?.poolName ? `BYE (Pool ${slotView.poolName})` : 'BYE';
  } else if (normalizedRole === 'LUNCH') {
    const lunchDurationMinutes =
      toPositiveInteger(slotView?.lunchDurationMinutes)
      || TOURNAMENT_SCHEDULE_DEFAULTS.lunchDurationMinutes;
    summaryLabel = `Lunch Break (${lunchDurationMinutes} min)`;
  }

  return {
    timelineId: `${normalizedRole || 'ROW'}:${slotId || toIdString(slotView?.matchId) || index}`,
    role: normalizedRole || 'PLAY',
    roleLabel: roleMeta.roleLabel,
    iconKey: roleMeta.iconKey,
    summaryLabel,
    stageKey: slotView?.stageKey || null,
    stageLabel: slotView?.stageLabel || null,
    phase: slotView?.phase || null,
    phaseLabel: slotView?.phaseLabel || slotView?.stageLabel || null,
    roundBlock: slotView?.roundBlock ?? null,
    timeIndex: Number.isFinite(Number(slotView?.timeIndex)) ? Number(slotView.timeIndex) : null,
    timeLabel: slotView?.timeLabel || '',
    status: isLunch ? 'scheduled' : slotView?.status || 'scheduled',
    slotId: slotId || null,
    matchId: toIdString(slotView?.matchId) || null,
    plannedSlotId: isNonEmptyString(slotView?.plannedSlotId)
      ? slotView.plannedSlotId.trim()
      : slotId || null,
    scoreboardCode: slotView?.scoreboardCode || null,
    startedAt: slotView?.startedAt ?? null,
    endedAt: slotView?.endedAt ?? null,
    poolName: slotView?.poolName || null,
    bracket: slotView?.bracket ?? null,
    roundLabel: slotView?.roundLabel ?? null,
    courtCode: slotView?.courtCode || null,
    courtLabel: slotView?.courtLabel || null,
    facility: slotView?.facility || null,
    facilityLabel: slotView?.facilityLabel || null,
    matchupLabel: slotView?.matchupLabel || null,
    matchupReferenceLabel: slotView?.matchupReferenceLabel || null,
    participants: isLunch ? [] : participants,
    teamA: isLunch ? null : teamA,
    teamB: isLunch ? null : teamB,
    opponent: isLunch ? null : (opponent || null),
    ref: suppressRef ? null : (slotView?.ref || null),
    refLabel: suppressRef ? null : (slotView?.refLabel || null),
    refReferenceLabel: suppressRef ? null : (slotView?.refReferenceLabel || null),
    byeParticipants: isLunch ? [] : (Array.isArray(slotView?.byeParticipants) ? slotView.byeParticipants : []),
    byeLabel: slotView?.byeLabel || null,
    scoreSummary,
    completedSetScores,
    setSummary,
    isResolved: slotView?.status !== 'scheduled_tbd',
  };
}

function sortTeamTimelineEntries(entries) {
  return [...(Array.isArray(entries) ? entries : [])].sort((left, right) => {
    const leftTime = Number.isFinite(Number(left?.timeIndex))
      ? Number(left.timeIndex)
      : Number.isFinite(Number(left?.roundBlock))
        ? Number(left.roundBlock) * 100
        : Number.MAX_SAFE_INTEGER;
    const rightTime = Number.isFinite(Number(right?.timeIndex))
      ? Number(right.timeIndex)
      : Number.isFinite(Number(right?.roundBlock))
        ? Number(right.roundBlock) * 100
        : Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    const leftRound = Number.isFinite(Number(left?.roundBlock))
      ? Number(left.roundBlock)
      : Number.MAX_SAFE_INTEGER;
    const rightRound = Number.isFinite(Number(right?.roundBlock))
      ? Number(right.roundBlock)
      : Number.MAX_SAFE_INTEGER;
    if (leftRound !== rightRound) {
      return leftRound - rightRound;
    }

    const leftRoleRank = TEAM_TIMELINE_ROLE_PRIORITY[left?.role] ?? Number.MAX_SAFE_INTEGER;
    const rightRoleRank = TEAM_TIMELINE_ROLE_PRIORITY[right?.role] ?? Number.MAX_SAFE_INTEGER;
    if (leftRoleRank !== rightRoleRank) {
      return leftRoleRank - rightRoleRank;
    }

    return String(left?.timelineId || '').localeCompare(String(right?.timelineId || ''));
  });
}

function sanitizePlayoffMatchForPublic(match) {
  return {
    _id: match?._id ?? null,
    phase: match?.phase ?? null,
    bracket: match?.bracket ?? null,
    bracketRound: match?.bracketRound ?? null,
    bracketMatchKey: match?.bracketMatchKey ?? null,
    seedA: match?.seedA ?? null,
    seedB: match?.seedB ?? null,
    teamAFromMatchId: match?.teamAFromMatchId ?? null,
    teamAFromSlot: match?.teamAFromSlot ?? null,
    teamBFromMatchId: match?.teamBFromMatchId ?? null,
    teamBFromSlot: match?.teamBFromSlot ?? null,
    roundBlock: match?.roundBlock ?? null,
    facility: match?.facility ?? null,
    court: match?.court ?? null,
    teamAId: match?.teamAId ?? null,
    teamBId: match?.teamBId ?? null,
    teamA: match?.teamA ?? null,
    teamB: match?.teamB ?? null,
    refTeamIds: Array.isArray(match?.refTeamIds) ? match.refTeamIds : [],
    refTeams: Array.isArray(match?.refTeams) ? match.refTeams : [],
    scoreboardCode: match?.scoreboardCode ?? null,
    status: match?.status ?? null,
    result: match?.result ?? null,
    finalizedAt: match?.finalizedAt ?? null,
  };
}

async function deleteMatchesAndLinkedScoreboards(matchQuery) {
  const existingMatches = await Match.find(matchQuery).select('_id scoreboardId').lean();

  if (existingMatches.length === 0) {
    return {
      deletedMatchIds: [],
      deletedScoreboardIds: [],
    };
  }

  const matchIds = existingMatches.map((match) => match._id);
  const scoreboardIds = uniqueValues(
    existingMatches
      .map((match) => toIdString(match.scoreboardId))
      .filter(Boolean)
  );

  await Match.deleteMany({ _id: { $in: matchIds } });

  if (scoreboardIds.length > 0) {
    await Scoreboard.deleteMany({
      _id: { $in: scoreboardIds },
    });
  }

  return {
    deletedMatchIds: matchIds.map((matchId) => toIdString(matchId)),
    deletedScoreboardIds: scoreboardIds,
  };
}

function buildMatchQueryForStage(tournamentId, formatDef, stageDef) {
  if (formatDef?.id === DEFAULT_15_TEAM_FORMAT_ID) {
    return {
      tournamentId,
      phase: resolvePoolPhase(formatDef, stageDef?.key, stageDef),
    };
  }

  return {
    tournamentId,
    stageKey: stageDef?.key,
  };
}

async function generatePoolPlayStageMatches({
  req,
  tournamentId,
  userId,
  tournament,
  formatDef,
  stageDef,
  activeCourts,
}) {
  const phase = resolvePoolPhase(formatDef, stageDef?.key, stageDef);
  const stagePoolDefinitions = Array.isArray(stageDef?.pools) ? stageDef.pools : [];
  const poolNames = stagePoolDefinitions.map((poolDef) => poolDef.name);
  const venueState = resolveTournamentVenueState(tournament);
  const enabledVenueCourts = getEnabledCourts(venueState.venue);

  if (enabledVenueCourts.length === 0) {
    throw new Error('Venue must include at least one enabled court before generating matches.');
  }

  const pools = await Pool.find({
    tournamentId,
    phase,
    name: { $in: poolNames },
    $or: [{ stageKey: stageDef.key }, { stageKey: null }, { stageKey: { $exists: false } }],
  })
    .select(
      '_id name stageKey requiredTeamCount teamIds homeCourt assignedCourtId assignedFacilityId'
    )
    .lean();
  const poolsByName = new Map(pools.map((pool) => [pool.name, pool]));
  const stagePools = stagePoolDefinitions.map((poolDef) => poolsByName.get(poolDef.name));
  const missingPools = stagePools
    .map((pool, index) => (pool ? null : stagePoolDefinitions[index]?.name))
    .filter(Boolean);

  if (missingPools.length > 0) {
    throw new Error(
      `${stageDef.displayName || stageDef.key} pools are missing: ${missingPools.join(', ')}`
    );
  }

  const duplicateCheck = [];
  const assignedCourtIds = [];
  const poolCourtBackfills = [];
  stagePools.forEach((pool, index) => {
    const requiredTeamCount =
      Number.isFinite(Number(pool?.requiredTeamCount)) && Number(pool.requiredTeamCount) > 0
        ? Number(pool.requiredTeamCount)
        : Number(stagePoolDefinitions[index]?.size || 0);

    if (!Array.isArray(pool?.teamIds) || pool.teamIds.length !== requiredTeamCount) {
      throw new Error(`Pool ${pool?.name || '?'} must have exactly ${requiredTeamCount} teams`);
    }

    const resolvedVenueCourt = findCourtInVenue(
      venueState.venue,
      pool?.assignedCourtId || pool?.homeCourt
    );

    if (!resolvedVenueCourt) {
      throw new Error(
        `Pool ${pool?.name || '?'} must be assigned to a venue court before generating matches`
      );
    }

    if (resolvedVenueCourt.isEnabled === false) {
      throw new Error(`Pool ${pool?.name || '?'} is assigned to a disabled court`);
    }

    pool.__resolvedVenueCourt = resolvedVenueCourt;
    assignedCourtIds.push(resolvedVenueCourt.courtId);

    if (
      pool.assignedCourtId !== resolvedVenueCourt.courtId
      || pool.assignedFacilityId !== resolvedVenueCourt.facilityId
      || pool.homeCourt !== resolvedVenueCourt.courtName
    ) {
      poolCourtBackfills.push({
        poolId: pool._id,
        assignedCourtId: resolvedVenueCourt.courtId,
        assignedFacilityId: resolvedVenueCourt.facilityId || null,
        homeCourt: resolvedVenueCourt.courtName || null,
      });
    }

    pool.teamIds.forEach((teamId) => duplicateCheck.push(toIdString(teamId)));
  });

  if (new Set(duplicateCheck).size !== duplicateCheck.length) {
    throw new Error(`Each ${stageDef.displayName || stageDef.key} team must appear in one pool only`);
  }

  if (stagePools.length > enabledVenueCourts.length) {
    throw new Error(
      `${stageDef.displayName || stageDef.key} has ${stagePools.length} pools but only ${enabledVenueCourts.length} courts are enabled. Wave scheduling is not supported yet.`
    );
  }

  const courtCounts = assignedCourtIds.reduce((lookup, courtId) => {
    lookup.set(courtId, (lookup.get(courtId) || 0) + 1);
    return lookup;
  }, new Map());
  const conflictingCourtIds = Array.from(courtCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([courtId]) => courtId);
  if (conflictingCourtIds.length > 0) {
    const conflictLabels = conflictingCourtIds
      .map((courtId) => findCourtInVenue(venueState.venue, courtId)?.courtName || courtId)
      .join(', ');
    throw new Error(
      `Pools share the same court (${conflictLabels}). Assign unique courts before generating matches.`
    );
  }

  if (poolCourtBackfills.length > 0) {
    await Pool.bulkWrite(
      poolCourtBackfills.map((entry) => ({
        updateOne: {
          filter: { _id: entry.poolId },
          update: {
            $set: {
              assignedCourtId: entry.assignedCourtId,
              assignedFacilityId: entry.assignedFacilityId,
              homeCourt: entry.homeCourt,
            },
          },
        },
      })),
      { ordered: true }
    );
  }

  const teamIds = uniqueValues(duplicateCheck);
  const teams = await TournamentTeam.find({
    _id: { $in: teamIds },
    tournamentId,
  })
    .select('name shortName logoUrl seed orderIndex')
    .lean();
  const teamsById = new Map(teams.map((team) => [toIdString(team._id), team]));

  if (teamsById.size !== teamIds.length) {
    throw new Error(`${stageDef.displayName || stageDef.key} pools include unknown teams`);
  }

  const matchesByPool = stagePools.map((pool, index) => {
    const requiredTeamCount =
      Number.isFinite(Number(pool?.requiredTeamCount)) && Number(pool.requiredTeamCount) > 0
        ? Number(pool.requiredTeamCount)
        : Number(stagePoolDefinitions[index]?.size || 0);
    const poolTeams = pool.teamIds
      .map((teamId) => teamsById.get(toIdString(teamId)))
      .filter(Boolean);
    const roundRobinMatches = generateRoundRobinMatches(poolTeams, requiredTeamCount);

    return {
      poolId: pool._id,
      poolName: pool.name,
      assignedCourtId: pool?.__resolvedVenueCourt?.courtId || null,
      assignedFacilityId: pool?.__resolvedVenueCourt?.facilityId || null,
      courtName: pool?.__resolvedVenueCourt?.courtName || null,
      facilityName: pool?.__resolvedVenueCourt?.facilityName || null,
      matches: roundRobinMatches,
    };
  });

  const startRoundBlock = await resolveStageStartRoundBlock(tournamentId, formatDef, stageDef.key);
  const maxMatchCount = matchesByPool.reduce(
    (maxValue, pool) => Math.max(maxValue, pool.matches.length),
    0
  );
  const scheduledMatches = [];

  for (let matchIndex = 0; matchIndex < maxMatchCount; matchIndex += 1) {
    matchesByPool.forEach((pool) => {
      const match = pool.matches[matchIndex];
      if (!match) {
        return;
      }

      scheduledMatches.push({
        ...match,
        poolId: pool.poolId || null,
        poolName: pool.poolName || null,
        roundBlock: startRoundBlock + matchIndex,
        courtId: pool.assignedCourtId,
        facilityId: pool.assignedFacilityId,
        court: pool.courtName,
        facility: pool.facilityName,
      });
    });
  }

  const scoring = normalizeScoringConfig(tournament?.settings?.scoring);
  const createdMatchIds = [];
  const createdScoreboardIds = [];

  try {
    for (const scheduledMatch of scheduledMatches) {
      const teamA = teamsById.get(toIdString(scheduledMatch.teamAId));
      const teamB = teamsById.get(toIdString(scheduledMatch.teamBId));

      if (!teamA || !teamB) {
        throw new Error('Unable to resolve team details while generating matches');
      }

      const scoreboard = await createMatchScoreboard({
        ownerId: userId,
        title: `${stageDef.displayName || stageDef.key} Pool ${scheduledMatch.poolName}`,
        teamA,
        teamB,
        scoring,
      });
      const match = await Match.create({
        tournamentId,
        phase,
        stageKey: stageDef.key,
        poolId: scheduledMatch.poolId || null,
        roundBlock: scheduledMatch.roundBlock,
        facility: scheduledMatch.facility,
        court: scheduledMatch.court,
        facilityId: scheduledMatch.facilityId,
        courtId: scheduledMatch.courtId,
        teamAId: scheduledMatch.teamAId,
        teamBId: scheduledMatch.teamBId,
        refTeamIds: scheduledMatch.refTeamIds || [],
        byeTeamId: scheduledMatch.byeTeamId || null,
        scoreboardId: scoreboard._id,
        status: 'scheduled',
      });

      cacheTournamentMatchEntry({
        scoreboardId: scoreboard._id,
        matchId: match._id,
        tournamentCode: tournament.publicCode,
      });

      createdScoreboardIds.push(toIdString(scoreboard._id));
      createdMatchIds.push(toIdString(match._id));
    }
  } catch (error) {
    if (createdMatchIds.length > 0) {
      await Match.deleteMany({ _id: { $in: createdMatchIds } });
    }

    if (createdScoreboardIds.length > 0) {
      await Scoreboard.deleteMany({ _id: { $in: createdScoreboardIds } });
    }

    throw error;
  }

  await ensureTournamentStatusAtLeast(tournamentId, phase === 'phase2' ? 'phase2' : 'phase1');

  return loadMatchesForResponse({ _id: { $in: createdMatchIds } });
}

function getRoundRobinMatchCountForPoolSize(poolSize) {
  const parsed = Number(poolSize);
  if (!Number.isFinite(parsed) || parsed <= 1) {
    return 0;
  }

  return Math.floor((parsed * (parsed - 1)) / 2);
}

function isCrossoverPrerequisiteMatchFinalized(match) {
  const status = String(match?.status || '').trim().toLowerCase();
  return status === 'final' && Boolean(match?.result);
}

async function evaluateCrossoverGenerationReadiness({
  tournamentId,
  formatDef,
  stageDef,
}) {
  const sourcePoolNames = Array.isArray(stageDef?.fromPools)
    ? stageDef.fromPools.map((poolName) => String(poolName || '').trim()).filter(Boolean)
    : [];
  if (sourcePoolNames.length !== 2) {
    return {
      ready: false,
      message: 'Crossover stage requires exactly two source pools',
    };
  }

  const stageOrder = Array.isArray(formatDef?.stages) ? formatDef.stages : [];
  const stageIndex = stageOrder.findIndex((stage) => stage?.key === stageDef?.key);
  const previousPoolStage =
    stageIndex > 0
      ? [...stageOrder.slice(0, stageIndex)].reverse().find((stage) => stage?.type === 'poolPlay')
      : null;
  if (!previousPoolStage) {
    return {
      ready: false,
      message: 'Crossover stage requires a prior pool-play stage',
    };
  }

  const previousPhase = resolvePoolPhase(formatDef, previousPoolStage.key, previousPoolStage);
  const sourcePools = await Pool.find({
    tournamentId,
    phase: previousPhase,
    name: { $in: sourcePoolNames },
    $or: [
      { stageKey: previousPoolStage.key },
      { stageKey: null },
      { stageKey: { $exists: false } },
    ],
  })
    .select('_id name')
    .lean();
  const sourcePoolByName = new Map(
    sourcePools
      .map((pool) => [String(pool?.name || '').trim(), pool])
      .filter(([poolName]) => Boolean(poolName))
  );
  const missingPools = sourcePoolNames.filter((poolName) => !sourcePoolByName.has(poolName));
  if (missingPools.length > 0) {
    return {
      ready: false,
      message: `Source pools are missing for crossover generation: ${missingPools.join(', ')}`,
    };
  }

  const sourcePoolIds = sourcePoolNames
    .map((poolName) => toIdString(sourcePoolByName.get(poolName)?._id))
    .filter(Boolean);
  const sourceMatches = await Match.find({
    tournamentId,
    poolId: { $in: sourcePoolIds },
  })
    .select('poolId status result')
    .lean();
  const sourceMatchesByPoolId = sourceMatches.reduce((lookup, match) => {
    const poolId = toIdString(match?.poolId);
    if (!poolId) {
      return lookup;
    }

    if (!lookup.has(poolId)) {
      lookup.set(poolId, []);
    }
    lookup.get(poolId).push(match);
    return lookup;
  }, new Map());
  const poolSizesByName = new Map(
    (Array.isArray(previousPoolStage?.pools) ? previousPoolStage.pools : [])
      .map((poolDef) => [String(poolDef?.name || '').trim(), Number(poolDef?.size || 0)])
      .filter(([poolName]) => Boolean(poolName))
  );

  for (const poolName of sourcePoolNames) {
    const pool = sourcePoolByName.get(poolName);
    const poolId = toIdString(pool?._id);
    const requiredPoolSize = Number(poolSizesByName.get(poolName) || 0);
    const requiredMatchCount = getRoundRobinMatchCountForPoolSize(requiredPoolSize);
    const poolMatches = sourceMatchesByPoolId.get(poolId) || [];

    if (requiredMatchCount <= 0 || poolMatches.length < requiredMatchCount) {
      return {
        ready: false,
        message: `Complete all source pool matches before generating crossover (${poolName}).`,
      };
    }

    if (!poolMatches.every((match) => isCrossoverPrerequisiteMatchFinalized(match))) {
      return {
        ready: false,
        message: `Finalize all source pool matches before generating crossover (${poolName}).`,
      };
    }
  }

  return { ready: true, message: '' };
}

async function generateCrossoverStageMatches({
  tournamentId,
  userId,
  tournament,
  formatDef,
  stageDef,
  activeCourts,
}) {
  const stageIndex = (formatDef.stages || []).findIndex((stage) => stage?.key === stageDef?.key);
  const previousStage = stageIndex > 0 ? formatDef.stages[stageIndex - 1] : null;
  const previousPhase = previousStage
    ? resolvePoolPhase(formatDef, previousStage.key, previousStage)
    : 'phase1';
  const standingsPhase = previousPhase === 'phase2' ? 'phase2' : 'phase1';
  const standings = await computeStandingsBundle(tournamentId, standingsPhase);
  const standingsByPool = new Map(
    (Array.isArray(standings?.pools) ? standings.pools : []).map((pool) => [pool.poolName, pool])
  );
  const fromPools = Array.isArray(stageDef?.fromPools) ? stageDef.fromPools : [];

  if (fromPools.length !== 2) {
    throw new Error('Crossover stage requires exactly two source pools');
  }

  const leftPool = standingsByPool.get(fromPools[0]);
  const rightPool = standingsByPool.get(fromPools[1]);

  if (!leftPool || !rightPool) {
    throw new Error('Unable to resolve crossover source pool standings');
  }

  const leftTeams = Array.isArray(leftPool.teams) ? leftPool.teams : [];
  const rightTeams = Array.isArray(rightPool.teams) ? rightPool.teams : [];
  const pairingCount = Math.min(leftTeams.length, rightTeams.length);

  if (pairingCount === 0) {
    throw new Error('No crossover pairings could be resolved from standings');
  }

  const teamIds = uniqueValues(
    [...leftTeams, ...rightTeams].map((entry) => toIdString(entry?.teamId)).filter(Boolean)
  );
  const teams = await TournamentTeam.find({
    _id: { $in: teamIds },
    tournamentId,
  })
    .select('name shortName logoUrl seed')
    .lean();
  const teamsById = new Map(teams.map((team) => [toIdString(team._id), team]));
  const venueState = resolveTournamentVenueState(tournament);
  const enabledVenueCourts = getEnabledCourts(venueState.venue);
  const normalizedActiveCourts = uniqueValues(activeCourts);

  if (normalizedActiveCourts.length === 0 && enabledVenueCourts.length === 0) {
    throw new Error('At least one active court is required for crossover scheduling');
  }

  const sourcePools = await Pool.find({
    tournamentId,
    phase: previousPhase,
    name: { $in: fromPools },
    ...(previousStage?.key
      ? { $or: [{ stageKey: previousStage.key }, { stageKey: null }, { stageKey: { $exists: false } }] }
      : {}),
  })
    .select('_id name requiredTeamCount homeCourt assignedCourtId assignedFacilityId')
    .lean();
  const startRoundBlock = await resolveCrossoverStartRoundBlock({
    tournamentId,
    formatDef,
    stageDef,
    previousStage,
    previousPhase,
    sourcePools,
  });
  const sourcePoolByName = new Map(
    sourcePools
      .map((pool) => [String(pool?.name || '').trim(), pool])
      .filter(([poolName]) => Boolean(poolName))
  );
  const sourcePoolCourts = fromPools
    .map((poolName) => sourcePoolByName.get(String(poolName || '').trim()))
    .map((pool) => findCourtInVenue(venueState.venue, pool?.assignedCourtId || pool?.homeCourt))
    .filter((court) => court && court.isEnabled !== false);
  const sourcePoolCourtIds = uniqueValues(
    sourcePoolCourts.map((court) => toIdString(court?.courtId)).filter(Boolean)
  );

  const activeVenueCourts = normalizedActiveCourts
    .map((courtKey) => findCourtInVenue(venueState.venue, courtKey))
    .filter((court) => court && court.isEnabled !== false);
  const activeVenueCourtIds = uniqueValues(
    activeVenueCourts.map((court) => toIdString(court?.courtId)).filter(Boolean)
  );
  const enabledVenueCourtIds = uniqueValues(
    enabledVenueCourts.map((court) => toIdString(court?.courtId)).filter(Boolean)
  );
  const courtsForCrossover = sourcePoolCourtIds.length > 0
    ? sourcePoolCourtIds
    : activeVenueCourtIds.length > 0
      ? activeVenueCourtIds
      : enabledVenueCourtIds;

  if (courtsForCrossover.length === 0) {
    throw new Error('At least one enabled court is required for crossover scheduling');
  }

  // Crossover ref template (0-based match index):
  //   Match 0: X#1 vs Y#1, ref = X#3  (leftTeams[2])
  //   Match 1: X#2 vs Y#2, ref = Y#3  (rightTeams[2])
  //   Match 2: X#3 vs Y#3, ref = Y#2  (rightTeams[1])
  // This avoids a concurrent conflict where X#2 would otherwise ref Match 0
  // while playing Match 1 when two crossover courts are available.
  const getCrossoverRefTeamId = (matchIndex) => {
    if (pairingCount >= 3) {
      if (matchIndex === 0) return toIdString(leftTeams[2]?.teamId) || null;
      if (matchIndex === 1) return toIdString(rightTeams[2]?.teamId) || null;
      if (matchIndex === 2) return toIdString(rightTeams[1]?.teamId) || null;
      return null;
    }

    if (matchIndex === 0) return toIdString(leftTeams[1]?.teamId) || null;
    if (matchIndex === 1) return toIdString(rightTeams[1]?.teamId) || null;
    return null;
  };

  // Concurrent scheduling: if >= 2 courts, matches 0 and 1 share the same round block;
  // match 2 is the next block.  With only 1 court, all three are sequential.
  const getCrossoverRoundBlock = (matchIndex) => {
    if (courtsForCrossover.length >= 2) {
      return matchIndex <= 1 ? startRoundBlock : startRoundBlock + 1;
    }
    return startRoundBlock + matchIndex;
  };

  const getCrossoverCourt = (matchIndex) => {
    if (courtsForCrossover.length >= 2) {
      return courtsForCrossover[matchIndex <= 1 ? matchIndex : 0];
    }
    return courtsForCrossover[0];
  };

  const scoring = normalizeScoringConfig(tournament?.settings?.scoring);
  const createdMatchIds = [];
  const createdScoreboardIds = [];
  const phase = resolvePoolPhase(formatDef, stageDef.key, stageDef);

  try {
    for (let index = 0; index < pairingCount; index += 1) {
      const leftTeamId = toIdString(leftTeams[index]?.teamId);
      const rightTeamId = toIdString(rightTeams[index]?.teamId);
      const teamA = teamsById.get(leftTeamId);
      const teamB = teamsById.get(rightTeamId);

      if (!teamA || !teamB) {
        throw new Error('Crossover teams are missing from tournament roster');
      }

      const requestedCourt = getCrossoverCourt(index);
      const resolvedVenueCourt = findCourtInVenue(venueState.venue, requestedCourt);
      const court = resolvedVenueCourt?.courtName || requestedCourt;
      const facilityFromCourtCode = getFacilityFromCourt(court);
      const facility =
        facilityFromCourtCode
        || resolvedVenueCourt?.facilityName
        || getFacilityFromCourt(requestedCourt)
        || null;
      const roundBlock = getCrossoverRoundBlock(index);
      const refTeamId = getCrossoverRefTeamId(index);
      const refTeamIds = refTeamId ? [refTeamId] : [];
      const scoreboard = await createMatchScoreboard({
        ownerId: userId,
        title: `${stageDef.displayName || stageDef.key} #${index + 1}`,
        teamA,
        teamB,
        scoring,
      });
      const match = await Match.create({
        tournamentId,
        phase,
        stageKey: stageDef.key,
        poolId: null,
        roundBlock,
        facility,
        court,
        facilityId: resolvedVenueCourt?.facilityId || null,
        courtId: resolvedVenueCourt?.courtId || null,
        teamAId: leftTeamId,
        teamBId: rightTeamId,
        refTeamIds,
        scoreboardId: scoreboard._id,
        status: 'scheduled',
      });

      cacheTournamentMatchEntry({
        scoreboardId: scoreboard._id,
        matchId: match._id,
        tournamentCode: tournament.publicCode,
      });

      createdScoreboardIds.push(toIdString(scoreboard._id));
      createdMatchIds.push(toIdString(match._id));
    }
  } catch (error) {
    if (createdMatchIds.length > 0) {
      await Match.deleteMany({ _id: { $in: createdMatchIds } });
    }

    if (createdScoreboardIds.length > 0) {
      await Scoreboard.deleteMany({ _id: { $in: createdScoreboardIds } });
    }

    throw error;
  }

  await ensureTournamentStatusAtLeast(tournamentId, phase === 'phase2' ? 'phase2' : 'phase1');

  return loadMatchesForResponse({ _id: { $in: createdMatchIds } });
}

async function generateGenericPlayoffStageMatches({
  tournamentId,
  userId,
  tournament,
  formatDef,
  stageDef,
  activeCourts,
}) {
  const standings = await computeStandingsBundle(tournamentId, 'cumulative');
  const overallSeeds = (Array.isArray(standings?.overall) ? standings.overall : [])
    .slice()
    .sort((left, right) => (left?.rank ?? Number.MAX_SAFE_INTEGER) - (right?.rank ?? Number.MAX_SAFE_INTEGER))
    .map((entry) => toIdString(entry.teamId))
    .filter(Boolean);
  const brackets = Array.isArray(stageDef?.brackets) ? stageDef.brackets : [];

  if (brackets.length === 0) {
    throw new Error('Playoff stage does not define any brackets');
  }

  const allPlannedMatches = brackets.flatMap((bracketDef) =>
    generatePlayoffsFromFormat(tournamentId, bracketDef, overallSeeds)
  );
  const startRoundBlock = await resolveStageStartRoundBlock(tournamentId, formatDef, stageDef.key);
  const maxConcurrentCourts =
    toPositiveInteger(stageDef?.maxConcurrentCourts) ||
    toPositiveInteger(stageDef?.constraints?.maxConcurrentCourts);
  const scheduledMatches = schedulePlayoffMatches(allPlannedMatches, activeCourts, startRoundBlock, {
    maxConcurrentCourts,
  });
  const initialTeamIds = uniqueValues(
    scheduledMatches
      .flatMap((match) => [toIdString(match.teamAId), toIdString(match.teamBId)])
      .filter(Boolean)
  );
  const teams = await TournamentTeam.find({
    _id: { $in: initialTeamIds },
    tournamentId,
  })
    .select('name shortName logoUrl seed')
    .lean();
  const teamsById = new Map(teams.map((team) => [toIdString(team._id), team]));
  const scoring = normalizeScoringConfig(tournament?.settings?.scoring);
  const createdMatchIds = [];
  const createdScoreboardIds = [];
  const createdMatchByKey = new Map();
  const phase = resolvePoolPhase(formatDef, stageDef.key, stageDef);
  const roundLabel = (round) => {
    const numericRound = Number(round);
    return Number.isFinite(numericRound) && numericRound > 0 ? `Round ${numericRound}` : 'Round';
  };

  try {
    for (const plannedMatch of scheduledMatches) {
      const teamA = teamsById.get(toIdString(plannedMatch.teamAId));
      const teamB = teamsById.get(toIdString(plannedMatch.teamBId));
      const teamAFromMatch = plannedMatch.teamAFromMatchKey
        ? createdMatchByKey.get(plannedMatch.teamAFromMatchKey)
        : null;
      const teamBFromMatch = plannedMatch.teamBFromMatchKey
        ? createdMatchByKey.get(plannedMatch.teamBFromMatchKey)
        : null;

      const scoreboard = await createScoreboard({
        ownerId: userId,
        title: `${plannedMatch.bracket} ${roundLabel(plannedMatch.round)}`,
        teams: [
          { name: teamA?.shortName || teamA?.name || 'TBD' },
          { name: teamB?.shortName || teamB?.name || 'TBD' },
        ],
        servingTeamIndex: null,
        temporary: false,
        scoring,
      });
      const match = await Match.create({
        tournamentId,
        phase,
        stageKey: stageDef.key,
        poolId: null,
        bracket: plannedMatch.bracket,
        bracketRound: plannedMatch.bracketRound,
        bracketMatchKey: plannedMatch.bracketMatchKey,
        seedA: plannedMatch.seedA ?? null,
        seedB: plannedMatch.seedB ?? null,
        teamAId: plannedMatch.teamAId || null,
        teamBId: plannedMatch.teamBId || null,
        teamAFromMatchId: teamAFromMatch?._id || null,
        teamAFromSlot: plannedMatch.teamAFromSlot || null,
        teamBFromMatchId: teamBFromMatch?._id || null,
        teamBFromSlot: plannedMatch.teamBFromSlot || null,
        refTeamIds: [],
        roundBlock: plannedMatch.roundBlock,
        facility: plannedMatch.facility,
        court: plannedMatch.court,
        plannedSlotId: isNonEmptyString(plannedMatch?.bracketMatchKey)
          ? `playoffs:${plannedMatch.bracketMatchKey.trim()}`
          : null,
        scoreboardId: scoreboard._id,
        status: 'scheduled',
      });

      cacheTournamentMatchEntry({
        scoreboardId: scoreboard._id,
        matchId: match._id,
        tournamentCode: tournament.publicCode,
      });

      createdMatchByKey.set(plannedMatch.bracketMatchKey, match);
      createdScoreboardIds.push(toIdString(scoreboard._id));
      createdMatchIds.push(toIdString(match._id));
    }
  } catch (error) {
    if (createdMatchIds.length > 0) {
      await Match.deleteMany({ _id: { $in: createdMatchIds } });
    }

    if (createdScoreboardIds.length > 0) {
      await Scoreboard.deleteMany({ _id: { $in: createdScoreboardIds } });
    }

    throw error;
  }

  const generatedBrackets = uniqueValues(scheduledMatches.map((match) => normalizeBracket(match.bracket)));
  await Promise.all(
    generatedBrackets.map((bracket) =>
      recomputePlayoffBracketProgression(tournamentId, bracket, { allowUnknownBracket: true })
    )
  );

  await ensureTournamentStatusAtLeast(tournamentId, 'playoffs');

  return loadMatchesForResponse({ _id: { $in: createdMatchIds } });
}

// GET /api/tournaments/code/:publicCode -> public tournament + teams payload
router.get('/code/:publicCode', async (req, res, next) => {
  try {
    const publicCode = normalizePublicCode(req.params.publicCode);

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode)) {
      return res.status(400).json({ message: 'Invalid tournament code' });
    }

    const tournament = await findTournamentForPublicCode(publicCode);

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const teams = await TournamentTeam.find({ tournamentId: tournament._id })
      .select('name shortName logoUrl orderIndex seed createdAt')
      .lean();
    teams.sort(compareTeamsByTournamentOrder);

    const tournamentWithDefaults = attachTournamentScheduleDefaults(tournament, {
      teamCount: teams.length,
    });

    return res.json({
      tournament: {
        id: tournament._id.toString(),
        name: tournament.name,
        date: tournament.date,
        timezone: tournament.timezone,
        status: tournament.status,
        facilities: tournament.facilities,
        settings: {
          schedule: normalizeTournamentSchedule(tournament?.settings?.schedule),
          format:
            tournamentWithDefaults?.settings?.format &&
            typeof tournamentWithDefaults.settings.format === 'object'
              ? tournamentWithDefaults.settings.format
              : {
                  formatId: null,
                  activeCourts: [],
                },
        },
        publicCode: tournament.publicCode,
      },
      teams: teams.map((team) => ({
        id: team._id.toString(),
        name: team.name,
        shortName: team.shortName,
        logoUrl: team.logoUrl || null,
        orderIndex: normalizeTeamOrderIndex(team.orderIndex),
        seed: team.seed ?? null,
      })),
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/code/:publicCode/details -> public details content
router.get('/code/:publicCode/details', async (req, res, next) => {
  try {
    const publicCode = normalizePublicCode(req.params.publicCode);

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode)) {
      return res.status(400).json({ message: 'Invalid tournament code' });
    }

    const tournament = await Tournament.findOne({ publicCode })
      .select('name date timezone publicCode details')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    return res.json({
      tournament: {
        name: tournament.name,
        date: tournament.date,
        timezone: tournament.timezone,
        publicCode: tournament.publicCode,
      },
      details: serializeTournamentDetails(tournament.details),
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/code/:publicCode/live -> public live matches cards
router.get('/code/:publicCode/live', async (req, res, next) => {
  try {
    const publicCode = normalizePublicCode(req.params.publicCode);

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode)) {
      return res.status(400).json({ message: 'Invalid tournament code' });
    }

    const tournament = await Tournament.findOne({ publicCode })
      .select('_id timezone settings.schedule settings.format settings.venue facilities')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const teamCount = await TournamentTeam.countDocuments({ tournamentId: tournament._id });
    const formatContext = getTournamentFormatContext(tournament, teamCount);
    const phaseLabels = buildPhaseLabelLookup(formatContext.formatDef);

    const liveMatches = await Match.find({
      tournamentId: tournament._id,
      status: 'live',
    })
      .select(
        'phase bracket roundBlock facility court facilityId courtId teamAId teamBId status startedAt endedAt result scoreboardId'
      )
      .populate('teamAId', 'name shortName logoUrl')
      .populate('teamBId', 'name shortName logoUrl')
      .populate('scoreboardId', 'code teams.score sets')
      .lean();

    const cards = sortLiveMatchCards(
      liveMatches.map((match) => serializeMatchForLiveView(match, tournament, phaseLabels))
    );

    return res.json(cards);
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/code/:publicCode/team/:teamCode -> public team-focused view payload
router.get('/code/:publicCode/team/:teamCode', async (req, res, next) => {
  try {
    const publicCode = normalizePublicCode(req.params.publicCode);
    const teamCode = normalizeTeamPublicCode(req.params.teamCode);

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode) || !isValidTeamPublicCode(teamCode)) {
      return res.status(404).json({ message: 'Not found' });
    }

    const tournament = await Tournament.findOne({ publicCode })
      .select(
        '_id name date timezone publicCode facilities settings.schedule settings.schedulePlan settings.format settings.venue'
      )
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Not found' });
    }

    const teamCount = await TournamentTeam.countDocuments({ tournamentId: tournament._id });
    const formatContext = getTournamentFormatContext(tournament, teamCount);
    const phaseLabels = buildPhaseLabelLookup(formatContext.formatDef);
    const stageDefinitions = buildStageDefinitionLookup(formatContext.formatDef);
    const stageLabels = buildStageLabelLookup(formatContext.formatDef);

    const team = await TournamentTeam.findOne({
      tournamentId: tournament._id,
      publicTeamCode: teamCode,
    })
      .select('_id name shortName logoUrl')
      .lean();

    if (!team) {
      return res.status(404).json({ message: 'Not found' });
    }

    const teamId = toIdString(team._id);
    const tournamentForTimeLabels = {
      timezone: tournament.timezone,
      settings: {
        schedule: normalizeTournamentSchedule(tournament?.settings?.schedule),
        venue: formatContext.venue,
      },
    };
    const schedulePlanResult = await loadSchedulePlanSlotViews({
      tournament,
      formatContext,
      phaseLabels,
      stageDefinitions,
      stageLabels,
      includeLegacyFallback: true,
      io: req.app?.get('io'),
    });
    const scheduleSlotViews = Array.isArray(schedulePlanResult?.slots)
      ? schedulePlanResult.slots
      : [];

    const relevantMatches = await Match.find({
      tournamentId: tournament._id,
      $or: [
        { teamAId: team._id },
        { teamBId: team._id },
        { refTeamIds: team._id },
        { byeTeamId: team._id },
      ],
    })
      .select(
        'phase bracket bracketRound roundBlock facility court facilityId courtId teamAId teamBId refTeamIds byeTeamId poolId status startedAt endedAt result scoreboardId createdAt'
      )
      .populate('teamAId', 'name shortName logoUrl')
      .populate('teamBId', 'name shortName logoUrl')
      .populate('refTeamIds', 'name shortName')
      .populate('byeTeamId', 'name shortName')
      .populate('poolId', 'name')
      .populate('scoreboardId', 'teams.score sets')
      .lean();

    const participantMatches = sortMatchesForCourtSchedule(
      relevantMatches.filter((match) => {
        const teamAId = toIdString(match?.teamAId?._id || match?.teamAId);
        const teamBId = toIdString(match?.teamBId?._id || match?.teamBId);
        return teamAId === teamId || teamBId === teamId;
      })
    ).map((match) =>
      serializeMatchForTeamView(match, teamId, tournamentForTimeLabels, phaseLabels)
    );

    const refAssignments = sortMatchesForCourtSchedule(
      relevantMatches.filter((match) =>
        Array.isArray(match?.refTeamIds)
          ? match.refTeamIds.some((refTeam) => toIdString(refTeam?._id || refTeam) === teamId)
          : false
      )
    ).map((match) =>
      serializeMatchForTeamView(match, teamId, tournamentForTimeLabels, phaseLabels)
    );

    const byeAssignments = sortMatchesForCourtSchedule(
      relevantMatches.filter((match) => {
        const byeId = toIdString(match?.byeTeamId?._id || match?.byeTeamId);
        return byeId === teamId;
      })
    ).map((match) => ({
      courtCode: match?.courtId || match?.court || null,
      matchId: toIdString(match?._id),
      phase: match?.phase ?? null,
      phaseLabel: resolvePhaseLabel(match?.phase, phaseLabels),
      roundBlock: match?.roundBlock ?? null,
      timeLabel: formatRoundBlockStartTime(match?.roundBlock, tournamentForTimeLabels),
      courtLabel:
        findCourtInVenue(tournament?.settings?.venue, match?.courtId || match?.court)?.courtName
        || mapCourtDisplayLabel(match?.court),
      poolName: match?.poolId && typeof match.poolId === 'object' ? (match.poolId.name || null) : null,
    }));
    const timelineEntries = [];

    scheduleSlotViews.forEach((slotView, index) => {
      if (slotView?.kind === 'lunch') {
        timelineEntries.push(
          createTeamTimelineEntry({
            slotView,
            role: 'LUNCH',
            focusTeamId: teamId,
            index,
          })
        );
        return;
      }

      const participantIds = (Array.isArray(slotView?.participants) ? slotView.participants : [])
        .map((entry) => toIdString(entry?.teamId))
        .filter(Boolean);
      const refTeamId = toIdString(slotView?.ref?.teamId);
      const byeTeamIds = (Array.isArray(slotView?.byeParticipants) ? slotView.byeParticipants : [])
        .map((entry) => toIdString(entry?.teamId))
        .filter(Boolean);

      if (participantIds.includes(teamId)) {
        timelineEntries.push(
          createTeamTimelineEntry({
            slotView,
            role: 'PLAY',
            focusTeamId: teamId,
            index,
          })
        );
        return;
      }

      if (refTeamId && refTeamId === teamId) {
        timelineEntries.push(
          createTeamTimelineEntry({
            slotView,
            role: 'REF',
            focusTeamId: teamId,
            index,
          })
        );
        return;
      }

      if (byeTeamIds.includes(teamId)) {
        timelineEntries.push(
          createTeamTimelineEntry({
            slotView,
            role: 'BYE',
            focusTeamId: teamId,
            index,
          })
        );
      }
    });

    const timelineRoleMatchKeys = new Set(
      timelineEntries
        .map((entry) => `${entry?.role || ''}:${entry?.matchId || entry?.slotId || entry?.timelineId || ''}`)
        .filter((key) => key !== ':')
    );
    const toFallbackTimeIndex = (roundBlock) => {
      const parsedRoundBlock = Number(roundBlock);
      if (!Number.isFinite(parsedRoundBlock) || parsedRoundBlock <= 0) {
        return null;
      }
      const resolvedMinutes = resolveSchedulePlanRoundBlockStartMinutes(
        Math.floor(parsedRoundBlock),
        tournamentForTimeLabels
      );
      return Number.isFinite(Number(resolvedMinutes)) ? Number(resolvedMinutes) : null;
    };
    const upsertFallbackTimelineEntry = (role, sourceEntry, index) => {
      const normalizedRole = String(role || '').trim().toUpperCase();
      const fallbackMatchId = toIdString(sourceEntry?.matchId);
      const fallbackSlotId = isNonEmptyString(sourceEntry?.plannedSlotId)
        ? sourceEntry.plannedSlotId.trim()
        : '';
      const fallbackKey = `${normalizedRole}:${fallbackMatchId || fallbackSlotId || index}`;
      if (timelineRoleMatchKeys.has(fallbackKey)) {
        return;
      }
      timelineRoleMatchKeys.add(fallbackKey);

      const scoreSummary = sourceEntry?.scoreSummary || null;
      const completedSetScores = Array.isArray(sourceEntry?.completedSetScores)
        ? sourceEntry.completedSetScores
        : [];
      timelineEntries.push({
        timelineId: `legacy:${fallbackKey}`,
        role: normalizedRole,
        roleLabel: normalizedRole || 'PLAY',
        iconKey:
          normalizedRole === 'REF'
            ? 'ref'
            : normalizedRole === 'BYE'
              ? 'bye'
              : normalizedRole === 'LUNCH'
                ? 'lunch'
                : 'play',
        summaryLabel:
          normalizedRole === 'REF'
            ? `${sourceEntry?.teamA?.shortName || 'TBD'} vs ${sourceEntry?.teamB?.shortName || 'TBD'}`
            : normalizedRole === 'BYE'
              ? sourceEntry?.poolName
                ? `BYE (Pool ${sourceEntry.poolName})`
                : 'BYE'
              : `vs ${sourceEntry?.opponent?.shortName || 'TBD'}`,
        stageKey: sourceEntry?.stageKey || null,
        stageLabel: sourceEntry?.phaseLabel || sourceEntry?.phase || null,
        phase: sourceEntry?.phase || null,
        phaseLabel: sourceEntry?.phaseLabel || sourceEntry?.phase || null,
        roundBlock: sourceEntry?.roundBlock ?? null,
        timeIndex: toFallbackTimeIndex(sourceEntry?.roundBlock),
        timeLabel: sourceEntry?.timeLabel || '',
        status: sourceEntry?.status || 'scheduled',
        slotId: fallbackSlotId || null,
        matchId: fallbackMatchId || null,
        plannedSlotId: fallbackSlotId || null,
        scoreboardCode: sourceEntry?.scoreboardCode || null,
        startedAt: sourceEntry?.startedAt ?? null,
        endedAt: sourceEntry?.endedAt ?? null,
        poolName: sourceEntry?.poolName || null,
        bracket: sourceEntry?.bracket ?? null,
        roundLabel: sourceEntry?.roundLabel ?? null,
        courtCode: sourceEntry?.courtCode || null,
        courtLabel: sourceEntry?.courtLabel || null,
        facility: sourceEntry?.facility || null,
        facilityLabel: sourceEntry?.facilityLabel || null,
        matchupLabel:
          normalizedRole === 'REF'
            ? `${sourceEntry?.teamA?.shortName || 'TBD'} vs ${sourceEntry?.teamB?.shortName || 'TBD'}`
            : null,
        matchupReferenceLabel: null,
        participants: [],
        teamA: sourceEntry?.teamA || null,
        teamB: sourceEntry?.teamB || null,
        opponent: sourceEntry?.opponent || null,
        ref: null,
        refLabel: null,
        refReferenceLabel: null,
        byeParticipants: [],
        byeLabel: normalizedRole === 'BYE' ? 'BYE' : null,
        scoreSummary,
        completedSetScores,
        setSummary:
          sourceEntry?.setSummary
          || (scoreSummary
            ? {
                setsA: Number(scoreSummary?.setsA) || 0,
                setsB: Number(scoreSummary?.setsB) || 0,
                setScores: completedSetScores,
              }
            : null),
        isResolved: true,
      });
    };
    participantMatches.forEach((matchEntry, index) => {
      upsertFallbackTimelineEntry('PLAY', matchEntry, index);
    });
    refAssignments.forEach((matchEntry, index) => {
      upsertFallbackTimelineEntry('REF', matchEntry, index);
    });
    byeAssignments.forEach((byeEntry, index) => {
      upsertFallbackTimelineEntry('BYE', byeEntry, index);
    });

    const normalizedSchedule = normalizeTournamentSchedule(tournament?.settings?.schedule);
    const lunchTimeMinutes = isNonEmptyString(normalizedSchedule?.lunchStartTime)
      ? parseClockTimeToMinutes(normalizedSchedule.lunchStartTime)
      : null;
    const lunchDurationMinutes = Number(normalizedSchedule?.lunchDurationMinutes);
    const hasLunchTimelineEntry = timelineEntries.some((entry) => entry?.role === 'LUNCH');
    if (
      !hasLunchTimelineEntry
      && Number.isFinite(lunchTimeMinutes)
      && Number.isFinite(lunchDurationMinutes)
      && lunchDurationMinutes > 0
    ) {
      timelineEntries.push(
        createTeamTimelineEntry({
          slotView: {
            slotId: 'lunch:main',
            kind: 'lunch',
            stageKey: 'lunch',
            stageLabel: 'Lunch',
            phase: null,
            phaseLabel: 'Lunch',
            roundBlock: null,
            timeIndex: lunchTimeMinutes,
            timeLabel: formatSchedulePlanTimeLabel(lunchTimeMinutes, tournamentForTimeLabels),
            status: 'scheduled',
            matchupLabel: 'Lunch Break',
            lunchDurationMinutes:
              toPositiveInteger(lunchDurationMinutes)
              || TOURNAMENT_SCHEDULE_DEFAULTS.lunchDurationMinutes,
            participants: [],
            byeParticipants: [],
          },
          role: 'LUNCH',
          focusTeamId: teamId,
          index: timelineEntries.length,
        })
      );
    }
    const timeline = sortTeamTimelineEntries(timelineEntries);

    const nextUp = participantMatches.find(
      (match) => !['ended', 'final'].includes(match.status)
    ) || null;

    const venueCourts = getEnabledCourts(formatContext.venue);

    return res.json({
      tournament: {
        id: toIdString(tournament._id),
        name: tournament.name,
        date: tournament.date,
        timezone: tournament.timezone,
        publicCode: tournament.publicCode,
        facilities: tournament.facilities,
        courts:
          venueCourts.length > 0
            ? venueCourts.map((court) => ({
                code: court.courtId,
                label: court.courtName,
                facility: court.facilityId,
                facilityLabel: court.facilityName || '',
              }))
            : PHASE1_COURT_ORDER.map((courtCode) => {
                const facility = getFacilityFromCourt(courtCode);
                return {
                  code: courtCode,
                  label: mapCourtDisplayLabel(courtCode),
                  facility,
                  facilityLabel: FACILITY_LABELS[facility] || facility,
                };
              }),
        settings: {
          schedule: normalizeTournamentSchedule(tournament?.settings?.schedule),
          format: {
            formatId: formatContext.formatId,
            totalCourts: formatContext.totalCourts,
            activeCourts: formatContext.activeCourts,
          },
          venue: formatContext.venue,
        },
      },
      team: {
        teamId,
        shortName: team.shortName || team.name || 'TBD',
        logoUrl: team.logoUrl || null,
      },
      nextUp,
      timeline,
      matches: participantMatches,
      refs: refAssignments,
      byes: byeAssignments,
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/code/:publicCode/courts -> public court list
router.get('/code/:publicCode/courts', async (req, res, next) => {
  try {
    const publicCode = normalizePublicCode(req.params.publicCode);

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode)) {
      return res.status(400).json({ message: 'Invalid tournament code' });
    }

    const tournament = await Tournament.findOne({ publicCode })
      .select('_id settings.format settings.venue facilities')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const teamCount = await TournamentTeam.countDocuments({ tournamentId: tournament._id });
    const formatContext = getTournamentFormatContext(tournament, teamCount);
    const venueCourts = getEnabledCourts(formatContext.venue);

    return res.json({
      courts:
        venueCourts.length > 0
          ? venueCourts.map((court) => ({
              code: court.courtId,
              label: court.courtName,
              facility: court.facilityId,
              facilityLabel: court.facilityName || '',
            }))
          : PHASE1_COURT_ORDER.map((courtCode) => ({
              code: courtCode,
              label: mapCourtDisplayLabel(courtCode),
              facility: getFacilityFromCourt(courtCode),
              facilityLabel: FACILITY_LABELS[getFacilityFromCourt(courtCode)] || getFacilityFromCourt(courtCode),
            })),
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/code/:publicCode/courts/:courtCode/schedule -> public court schedule
router.get('/code/:publicCode/courts/:courtCode/schedule', async (req, res, next) => {
  try {
    const publicCode = normalizePublicCode(req.params.publicCode);
    const requestedCourtKey = isNonEmptyString(req.params.courtCode)
      ? req.params.courtCode.trim()
      : '';

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode)) {
      return res.status(400).json({ message: 'Invalid tournament code' });
    }

    if (!requestedCourtKey) {
      return res.status(400).json({ message: 'Invalid court code' });
    }

    const tournament = await Tournament.findOne({ publicCode })
      .select(
        '_id timezone settings.schedule settings.schedulePlan settings.format settings.venue facilities'
      )
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const teamCount = await TournamentTeam.countDocuments({ tournamentId: tournament._id });
    const formatContext = getTournamentFormatContext(tournament, teamCount);
    const phaseLabels = buildPhaseLabelLookup(formatContext.formatDef);
    const stageDefinitions = buildStageDefinitionLookup(formatContext.formatDef);
    const stageLabels = buildStageLabelLookup(formatContext.formatDef);
    const venueCourt = findCourtInVenue(formatContext.venue, requestedCourtKey);
    const legacyCourtCode = normalizeCourtCode(requestedCourtKey);
    const requestedCourtLookupKeys = new Set(
      [
        normalizeCourtLookupKey(requestedCourtKey),
        normalizeCourtLookupKey(legacyCourtCode),
        normalizeCourtLookupKey(venueCourt?.courtId),
        normalizeCourtLookupKey(venueCourt?.courtName),
      ].filter(Boolean)
    );

    const schedulePlanResult = await loadSchedulePlanSlotViews({
      tournament,
      formatContext,
      phaseLabels,
      stageDefinitions,
      stageLabels,
      includeLegacyFallback: true,
      io: req.app?.get('io'),
    });
    const allSlots = Array.isArray(schedulePlanResult?.slots)
      ? schedulePlanResult.slots
      : [];
    const responseSlots = sortSchedulePlanSlotsByTime(
      allSlots.filter((slot) => {
        const lookupKeys = new Set(
          [
            normalizeCourtLookupKey(slot?.courtCode),
            normalizeCourtLookupKey(slot?.courtLabel),
          ].filter(Boolean)
        );
        return Array.from(lookupKeys).some((lookupKey) => requestedCourtLookupKeys.has(lookupKey));
      })
    );
    const responseLegacyMatches = responseSlots
      .filter((slot) => normalizeSchedulePlanSlotKind(slot?.kind) === 'match')
      .map((slot) => serializeLegacyCourtScheduleMatch(slot));

    return res.json({
      court: {
        code: venueCourt?.courtId || requestedCourtKey,
        label:
          venueCourt?.courtName
          || mapCourtDisplayLabel(legacyCourtCode || requestedCourtKey),
        facility: venueCourt?.facilityId || getFacilityFromCourt(legacyCourtCode || requestedCourtKey),
        facilityLabel:
          venueCourt?.facilityName
          || FACILITY_LABELS[getFacilityFromCourt(legacyCourtCode || requestedCourtKey)]
          || getFacilityFromCourt(legacyCourtCode || requestedCourtKey),
      },
      slots: responseSlots,
      matches: responseLegacyMatches,
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/code/:publicCode/schedule-plan -> public schedulePlan slot views
router.get('/code/:publicCode/schedule-plan', async (req, res, next) => {
  try {
    const publicCode = normalizePublicCode(req.params.publicCode);

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode)) {
      return res.status(400).json({ message: 'Invalid tournament code' });
    }

    const tournament = await Tournament.findOne({ publicCode })
      .select('_id timezone settings.schedule settings.schedulePlan settings.format settings.venue facilities')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const teamCount = await TournamentTeam.countDocuments({ tournamentId: tournament._id });
    const formatContext = getTournamentFormatContext(tournament, teamCount);
    const phaseLabels = buildPhaseLabelLookup(formatContext.formatDef);
    const stageDefinitions = buildStageDefinitionLookup(formatContext.formatDef);
    const stageLabels = buildStageLabelLookup(formatContext.formatDef);
    const includeLegacyFallback = parseBooleanFlag(req.query?.includeLegacyFallback, true);

    const schedulePlanResult = await loadSchedulePlanSlotViews({
      tournament,
      formatContext,
      phaseLabels,
      stageDefinitions,
      stageLabels,
      stageKeysFilter: req.query?.stageKeys,
      kindsFilter: req.query?.kinds,
      includeLegacyFallback,
      io: req.app?.get('io'),
    });

    return res.json({
      slots: Array.isArray(schedulePlanResult?.slots) ? schedulePlanResult.slots : [],
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/code/:publicCode/phase1/pools -> public read-only phase1 pools
router.get('/code/:publicCode/phase1/pools', async (req, res, next) => {
  try {
    const publicCode = normalizePublicCode(req.params.publicCode);

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode)) {
      return res.status(400).json({ message: 'Invalid tournament code' });
    }

    const tournament = await Tournament.findOne({ publicCode }).select('_id').lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const pools = await loadPhase1Pools(tournament._id, { populateTeams: true });
    return res.json(pools.map(serializePool));
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/code/:publicCode/phase2/pools -> public read-only phase2 pools
router.get('/code/:publicCode/phase2/pools', async (req, res, next) => {
  try {
    const publicCode = normalizePublicCode(req.params.publicCode);

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode)) {
      return res.status(400).json({ message: 'Invalid tournament code' });
    }

    const tournament = await Tournament.findOne({ publicCode }).select('_id').lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const pools = await loadPhase2Pools(tournament._id, { populateTeams: true });
    return res.json(pools.map(serializePool));
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/code/:publicCode/matches?phase=phase1|phase2|playoffs
router.get('/code/:publicCode/matches', async (req, res, next) => {
  try {
    const publicCode = normalizePublicCode(req.params.publicCode);

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode)) {
      return res.status(400).json({ message: 'Invalid tournament code' });
    }

    const phaseError = validateMatchPhaseFilter(req.query?.phase);

    if (phaseError) {
      return res.status(400).json({ message: phaseError });
    }

    const tournament = await Tournament.findOne({ publicCode }).select('_id').lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const query = { tournamentId: tournament._id };

    if (req.query?.phase) {
      query.phase = req.query.phase;
    }

    const matches = await loadMatchesForResponse(query);
    return res.json(matches);
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/code/:publicCode/playoffs -> public playoff brackets + ops schedule
router.get('/code/:publicCode/playoffs', async (req, res, next) => {
  try {
    const publicCode = normalizePublicCode(req.params.publicCode);

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode)) {
      return res.status(400).json({ message: 'Invalid tournament code' });
    }

    const tournament = await Tournament.findOne({ publicCode })
      .select('_id name timezone status publicCode settings.schedule settings.schedulePlan settings.format settings.venue facilities')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const teamCount = await TournamentTeam.countDocuments({ tournamentId: tournament._id });
    const formatContext = getTournamentFormatContext(tournament, teamCount);
    const phaseLabels = buildPhaseLabelLookup(formatContext.formatDef);
    const stageDefinitions = buildStageDefinitionLookup(formatContext.formatDef);
    const stageLabels = buildStageLabelLookup(formatContext.formatDef);

    const matches = await loadMatchesForResponse({
      tournamentId: tournament._id,
      phase: 'playoffs',
    });
    const sanitizedMatches = matches.map(sanitizePlayoffMatchForPublic);
    let payload = buildFormatAwarePlayoffPayload(sanitizedMatches, formatContext.formatDef);
    const isLegacyFormat = formatContext.formatDef?.id === DEFAULT_15_TEAM_FORMAT_ID;
    if (!isLegacyFormat && (!Array.isArray(payload?.opsSchedule) || payload.opsSchedule.length === 0)) {
      const schedulePlanResult = await loadSchedulePlanSlotViews({
        tournament,
        formatContext,
        phaseLabels,
        stageDefinitions,
        stageLabels,
        stageKeysFilter: ['playoffs'],
        kindsFilter: ['match'],
        includeLegacyFallback: false,
        io: req.app?.get('io'),
      });
      const fallbackOpsSchedule = buildPlayoffOpsScheduleFromSchedulePlanSlots(schedulePlanResult?.slots);
      if (fallbackOpsSchedule.length > 0) {
        payload = {
          ...payload,
          opsSchedule: fallbackOpsSchedule,
        };
      }
    }

    return res.json({
      tournament: {
        id: tournament._id.toString(),
        name: tournament.name,
        timezone: tournament.timezone,
        status: tournament.status,
        settings: {
          schedule: normalizeTournamentSchedule(tournament?.settings?.schedule),
          format: {
            formatId: formatContext.formatId,
            totalCourts: formatContext.totalCourts,
            activeCourts: formatContext.activeCourts,
          },
          venue: formatContext.venue,
        },
        publicCode: tournament.publicCode,
      },
      ...payload,
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/code/:publicCode/standings?phase=phase1|phase2|cumulative -> public standings
router.get('/code/:publicCode/standings', async (req, res, next) => {
  try {
    const publicCode = normalizePublicCode(req.params.publicCode);
    const phase = normalizeStandingsPhase(req.query?.phase);

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode)) {
      return res.status(400).json({ message: 'Invalid tournament code' });
    }

    const phaseError = validateStandingsPhaseFilter(phase);

    if (phaseError) {
      return res.status(400).json({ message: phaseError });
    }

    const tournament = await Tournament.findOne({ publicCode }).select('_id').lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const standings = await computeStandingsBundle(tournament._id, phase);

    return res.json({
      phase,
      basedOn: 'finalized',
      ...formatStandingsPayload(standings),
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments -> list tournaments accessible by current user
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const accessibleTournamentIds = await listUserAccessibleTournamentIds(req.user.id);

    if (accessibleTournamentIds.length === 0) {
      return res.json([]);
    }

    const tournaments = await Tournament.find({ _id: { $in: accessibleTournamentIds } })
      .sort({ date: -1, createdAt: -1 })
      .lean();

    return res.json(
      tournaments.map((tournament) => {
        const isOwner = toIdString(tournament.createdByUserId) === req.user.id;
        return {
          ...tournament,
          accessRole: isOwner ? 'owner' : TOURNAMENT_ADMIN_ROLE,
          isOwner,
        };
      })
    );
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments -> create a tournament
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { name, date, timezone } = req.body ?? {};

    if (!isNonEmptyString(name)) {
      return res.status(400).json({ message: 'Tournament name is required' });
    }

    const parsedDate = parseTournamentDate(date);

    if (!parsedDate) {
      return res.status(400).json({ message: 'A valid tournament date is required' });
    }

    if (timezone !== undefined && !isNonEmptyString(timezone)) {
      return res.status(400).json({ message: 'timezone must be a non-empty string' });
    }

    const maxCreateAttempts = 5;

    for (let attempt = 0; attempt < maxCreateAttempts; attempt += 1) {
      const publicCode = await createUniqueTournamentPublicCode(Tournament);

      try {
        const tournament = await Tournament.create({
          name: name.trim(),
          date: parsedDate,
          timezone: timezone?.trim() || undefined,
          publicCode,
          createdByUserId: req.user.id,
        });

        return res.status(201).json(tournament.toObject());
      } catch (error) {
        if (isDuplicatePublicCodeError(error)) {
          continue;
        }

        throw error;
      }
    }

    return res.status(500).json({ message: 'Failed to generate a unique tournament code' });
  } catch (error) {
    return next(error);
  }
});

// PATCH /api/tournaments/:id -> update editable tournament fields
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const updates = {};

    if (req.body?.name !== undefined) {
      if (!isNonEmptyString(req.body.name)) {
        return res.status(400).json({ message: 'Tournament name must be a non-empty string' });
      }

      updates.name = req.body.name.trim();
    }

    if (req.body?.date !== undefined) {
      const parsedDate = parseTournamentDate(req.body.date);

      if (!parsedDate) {
        return res.status(400).json({ message: 'Tournament date must be a valid date' });
      }

      updates.date = parsedDate;
    }

    if (req.body?.timezone !== undefined) {
      if (!isNonEmptyString(req.body.timezone)) {
        return res.status(400).json({ message: 'timezone must be a non-empty string' });
      }

      updates.timezone = req.body.timezone.trim();
    }

    if (req.body?.status !== undefined) {
      if (!TOURNAMENT_STATUSES.includes(req.body.status)) {
        return res.status(400).json({ message: 'Invalid tournament status' });
      }

      updates.status = req.body.status;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No valid fields provided for update' });
    }

    const adminContext = await requireTournamentAdminContext(id, req.user.id);
    if (!adminContext) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const tournament = await Tournament.findOneAndUpdate(
      {
        _id: id,
      },
      updates,
      {
        new: true,
        runValidators: true,
        omitUndefined: true,
      }
    );

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    return res.json(tournament.toObject());
  } catch (error) {
    return next(error);
  }
});

// DELETE /api/tournaments/:id -> owner-only tournament delete
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const ownerContext = await requireTournamentOwnerContext(id, req.user.id, '_id');
    const tournament = ownerContext?.tournament || null;

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const matches = await Match.find({ tournamentId: id }).select('scoreboardId').lean();
    const scoreboardIds = [...new Set(
      matches
        .map((match) => (match?.scoreboardId ? toIdString(match.scoreboardId) : ''))
        .filter(Boolean)
    )];

    await Match.deleteMany({ tournamentId: id });
    await Pool.deleteMany({ tournamentId: id });
    await TournamentTeam.deleteMany({ tournamentId: id });
    await TournamentAccess.deleteMany({ tournamentId: id });
    await TournamentInvite.deleteMany({ tournamentId: id });
    await TournamentShareLink.deleteMany({ tournamentId: id });

    if (scoreboardIds.length > 0) {
      await Scoreboard.deleteMany({
        _id: { $in: scoreboardIds },
      });
    }

    await Tournament.deleteOne({
      _id: id,
    });

    return res.json({
      deleted: true,
      tournamentId: id,
    });
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments/:id/reset -> owner-only reset of schedule/results while keeping teams/details
router.post('/:id/reset', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const ownerContext = await requireTournamentOwnerContext(id, req.user.id, 'publicCode');
    const tournament = ownerContext?.tournament || null;

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const matchDeletion = await deleteMatchesAndLinkedScoreboards({ tournamentId: id });
    const poolsDeletion = await Pool.deleteMany({ tournamentId: id });

    await Tournament.updateOne(
      { _id: id },
      {
        $set: {
          status: 'setup',
        },
        $unset: {
          standingsOverrides: '',
        },
      }
    );

    await syncSchedulePlan({
      tournamentId: id,
      actorUserId: req.user.id,
      io: req.app?.get('io'),
      emitEvents: false,
    });

    const deleted = {
      pools: Number(poolsDeletion?.deletedCount || 0),
      matches: Array.isArray(matchDeletion?.deletedMatchIds)
        ? matchDeletion.deletedMatchIds.length
        : 0,
      scoreboards: Array.isArray(matchDeletion?.deletedScoreboardIds)
        ? matchDeletion.deletedScoreboardIds.length
        : 0,
    };

    emitTournamentEventFromRequest(
      req,
      tournament.publicCode,
      TOURNAMENT_EVENT_TYPES.TOURNAMENT_RESET,
      {
        tournamentId: toIdString(id),
        status: 'setup',
        deleted,
      }
    );

    return res.json({
      reset: true,
      tournamentId: toIdString(id),
      status: 'setup',
      deleted,
    });
  } catch (error) {
    return next(error);
  }
});

// PATCH /api/tournaments/:id/details -> tournament-admin details content update
router.patch('/:id/details', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const ownedTournament = await requireTournamentAdminContext(id, req.user.id);

    if (!ownedTournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const { updates, error } = normalizeTournamentDetailsPatch(req.body);

    if (error) {
      return res.status(400).json({ message: error });
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No valid details fields provided for update' });
    }

    const tournament = await Tournament.findOneAndUpdate(
      {
        _id: id,
      },
      {
        $set: updates,
      },
      {
        new: true,
        runValidators: true,
        omitUndefined: true,
      }
    )
      .select('publicCode details')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const serializedDetails = serializeTournamentDetails(tournament.details);

    emitTournamentEventFromRequest(
      req,
      tournament.publicCode,
      TOURNAMENT_EVENT_TYPES.DETAILS_UPDATED,
      { details: serializedDetails }
    );

    return res.json({
      details: serializedDetails,
    });
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments/:id/apply-format -> tournament-admin applies a format + total courts
router.post('/:id/apply-format', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const requestedFormatId = isNonEmptyString(req.body?.formatId)
      ? req.body.formatId.trim()
      : '';
    const forceApply = parseBooleanFlag(req.query?.force, false);

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    if (!requestedFormatId) {
      return res.status(400).json({ message: 'formatId is required' });
    }

    const ownedContext = await getOwnedTournamentAndTeamCount(
      id,
      req.user.id,
      'publicCode status settings facilities'
    );

    if (!ownedContext) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const { tournament, teamCount } = ownedContext;
    const formatDef = getFormat(requestedFormatId);

    if (!formatDef) {
      return res.status(400).json({ message: 'Unknown formatId' });
    }

    if (!formatDef.supportedTeamCounts.includes(teamCount)) {
      return res.status(400).json({
        message: `Format ${formatDef.name} does not support ${teamCount} teams`,
      });
    }

    const availableCourts = flattenFacilityCourts(tournament?.facilities);
    const activeCourtsResult = normalizeActiveCourtsSelection({
      requestedActiveCourts: req.body?.activeCourts,
      availableCourts,
    });

    if (!activeCourtsResult.ok) {
      return res.status(400).json({ message: activeCourtsResult.message });
    }

    const fallbackTotalCourts =
      activeCourtsResult.activeCourts.length > 0
        ? activeCourtsResult.activeCourts.length
        : resolveTournamentVenueState(tournament).totalCourts;
    const totalCourts = toPositiveInteger(req.body?.totalCourts) || fallbackTotalCourts;

    if (!totalCourts) {
      return res.status(400).json({ message: 'totalCourts must be a positive integer' });
    }

    if (
      Number.isFinite(Number(formatDef.minCourts)) &&
      totalCourts < Number(formatDef.minCourts)
    ) {
      return res.status(400).json({
        message: `${formatDef.name} requires at least ${formatDef.minCourts} courts`,
      });
    }

    if (
      Number.isFinite(Number(formatDef.maxCourts)) &&
      totalCourts > Number(formatDef.maxCourts)
    ) {
      return res.status(400).json({
        message: `${formatDef.name} supports at most ${formatDef.maxCourts} courts`,
      });
    }

    const existingWork = await Promise.all([
      Pool.findOne({ tournamentId: id }).select('_id').lean(),
      Match.findOne({ tournamentId: id }).select('_id').lean(),
    ]);

    if ((existingWork[0] || existingWork[1]) && !forceApply) {
      return res.status(409).json({
        message: 'Tournament already has pools or matches. Re-run with ?force=true to replace.',
      });
    }

    if (forceApply) {
      await deleteMatchesAndLinkedScoreboards({ tournamentId: id });
      await Pool.deleteMany({ tournamentId: id });
    }

    const existingVenueFacilities = normalizeVenueFacilities(
      tournament?.settings?.venue?.facilities
    );
    const existingVenueCourtCount = countVenueCourts(existingVenueFacilities);
    const selectedLegacyCourts =
      activeCourtsResult.activeCourts.length > 0
        ? activeCourtsResult.activeCourts
        : availableCourts;
    const currentVenueState =
      existingVenueCourtCount > 0
        ? {
            totalCourts,
            venue: { facilities: existingVenueFacilities },
          }
        : {
            totalCourts,
            venue: buildDefaultVenue(totalCourts, {
              legacyCourtNames: selectedLegacyCourts,
            }),
          };
    const activeCourts = venueToLegacyCourtNames(currentVenueState.venue, { enabledOnly: true });
    const scheduleInput =
      req.body?.schedule && typeof req.body.schedule === 'object' ? req.body.schedule : {};
    const schedulePatch = normalizeTournamentSchedule({
      dayStartTime: scheduleInput.dayStartTime ?? scheduleInput.startTime,
      matchDurationMinutes:
        scheduleInput.matchDurationMinutes ?? scheduleInput.matchDuration,
      lunchStartTime: scheduleInput.lunchStartTime ?? scheduleInput.lunchStart,
      lunchDurationMinutes:
        scheduleInput.lunchDurationMinutes ?? scheduleInput.lunchDuration,
    });

    await Tournament.updateOne(
      { _id: id },
      {
        $set: {
          'settings.format.formatId': formatDef.id,
          'settings.format.totalCourts': totalCourts,
          'settings.format.activeCourts': activeCourts,
          'settings.schedule': schedulePatch,
          'settings.venue': currentVenueState.venue,
        },
      }
    );

    const firstPoolStage = getFirstPoolPlayStage(formatDef);
    const pools = firstPoolStage
      ? await instantiatePools(id, formatDef, firstPoolStage.key, [], {
          clearTeamIds: true,
        })
      : [];
    const serializedPools = pools.map(serializePool);

    if (serializedPools.length > 0) {
      emitTournamentEventFromRequest(
        req,
        tournament.publicCode,
        TOURNAMENT_EVENT_TYPES.POOLS_UPDATED,
        {
          phase: resolvePoolPhase(formatDef, firstPoolStage.key, firstPoolStage),
          stageKey: firstPoolStage.key,
          poolIds: serializedPools.map((pool) => pool._id).filter(Boolean),
        }
      );
    }

    await syncSchedulePlan({
      tournamentId: id,
      actorUserId: req.user.id,
      io: req.app?.get('io'),
      emitEvents: true,
    });

    const persistedTournament = await Tournament.findById(id)
      .select('name date timezone status facilities settings.schedule settings.format settings.venue publicCode')
      .lean();
    const tournamentWithDefaults = attachTournamentScheduleDefaults(persistedTournament, {
      teamCount,
    });

    return res.json({
      tournament: tournamentWithDefaults,
      format: {
        id: formatDef.id,
        name: formatDef.name,
      },
      teamCount,
      totalCourts,
      activeCourts,
      venue: tournamentWithDefaults?.settings?.venue || currentVenueState.venue,
      pools: serializedPools,
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/venue -> tournament-admin venue configuration
router.get('/:id/venue', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const adminContext = await requireTournamentAdminContext(
      id,
      req.user.id,
      'settings.format settings.venue facilities'
    );
    const tournament = adminContext?.tournament || null;
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const venueState = resolveTournamentVenueState(tournament);
    const existingVenueCount = countVenueCourts(
      normalizeVenueFacilities(tournament?.settings?.venue?.facilities)
    );

    if (existingVenueCount === 0) {
      await Tournament.updateOne(
        { _id: id },
        {
          $set: {
            'settings.format.totalCourts': venueState.totalCourts,
            'settings.venue': venueState.venue,
            'settings.format.activeCourts': venueToLegacyCourtNames(venueState.venue, {
              enabledOnly: true,
            }),
          },
        }
      );
    }

    return res.json({
      totalCourts: venueState.totalCourts,
      venue: venueState.venue,
    });
  } catch (error) {
    return next(error);
  }
});

// PUT /api/tournaments/:id/venue -> tournament-admin venue configuration update
router.put('/:id/venue', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const rawFacilities = req.body?.facilities;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    if (!Array.isArray(rawFacilities)) {
      return res.status(400).json({ message: 'facilities must be an array' });
    }

    if (rawFacilities.length === 0) {
      return res.status(400).json({ message: 'At least one facility is required' });
    }

    const facilities = normalizeVenueFacilities(rawFacilities);

    const adminContext = await requireTournamentAdminContext(
      id,
      req.user.id,
      'settings.format settings.venue facilities publicCode'
    );
    const tournament = adminContext?.tournament || null;
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const formatSettings =
      tournament?.settings?.format && typeof tournament.settings.format === 'object'
        ? tournament.settings.format
        : {};
    const expectedTotalCourts = resolveFormatTotalCourts({
      formatSettings,
      availableCourts: flattenFacilityCourts(tournament?.facilities),
      venueFacilities: normalizeVenueFacilities(tournament?.settings?.venue?.facilities),
    });
    const configuredCourtCount = countVenueCourts(facilities);

    if (configuredCourtCount !== expectedTotalCourts) {
      return res.status(400).json({
        message: `Configured courts (${configuredCourtCount}) must equal format totalCourts (${expectedTotalCourts})`,
      });
    }

    const venue = { facilities };
    const activeCourts = venueToLegacyCourtNames(venue, { enabledOnly: true });

    await Tournament.updateOne(
      { _id: id },
      {
        $set: {
          'settings.venue': venue,
          'settings.format.totalCourts': expectedTotalCourts,
          'settings.format.activeCourts': activeCourts,
        },
      }
    );

    return res.json({
      totalCourts: expectedTotalCourts,
      venue,
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/stages/:stageKey/pools -> list pools for a format stage
router.get('/:id/stages/:stageKey/pools', requireAuth, async (req, res, next) => {
  try {
    const { id, stageKey } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    if (!isNonEmptyString(stageKey)) {
      return res.status(400).json({ message: 'stageKey is required' });
    }

    const ownedContext = await getOwnedTournamentAndTeamCount(
      id,
      req.user.id,
      'settings facilities'
    );

    if (!ownedContext) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const formatContext = getTournamentFormatContext(
      ownedContext.tournament,
      ownedContext.teamCount
    );

    if (!formatContext.formatDef) {
      return res.status(400).json({ message: 'No tournament format has been applied yet' });
    }

    const stageDef = resolveStage(formatContext.formatDef, stageKey.trim());

    if (!stageDef) {
      return res.status(404).json({ message: 'Unknown stageKey for current format' });
    }

    if (stageDef.type !== 'poolPlay') {
      return res.status(400).json({
        message: `Stage ${stageDef.key} does not define pools`,
      });
    }

    const phase = resolvePoolPhase(formatContext.formatDef, stageDef.key, stageDef);
    const stagePoolNames = Array.isArray(stageDef.pools)
      ? stageDef.pools.map((poolDef) => poolDef.name).filter(Boolean)
      : [];
    const pools = await Pool.find({
      tournamentId: id,
      phase,
      name: { $in: stagePoolNames },
      $or: [{ stageKey: stageDef.key }, { stageKey: null }, { stageKey: { $exists: false } }],
    })
      .populate('teamIds', 'name shortName logoUrl orderIndex seed')
      .lean();
    const orderLookup = new Map(stagePoolNames.map((poolName, index) => [poolName, index]));

    return res.json(
      pools
        .sort((left, right) => {
          const leftOrder = orderLookup.get(String(left?.name || '')) ?? Number.MAX_SAFE_INTEGER;
          const rightOrder =
            orderLookup.get(String(right?.name || '')) ?? Number.MAX_SAFE_INTEGER;
          if (leftOrder !== rightOrder) {
            return leftOrder - rightOrder;
          }
          return String(left?.name || '').localeCompare(String(right?.name || ''));
        })
        .map(serializePool)
    );
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/stages/:stageKey/matches -> list matches for a format stage
router.get('/:id/stages/:stageKey/matches', requireAuth, async (req, res, next) => {
  try {
    const { id, stageKey } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    if (!isNonEmptyString(stageKey)) {
      return res.status(400).json({ message: 'stageKey is required' });
    }

    const ownedContext = await getOwnedTournamentAndTeamCount(
      id,
      req.user.id,
      'settings facilities'
    );

    if (!ownedContext) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const formatContext = getTournamentFormatContext(
      ownedContext.tournament,
      ownedContext.teamCount
    );

    if (!formatContext.formatDef) {
      return res.status(400).json({ message: 'No tournament format has been applied yet' });
    }

    const stageDef = resolveStage(formatContext.formatDef, stageKey.trim());

    if (!stageDef) {
      return res.status(404).json({ message: 'Unknown stageKey for current format' });
    }

    const stageMatchQuery = buildMatchQueryForStage(id, formatContext.formatDef, stageDef);
    const matches = await loadMatchesForResponse(stageMatchQuery);

    return res.json(matches);
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments/:id/stages/:stageKey/pools/init -> create pool skeletons for a stage
router.post('/:id/stages/:stageKey/pools/init', requireAuth, async (req, res, next) => {
  try {
    const { id, stageKey } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    if (!isNonEmptyString(stageKey)) {
      return res.status(400).json({ message: 'stageKey is required' });
    }

    const ownedContext = await getOwnedTournamentAndTeamCount(
      id,
      req.user.id,
      'publicCode status settings facilities'
    );

    if (!ownedContext) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const { tournament, teamCount } = ownedContext;
    const formatContext = getTournamentFormatContext(tournament, teamCount);

    if (!formatContext.formatDef) {
      return res.status(400).json({ message: 'No tournament format has been applied yet' });
    }

    const stageDef = resolveStage(formatContext.formatDef, stageKey.trim());

    if (!stageDef) {
      return res.status(404).json({ message: 'Unknown stageKey for current format' });
    }

    if (stageDef.type !== 'poolPlay') {
      return res.status(400).json({
        message: `Stage ${stageDef.key} does not define pool skeletons`,
      });
    }

    const forceInit = parseBooleanFlag(req.query?.force, false);
    const pools = await instantiatePools(
      id,
      formatContext.formatDef,
      stageDef.key,
      [],
      {
        clearTeamIds: forceInit,
      }
    );

    const serializedPools = pools.map(serializePool);
    emitTournamentEventFromRequest(
      req,
      tournament.publicCode,
      TOURNAMENT_EVENT_TYPES.POOLS_UPDATED,
      {
        phase: resolvePoolPhase(formatContext.formatDef, stageDef.key, stageDef),
        stageKey: stageDef.key,
        poolIds: serializedPools.map((pool) => pool._id).filter(Boolean),
      }
    );

    return res.json(serializedPools);
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments/:id/stages/:stageKey/pools/autofill -> serpentine fill stage pools from team order
router.post('/:id/stages/:stageKey/pools/autofill', requireAuth, async (req, res, next) => {
  try {
    const { id, stageKey } = req.params;
    const normalizedStageKey = isNonEmptyString(stageKey) ? stageKey.trim() : '';

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    if (!normalizedStageKey) {
      return res.status(400).json({ message: 'stageKey is required' });
    }

    const ownedContext = await getOwnedTournamentAndTeamCount(
      id,
      req.user.id,
      'publicCode status settings facilities'
    );

    if (!ownedContext) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const { tournament, teamCount } = ownedContext;
    const formatContext = getTournamentFormatContext(tournament, teamCount);

    if (!formatContext.formatDef) {
      return res.status(400).json({ message: 'No tournament format has been applied yet' });
    }

    const stageDef = resolveStage(formatContext.formatDef, normalizedStageKey);

    if (!stageDef) {
      return res.status(404).json({ message: 'Unknown stageKey for current format' });
    }

    if (stageDef.type !== 'poolPlay') {
      return res.status(400).json({
        message: `Stage ${stageDef.key} is not a poolPlay stage`,
      });
    }

    const stagePoolNames = Array.isArray(stageDef.pools)
      ? stageDef.pools.map((poolDef) => String(poolDef?.name || '')).filter(Boolean)
      : [];

    if (stagePoolNames.length === 0) {
      return res.status(400).json({
        message: `Stage ${stageDef.key} has no pool definitions`,
      });
    }

    await instantiatePools(
      id,
      formatContext.formatDef,
      stageDef.key,
      [],
      { clearTeamIds: false }
    );

    const phase = resolvePoolPhase(formatContext.formatDef, stageDef.key, stageDef);
    const pools = await Pool.find({
      tournamentId: id,
      phase,
      name: { $in: stagePoolNames },
      $or: [{ stageKey: stageDef.key }, { stageKey: null }, { stageKey: { $exists: false } }],
    })
      .select('_id name requiredTeamCount teamIds')
      .lean();
    const poolByName = new Map(
      pools.map((pool) => [String(pool?.name || '').trim(), pool])
    );
    const orderedPools = stagePoolNames
      .map((poolName) => poolByName.get(poolName))
      .filter(Boolean);

    if (orderedPools.length === 0) {
      return res.status(404).json({
        message: `No pools found for stage ${stageDef.key}. Initialize pools first.`,
      });
    }

    const forceAutofill = parseBooleanFlag(req.query?.force ?? req.body?.force, false);
    const hasAnyAssignedTeams = orderedPools.some(
      (pool) => Array.isArray(pool?.teamIds) && pool.teamIds.length > 0
    );

    if (hasAnyAssignedTeams && !forceAutofill) {
      return res.status(409).json({
        message: `${stageDef.displayName || stageDef.key} pools already contain teams. Re-run with ?force=true to overwrite assignments.`,
      });
    }

    const teams = await TournamentTeam.find({ tournamentId: id })
      .select('_id name shortName orderIndex createdAt')
      .lean();
    teams.sort(compareTeamsByTournamentOrder);

    const stageAssignments = buildSerpentinePoolAssignments(teams, orderedPools);
    const writeOperations = stageAssignments
      .map((assignment) => {
        if (!assignment?.poolId || !isObjectId(assignment.poolId)) {
          return null;
        }

        const requiredTeamCount =
          Number.isFinite(Number(assignment.requiredTeamCount)) &&
          Number(assignment.requiredTeamCount) > 0
            ? Math.floor(Number(assignment.requiredTeamCount))
            : 3;
        const teamIds = Array.isArray(assignment.teamIds)
          ? assignment.teamIds.filter((teamId) => isObjectId(teamId))
          : [];

        return {
          updateOne: {
            filter: { _id: assignment.poolId },
            update: {
              $set: {
                stageKey: stageDef.key,
                requiredTeamCount,
                teamIds,
              },
            },
          },
        };
      })
      .filter(Boolean);

    if (writeOperations.length > 0) {
      await Pool.bulkWrite(writeOperations, { ordered: true });
    }

    const populatedPools = await Pool.find({
      tournamentId: id,
      phase,
      name: { $in: stagePoolNames },
      $or: [{ stageKey: stageDef.key }, { stageKey: null }, { stageKey: { $exists: false } }],
    })
      .populate('teamIds', 'name shortName logoUrl orderIndex seed')
      .lean();
    const populatedPoolByName = new Map(
      populatedPools.map((pool) => [String(pool?.name || '').trim(), pool])
    );
    const orderedSerializedPools = stagePoolNames
      .map((poolName) => populatedPoolByName.get(poolName))
      .filter(Boolean)
      .map(serializePool);

    emitTournamentEventFromRequest(
      req,
      tournament.publicCode,
      TOURNAMENT_EVENT_TYPES.POOLS_UPDATED,
      {
        phase,
        stageKey: stageDef.key,
        poolIds: orderedSerializedPools.map((pool) => pool._id).filter(Boolean),
      }
    );

    return res.json(orderedSerializedPools);
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments/:id/stages/:stageKey/matches/generate -> generate matches for a format stage
router.post('/:id/stages/:stageKey/matches/generate', requireAuth, async (req, res, next) => {
  try {
    const { id, stageKey } = req.params;
    const normalizedStageKey = isNonEmptyString(stageKey) ? stageKey.trim() : '';

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    if (!normalizedStageKey) {
      return res.status(400).json({ message: 'stageKey is required' });
    }

    const ownedContext = await getOwnedTournamentAndTeamCount(
      id,
      req.user.id,
      'publicCode status settings facilities standingsOverrides'
    );

    if (!ownedContext) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const { tournament, teamCount } = ownedContext;
    const formatContext = getTournamentFormatContext(tournament, teamCount);

    if (!formatContext.formatDef) {
      return res.status(400).json({ message: 'No tournament format has been applied yet' });
    }

    const stageDef = resolveStage(formatContext.formatDef, normalizedStageKey);

    if (!stageDef) {
      return res.status(404).json({ message: 'Unknown stageKey for current format' });
    }

    if (formatContext.formatDef.id === DEFAULT_15_TEAM_FORMAT_ID) {
      if (stageDef.key === 'poolPlay1') {
        return handleGenerateLegacyPhase1(req, res, next);
      }

      if (stageDef.key === 'poolPlay2') {
        return handleGenerateLegacyPhase2(req, res, next);
      }

      if (stageDef.key === 'playoffs') {
        return handleGenerateLegacyPlayoffs(req, res, next);
      }
    }

    const forceRegenerate = parseBooleanFlag(req.query?.force, false);
    const stageMatchQuery = buildMatchQueryForStage(id, formatContext.formatDef, stageDef);
    const existingMatch = await Match.findOne(stageMatchQuery).select('_id').lean();

    if (existingMatch && !forceRegenerate) {
      return res.status(409).json({
        message: `${stageDef.displayName || stageDef.key} matches already generated. Re-run with ?force=true to regenerate.`,
      });
    }

    if (forceRegenerate) {
      await deleteMatchesAndLinkedScoreboards(stageMatchQuery);
    }

    let generatedMatches;

    if (stageDef.type === 'poolPlay') {
      generatedMatches = await generatePoolPlayStageMatches({
        req,
        tournamentId: id,
        userId: req.user.id,
        tournament,
        formatDef: formatContext.formatDef,
        stageDef,
        activeCourts: formatContext.activeCourts,
      });
    } else if (stageDef.type === 'crossover') {
      generatedMatches = await generateCrossoverStageMatches({
        tournamentId: id,
        userId: req.user.id,
        tournament,
        formatDef: formatContext.formatDef,
        stageDef,
        activeCourts: formatContext.activeCourts,
      });
    } else if (stageDef.type === 'playoffs') {
      generatedMatches = await generateGenericPlayoffStageMatches({
        tournamentId: id,
        userId: req.user.id,
        tournament,
        formatDef: formatContext.formatDef,
        stageDef,
        activeCourts: formatContext.activeCourts,
      });
    } else {
      return res.status(400).json({
        message: `Unsupported stage type: ${stageDef.type}`,
      });
    }

    emitTournamentEventFromRequest(
      req,
      tournament.publicCode,
      TOURNAMENT_EVENT_TYPES.MATCHES_GENERATED,
      {
        phase: resolvePoolPhase(formatContext.formatDef, stageDef.key, stageDef),
        stageKey: stageDef.key,
        matchIds: generatedMatches.map((match) => toIdString(match._id)).filter(Boolean),
      }
    );

    await syncSchedulePlan({
      tournamentId: id,
      actorUserId: req.user.id,
      io: req.app?.get('io'),
      emitEvents: true,
    });

    return res.status(201).json(generatedMatches);
  } catch (error) {
    if (
      error?.message &&
      /(must have exactly|missing|unknown|requires|unsupported|Unable|share the same|assigned|Wave scheduling)/i.test(
        error.message
      )
    ) {
      return res.status(400).json({ message: error.message });
    }

    return next(error);
  }
});

// POST /api/tournaments/:id/phase1/pools/init -> create phase1 pools A-E if needed
router.post('/:id/phase1/pools/init', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const adminContext = await requireTournamentAdminContext(id, req.user.id, 'publicCode');
    const tournament = adminContext?.tournament || null;
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const existingPools = await Pool.find({
      tournamentId: id,
      phase: 'phase1',
      name: { $in: PHASE1_POOL_NAMES },
    }).lean();

    const existingByName = new Map(existingPools.map((pool) => [pool.name, pool]));
    const writeOperations = [];

    PHASE1_POOL_NAMES.forEach((poolName) => {
      const defaultHomeCourt = PHASE1_POOL_HOME_COURTS[poolName];
      const existingPool = existingByName.get(poolName);

      if (!existingPool) {
        writeOperations.push({
          insertOne: {
            document: {
              tournamentId: id,
              phase: 'phase1',
              stageKey: 'poolPlay1',
              name: poolName,
              requiredTeamCount: 3,
              teamIds: [],
              homeCourt: defaultHomeCourt,
            },
          },
        });
        return;
      }

      if (
        !isValidHomeCourt(existingPool.homeCourt) ||
        existingPool.stageKey !== 'poolPlay1' ||
        Number(existingPool.requiredTeamCount) !== 3
      ) {
        writeOperations.push({
          updateOne: {
            filter: { _id: existingPool._id },
            update: {
              $set: {
                stageKey: 'poolPlay1',
                requiredTeamCount: 3,
                homeCourt: defaultHomeCourt,
              },
            },
          },
        });
      }
    });

    if (writeOperations.length > 0) {
      await Pool.bulkWrite(writeOperations, { ordered: true });
    }

    const pools = await loadPhase1Pools(id, { populateTeams: true });
    emitTournamentEventFromRequest(
      req,
      tournament.publicCode,
      TOURNAMENT_EVENT_TYPES.POOLS_UPDATED,
      {
        phase: 'phase1',
        poolIds: pools.map((pool) => toIdString(pool._id)).filter(Boolean),
      }
    );
    return res.json(pools.map(serializePool));
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments/:id/phase1/pools/autofill -> serpentine fill pools from team order
router.post('/:id/phase1/pools/autofill', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const adminContext = await requireTournamentAdminContext(id, req.user.id, 'publicCode');
    const tournament = adminContext?.tournament || null;
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const forceAutofill = parseBooleanFlag(req.query?.force ?? req.body?.force, false);

    const existingPools = await Pool.find({
      tournamentId: id,
      phase: 'phase1',
      name: { $in: PHASE1_POOL_NAMES },
    })
      .select('_id name teamIds homeCourt')
      .lean();
    const existingByName = new Map(existingPools.map((pool) => [pool.name, pool]));
    const ensurePoolOperations = [];

    PHASE1_POOL_NAMES.forEach((poolName) => {
      const defaultHomeCourt = PHASE1_POOL_HOME_COURTS[poolName];
      const existingPool = existingByName.get(poolName);

      if (!existingPool) {
        ensurePoolOperations.push({
          insertOne: {
            document: {
              tournamentId: id,
              phase: 'phase1',
              stageKey: 'poolPlay1',
              name: poolName,
              requiredTeamCount: 3,
              teamIds: [],
              homeCourt: defaultHomeCourt,
            },
          },
        });
        return;
      }

      if (
        !isValidHomeCourt(existingPool.homeCourt) ||
        existingPool.stageKey !== 'poolPlay1' ||
        Number(existingPool.requiredTeamCount) !== 3
      ) {
        ensurePoolOperations.push({
          updateOne: {
            filter: { _id: existingPool._id },
            update: {
              $set: {
                stageKey: 'poolPlay1',
                requiredTeamCount: 3,
                homeCourt: defaultHomeCourt,
              },
            },
          },
        });
      }
    });

    if (ensurePoolOperations.length > 0) {
      await Pool.bulkWrite(ensurePoolOperations, { ordered: true });
    }

    const phase1Pools = await Pool.find({
      tournamentId: id,
      phase: 'phase1',
      name: { $in: PHASE1_POOL_NAMES },
    })
      .select('_id name teamIds homeCourt')
      .lean();
    const poolsByName = new Map(phase1Pools.map((pool) => [pool.name, pool]));

    const hasAnyAssignedTeams = PHASE1_POOL_NAMES.some((poolName) => {
      const pool = poolsByName.get(poolName);
      return Array.isArray(pool?.teamIds) && pool.teamIds.length > 0;
    });

    if (hasAnyAssignedTeams && !forceAutofill) {
      return res.status(409).json({
        message:
          'Phase 1 pools already contain teams. Re-run with ?force=true to overwrite assignments.',
      });
    }

    const teams = await TournamentTeam.find({ tournamentId: id })
      .select('_id name shortName orderIndex createdAt')
      .lean();
    teams.sort(compareTeamsByTournamentOrder);

    const assignments = buildSerpentineAssignments(teams.slice(0, 15));
    const autofillUpdates = PHASE1_POOL_NAMES.map((poolName) => {
      const pool = poolsByName.get(poolName);
      if (!pool) {
        return null;
      }

      const defaultHomeCourt = PHASE1_POOL_HOME_COURTS[poolName];
      return {
        updateOne: {
          filter: { _id: pool._id },
          update: {
            $set: {
              stageKey: 'poolPlay1',
              requiredTeamCount: 3,
              teamIds: assignments[poolName] || [],
              homeCourt: isValidHomeCourt(pool.homeCourt) ? pool.homeCourt : defaultHomeCourt,
            },
          },
        },
      };
    }).filter(Boolean);

    if (autofillUpdates.length > 0) {
      await Pool.bulkWrite(autofillUpdates, { ordered: true });
    }

    const pools = await loadPhase1Pools(id, { populateTeams: true });
    emitTournamentEventFromRequest(
      req,
      tournament.publicCode,
      TOURNAMENT_EVENT_TYPES.POOLS_UPDATED,
      {
        phase: 'phase1',
        poolIds: pools.map((pool) => toIdString(pool._id)).filter(Boolean),
      }
    );
    return res.json(pools.map(serializePool));
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/phase1/pools -> list phase1 pools for an accessible tournament
router.get('/:id/phase1/pools', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const adminContext = await requireTournamentAdminContext(id, req.user.id, 'publicCode');
    const tournament = adminContext?.tournament || null;
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const pools = await loadPhase1Pools(id, { populateTeams: true });
    return res.json(pools.map(serializePool));
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/phase2/pools -> list phase2 pools for an accessible tournament
router.get('/:id/phase2/pools', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const adminContext = await requireTournamentAdminContext(id, req.user.id, 'publicCode');
    const tournament = adminContext?.tournament || null;
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const pools = await loadPhase2Pools(id, { populateTeams: true });
    return res.json(pools.map(serializePool));
  } catch (error) {
    return next(error);
  }
});

// PUT /api/tournaments/:id/pools/courts -> tournament-admin court assignments per phase
router.put('/:id/pools/courts', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const phase = typeof req.body?.phase === 'string' ? req.body.phase.trim().toLowerCase() : '';
    const rawAssignments = req.body?.assignments;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    if (!POOL_PHASES.includes(phase)) {
      return res.status(400).json({ message: 'phase must be phase1 or phase2' });
    }

    if (!Array.isArray(rawAssignments)) {
      return res.status(400).json({ message: 'assignments must be an array' });
    }

    const adminContext = await requireTournamentAdminContext(id, req.user.id, 'publicCode');
    const tournament = adminContext?.tournament || null;
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const phasePoolNames = getPoolNamesForPhase(phase);

    if (rawAssignments.length !== phasePoolNames.length) {
      return res.status(400).json({
        message: `${PHASE_LABELS[phase]} requires assignments for exactly ${phasePoolNames.length} pools`,
      });
    }

    const existingMatch = await hasAnyMatchesForPhase(id, phase);

    if (existingMatch) {
      return res.status(409).json({
        message: 'Court assignments locked after match generation. Use force-regenerate to change.',
      });
    }

    const parsedAssignments = rawAssignments.map((entry, index) => {
      const poolId = toIdString(entry?.poolId);
      const homeCourt = normalizeCourtCode(entry?.homeCourt);

      if (!poolId || !isObjectId(poolId)) {
        throw new Error(`assignments[${index}].poolId must be a valid id`);
      }

      if (!isValidHomeCourt(homeCourt)) {
        throw new Error(`assignments[${index}].homeCourt must be one of ${PHASE1_COURT_ORDER.join(', ')}`);
      }

      return {
        poolId,
        homeCourt,
      };
    });

    const poolIds = parsedAssignments.map((assignment) => assignment.poolId);

    if (new Set(poolIds).size !== poolIds.length) {
      return res.status(400).json({ message: 'assignments includes duplicate poolId values' });
    }

    const homeCourts = parsedAssignments.map((assignment) => assignment.homeCourt);

    if (new Set(homeCourts).size !== homeCourts.length) {
      return res.status(400).json({ message: 'Each pool must be assigned to a unique court' });
    }

    const pools = await Pool.find({
      tournamentId: id,
      phase,
      _id: { $in: poolIds },
    })
      .select('_id name')
      .lean();

    if (pools.length !== phasePoolNames.length) {
      return res.status(400).json({
        message: `assignments must reference all ${PHASE_LABELS[phase]} pools`,
      });
    }

    const poolNamesInPayload = new Set(pools.map((pool) => pool.name));

    if (
      phasePoolNames.some((poolName) => !poolNamesInPayload.has(poolName)) ||
      poolNamesInPayload.size !== phasePoolNames.length
    ) {
      return res.status(400).json({
        message: `assignments must include every ${PHASE_LABELS[phase]} pool exactly once`,
      });
    }

    await Pool.bulkWrite(
      parsedAssignments.map((assignment) => ({
        updateOne: {
          filter: { _id: assignment.poolId },
          update: {
            $set: {
              homeCourt: assignment.homeCourt,
            },
          },
        },
      })),
      { ordered: true }
    );

    const updatedPools =
      phase === 'phase1'
        ? await loadPhase1Pools(id, { populateTeams: true })
        : await loadPhase2Pools(id, { populateTeams: true });

    emitTournamentEventFromRequest(
      req,
      tournament.publicCode,
      TOURNAMENT_EVENT_TYPES.POOLS_UPDATED,
      {
        phase,
        poolIds: updatedPools.map((pool) => toIdString(pool._id)).filter(Boolean),
      }
    );

    return res.json(updatedPools.map(serializePool));
  } catch (error) {
    if (error instanceof Error && /^assignments\[\d+\]\./.test(error.message || '')) {
      return res.status(400).json({ message: error.message });
    }

    return next(error);
  }
});

// POST /api/tournaments/:id/phase2/pools/generate -> generate/update phase2 pools from phase1 results
router.post('/:id/phase2/pools/generate', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const adminContext = await requireTournamentAdminContext(id, req.user.id, 'publicCode');
    const tournament = adminContext?.tournament || null;
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const forceRegenerate = parseBooleanFlag(req.query?.force, false);

    const [existingPhase2Pools, existingPhase2Matches] = await Promise.all([
      Pool.find({
        tournamentId: id,
        phase: 'phase2',
        name: { $in: PHASE2_POOL_NAMES },
      })
        .select('_id name')
        .lean(),
      Match.find({
        tournamentId: id,
        phase: 'phase2',
      })
        .select('_id')
        .limit(1)
        .lean(),
    ]);

    if (existingPhase2Matches.length > 0 && !forceRegenerate) {
      const poolsPrefix =
        existingPhase2Pools.length > 0 ? 'pools already exist and ' : '';
      return res.status(409).json({
        message:
          `Phase 2 ${poolsPrefix}matches have been generated. Re-run with ?force=true to overwrite pools.`,
      });
    }

    const generation = await buildPhase2PoolsFromPhase1Results(id);

    if (!generation.ok) {
      return res.status(400).json({
        message: 'Phase 2 pools cannot be generated yet',
        missing: generation.missing || [],
      });
    }

    await Pool.bulkWrite(
      generation.pools.map((pool) => ({
        updateOne: {
          filter: { tournamentId: id, phase: 'phase2', name: pool.name },
          update: {
            $set: {
              stageKey: 'poolPlay2',
              requiredTeamCount: 3,
              teamIds: pool.teamIds,
              homeCourt: pool.homeCourt,
              rematchWarnings: pool.rematchWarnings,
            },
          },
          upsert: true,
        },
      })),
      { ordered: true }
    );

    await ensureTournamentStatusAtLeast(id, 'phase2');

    const pools = await loadPhase2Pools(id, { populateTeams: true });
    emitTournamentEventFromRequest(
      req,
      tournament.publicCode,
      TOURNAMENT_EVENT_TYPES.POOLS_UPDATED,
      {
        phase: 'phase2',
        poolIds: pools.map((pool) => toIdString(pool._id)).filter(Boolean),
      }
    );
    return res.json({
      source: generation.source,
      pools: pools.map(serializePool),
    });
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments/:id/generate/phase1 -> generate 15 phase1 matches + scoreboards
async function handleGenerateLegacyPhase1(req, res, next) {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const adminContext = await requireTournamentAdminContext(
      id,
      req.user.id,
      'settings status publicCode'
    );
    const tournament = adminContext?.tournament || null;
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const pools = await Pool.find({
      tournamentId: id,
      phase: 'phase1',
      name: { $in: PHASE1_POOL_NAMES },
    })
      .select('_id name teamIds homeCourt')
      .lean();

    const poolValidationError = validatePhase1PoolsForGeneration(pools);

    if (poolValidationError) {
      return res.status(400).json({ message: poolValidationError });
    }

    const forceRegenerate = parseBooleanFlag(req.query?.force, false);

    const existingPhase1Matches = await Match.find({
      tournamentId: id,
      phase: 'phase1',
    })
      .select('_id scoreboardId')
      .lean();

    if (existingPhase1Matches.length > 0 && !forceRegenerate) {
      return res.status(409).json({
        message: 'Phase 1 matches already generated. Re-run with ?force=true to regenerate.',
      });
    }

    if (existingPhase1Matches.length > 0 && forceRegenerate) {
      const staleScoreboardIds = existingPhase1Matches
        .map((match) => match.scoreboardId)
        .filter(Boolean);

      await Match.deleteMany({
        _id: { $in: existingPhase1Matches.map((match) => match._id) },
      });

      if (staleScoreboardIds.length > 0) {
        await Scoreboard.deleteMany({
          _id: { $in: staleScoreboardIds },
        });
      }
    }

    const teamIds = [...new Set(pools.flatMap((pool) => pool.teamIds.map((teamId) => toIdString(teamId))))];
    const teams = await TournamentTeam.find({
      _id: { $in: teamIds },
      tournamentId: id,
    })
      .select('name shortName logoUrl seed')
      .lean();

    if (teams.length !== teamIds.length) {
      return res.status(400).json({ message: 'Phase 1 pools include teams outside this tournament' });
    }

    const teamsById = new Map(teams.map((team) => [team._id.toString(), team]));
    const poolsByName = new Map(pools.map((pool) => [pool.name, pool]));
    const scoring = normalizeScoringConfig(tournament?.settings?.scoring);
    const createdMatchIds = [];
    const createdScoreboardIds = [];

    try {
      for (const poolName of PHASE1_POOL_NAMES) {
        const pool = poolsByName.get(poolName);
        const orderedTeamIds = pool.teamIds.map((teamId) => toIdString(teamId));
        const homeCourt = normalizeCourtCode(pool.homeCourt);
        const facility = getFacilityFromCourt(homeCourt);

        if (!facility) {
          throw new Error(`Pool ${pool.name} has an invalid home court`);
        }

        for (const matchTemplate of PHASE1_MATCH_ORDER) {
          const teamAId = orderedTeamIds[matchTemplate.teamAIndex];
          const teamBId = orderedTeamIds[matchTemplate.teamBIndex];
          const refTeamId = orderedTeamIds[matchTemplate.refIndex];
          const teamA = teamsById.get(teamAId);
          const teamB = teamsById.get(teamBId);

          if (!teamA || !teamB) {
            throw new Error(`Missing team data for Pool ${pool.name}`);
          }

          const scoreboard = await createMatchScoreboard({
            ownerId: req.user.id,
            title: `Pool ${pool.name} - Round ${matchTemplate.roundBlock}`,
            teamA,
            teamB,
            scoring,
          });

          createdScoreboardIds.push(scoreboard._id);

          const match = await Match.create({
            tournamentId: id,
            phase: 'phase1',
            stageKey: 'poolPlay1',
            poolId: pool._id,
            roundBlock: matchTemplate.roundBlock,
            facility,
            court: homeCourt,
            teamAId,
            teamBId,
            refTeamIds: [refTeamId],
            scoreboardId: scoreboard._id,
            status: 'scheduled',
          });

          cacheTournamentMatchEntry({
            scoreboardId: scoreboard._id,
            matchId: match._id,
            tournamentCode: tournament.publicCode,
          });
          createdMatchIds.push(match._id);
        }
      }
    } catch (generationError) {
      if (createdMatchIds.length > 0) {
        await Match.deleteMany({ _id: { $in: createdMatchIds } });
      }

      if (createdScoreboardIds.length > 0) {
        await Scoreboard.deleteMany({ _id: { $in: createdScoreboardIds } });
      }

      throw generationError;
    }

    if (tournament.status === 'setup') {
      await Tournament.updateOne({ _id: id }, { $set: { status: 'phase1' } });
    }

    const matches = await loadMatchesForResponse({ _id: { $in: createdMatchIds } });
    emitTournamentEventFromRequest(
      req,
      tournament.publicCode,
      TOURNAMENT_EVENT_TYPES.MATCHES_GENERATED,
      {
        phase: 'phase1',
        matchIds: matches.map((match) => toIdString(match._id)).filter(Boolean),
      }
    );
    return res.status(201).json(matches);
  } catch (error) {
    return next(error);
  }
}

router.post('/:id/generate/phase1', requireAuth, handleGenerateLegacyPhase1);

// POST /api/tournaments/:id/generate/phase2 -> generate 15 phase2 matches + scoreboards
async function handleGenerateLegacyPhase2(req, res, next) {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const adminContext = await requireTournamentAdminContext(
      id,
      req.user.id,
      'settings status publicCode'
    );
    const tournament = adminContext?.tournament || null;
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const pools = await Pool.find({
      tournamentId: id,
      phase: 'phase2',
      name: { $in: PHASE2_POOL_NAMES },
    })
      .select('_id name teamIds homeCourt')
      .lean();

    const poolValidationError = validatePhase2PoolsForGeneration(pools);

    if (poolValidationError) {
      return res.status(400).json({ message: poolValidationError });
    }

    const forceRegenerate = parseBooleanFlag(req.query?.force, false);

    const existingPhase2Matches = await Match.find({
      tournamentId: id,
      phase: 'phase2',
    })
      .select('_id scoreboardId')
      .lean();

    if (existingPhase2Matches.length > 0 && !forceRegenerate) {
      return res.status(409).json({
        message: 'Phase 2 matches already generated. Re-run with ?force=true to regenerate.',
      });
    }

    if (existingPhase2Matches.length > 0 && forceRegenerate) {
      const staleScoreboardIds = existingPhase2Matches
        .map((match) => match.scoreboardId)
        .filter(Boolean);

      await Match.deleteMany({
        _id: { $in: existingPhase2Matches.map((match) => match._id) },
      });

      if (staleScoreboardIds.length > 0) {
        await Scoreboard.deleteMany({
          _id: { $in: staleScoreboardIds },
        });
      }
    }

    const teamIds = [...new Set(pools.flatMap((pool) => pool.teamIds.map((teamId) => toIdString(teamId))))];
    const teams = await TournamentTeam.find({
      _id: { $in: teamIds },
      tournamentId: id,
    })
      .select('name shortName logoUrl seed')
      .lean();

    if (teams.length !== teamIds.length) {
      return res.status(400).json({ message: 'Phase 2 pools include teams outside this tournament' });
    }

    const teamsById = new Map(teams.map((team) => [team._id.toString(), team]));
    const poolsByName = new Map(pools.map((pool) => [pool.name, pool]));
    const scoring = normalizeScoringConfig(tournament?.settings?.scoring);
    const createdMatchIds = [];
    const createdScoreboardIds = [];

    try {
      for (const poolName of PHASE2_POOL_NAMES) {
        const pool = poolsByName.get(poolName);
        const orderedTeamIds = pool.teamIds.map((teamId) => toIdString(teamId));
        const homeCourt = normalizeCourtCode(pool.homeCourt);
        const facility = getFacilityFromCourt(homeCourt);

        if (!facility) {
          throw new Error(`Pool ${pool.name} has an invalid home court`);
        }

        for (const matchTemplate of PHASE2_MATCH_ORDER) {
          const teamAId = orderedTeamIds[matchTemplate.teamAIndex];
          const teamBId = orderedTeamIds[matchTemplate.teamBIndex];
          const refTeamId = orderedTeamIds[matchTemplate.refIndex];
          const teamA = teamsById.get(teamAId);
          const teamB = teamsById.get(teamBId);

          if (!teamA || !teamB) {
            throw new Error(`Missing team data for Pool ${pool.name}`);
          }

          const scoreboard = await createMatchScoreboard({
            ownerId: req.user.id,
            title: `Pool ${pool.name} - Round ${matchTemplate.roundBlock}`,
            teamA,
            teamB,
            scoring,
          });

          createdScoreboardIds.push(scoreboard._id);

          const match = await Match.create({
            tournamentId: id,
            phase: 'phase2',
            stageKey: 'poolPlay2',
            poolId: pool._id,
            roundBlock: matchTemplate.roundBlock,
            facility,
            court: homeCourt,
            teamAId,
            teamBId,
            refTeamIds: [refTeamId],
            scoreboardId: scoreboard._id,
            status: 'scheduled',
          });

          cacheTournamentMatchEntry({
            scoreboardId: scoreboard._id,
            matchId: match._id,
            tournamentCode: tournament.publicCode,
          });
          createdMatchIds.push(match._id);
        }
      }
    } catch (generationError) {
      if (createdMatchIds.length > 0) {
        await Match.deleteMany({ _id: { $in: createdMatchIds } });
      }

      if (createdScoreboardIds.length > 0) {
        await Scoreboard.deleteMany({ _id: { $in: createdScoreboardIds } });
      }

      throw generationError;
    }

    await ensureTournamentStatusAtLeast(id, 'phase2');

    const matches = await loadMatchesForResponse({ _id: { $in: createdMatchIds } });
    emitTournamentEventFromRequest(
      req,
      tournament.publicCode,
      TOURNAMENT_EVENT_TYPES.MATCHES_GENERATED,
      {
        phase: 'phase2',
        matchIds: matches.map((match) => toIdString(match._id)).filter(Boolean),
      }
    );
    return res.status(201).json(matches);
  } catch (error) {
    return next(error);
  }
}

router.post('/:id/generate/phase2', requireAuth, handleGenerateLegacyPhase2);

// POST /api/tournaments/:id/generate/playoffs -> generate Gold/Silver/Bronze playoff brackets
async function handleGenerateLegacyPlayoffs(req, res, next) {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const adminContext = await requireTournamentAdminContext(
      id,
      req.user.id,
      'settings status standingsOverrides publicCode'
    );
    const tournament = adminContext?.tournament || null;
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const forceRegenerate = parseBooleanFlag(req.query?.force, false);

    const existingPlayoffMatches = await Match.find({
      tournamentId: id,
      phase: 'playoffs',
    })
      .select('_id scoreboardId')
      .lean();

    if (existingPlayoffMatches.length > 0 && !forceRegenerate) {
      return res.status(409).json({
        message: 'Playoff matches already generated. Re-run with ?force=true to regenerate.',
      });
    }

    if (existingPlayoffMatches.length > 0 && forceRegenerate) {
      const staleScoreboardIds = existingPlayoffMatches
        .map((match) => match.scoreboardId)
        .filter(Boolean);

      await Match.deleteMany({
        _id: { $in: existingPlayoffMatches.map((match) => match._id) },
      });

      if (staleScoreboardIds.length > 0) {
        await Scoreboard.deleteMany({
          _id: { $in: staleScoreboardIds },
        });
      }
    }

    const ranking = await computePlayoffGenerationRanking(id);

    if (!ranking.ok) {
      return res.status(400).json({
        message: 'Playoffs cannot be generated yet',
        missing: ranking.missing,
        phase2: {
          totalMatches: ranking.phase2MatchCount,
          finalizedMatches: ranking.phase2FinalizedCount,
          allFinalized: ranking.phase2AllFinalized,
        },
      });
    }

    const seedAssignments = buildPlayoffSeedAssignments(ranking.cumulativeOverall);

    if (!seedAssignments.ok) {
      return res.status(400).json({
        message: 'Playoffs cannot be generated yet',
        missing: seedAssignments.missing,
      });
    }

    const playoffPlan = createPlayoffMatchPlan(seedAssignments.brackets);
    const scoring = normalizeScoringConfig(tournament?.settings?.scoring);
    const createdMatchIds = [];
    const createdScoreboardIds = [];
    const createdMatchesByKey = new Map();

    try {
      for (const plannedMatch of playoffPlan) {
        const teamAFromMatch = plannedMatch.teamAFromMatchKey
          ? createdMatchesByKey.get(plannedMatch.teamAFromMatchKey)
          : null;
        const teamBFromMatch = plannedMatch.teamBFromMatchKey
          ? createdMatchesByKey.get(plannedMatch.teamBFromMatchKey)
          : null;

        if (plannedMatch.teamAFromMatchKey && !teamAFromMatch) {
          throw new Error(`Missing dependency for ${plannedMatch.bracketMatchKey}: ${plannedMatch.teamAFromMatchKey}`);
        }
        if (plannedMatch.teamBFromMatchKey && !teamBFromMatch) {
          throw new Error(`Missing dependency for ${plannedMatch.bracketMatchKey}: ${plannedMatch.teamBFromMatchKey}`);
        }

        const scoreboard = await createScoreboard({
          ownerId: req.user.id,
          title: plannedMatch.title,
          teams: [{ name: plannedMatch.teamAName }, { name: plannedMatch.teamBName }],
          servingTeamIndex: null,
          temporary: false,
          scoring,
        });

        createdScoreboardIds.push(scoreboard._id);

        const match = await Match.create({
          tournamentId: id,
          phase: 'playoffs',
          stageKey: 'playoffs',
          poolId: null,
          bracket: plannedMatch.bracket,
          bracketRound: plannedMatch.bracketRound,
          bracketMatchKey: plannedMatch.bracketMatchKey,
          seedA: plannedMatch.seedA ?? null,
          seedB: plannedMatch.seedB ?? null,
          teamAFromMatchId: teamAFromMatch?._id || null,
          teamAFromSlot: plannedMatch.teamAFromSlot || null,
          teamBFromMatchId: teamBFromMatch?._id || null,
          teamBFromSlot: plannedMatch.teamBFromSlot || null,
          roundBlock: plannedMatch.roundBlock,
          facility: plannedMatch.facility,
          court: plannedMatch.court,
          teamAId: plannedMatch.teamAId || null,
          teamBId: plannedMatch.teamBId || null,
          refTeamIds: plannedMatch.refTeamIds || [],
          scoreboardId: scoreboard._id,
          status: 'scheduled',
        });

        cacheTournamentMatchEntry({
          scoreboardId: scoreboard._id,
          matchId: match._id,
          tournamentCode: tournament.publicCode,
        });
        createdMatchIds.push(match._id);
        createdMatchesByKey.set(plannedMatch.bracketMatchKey, match);
      }
    } catch (generationError) {
      if (createdMatchIds.length > 0) {
        await Match.deleteMany({ _id: { $in: createdMatchIds } });
      }

      if (createdScoreboardIds.length > 0) {
        await Scoreboard.deleteMany({ _id: { $in: createdScoreboardIds } });
      }

      throw generationError;
    }

    await Promise.all(
      PLAYOFF_BRACKETS.map((bracket) => recomputePlayoffBracketProgression(id, bracket))
    );

    await ensureTournamentStatusAtLeast(id, 'playoffs');

    const createdMatches = await loadMatchesForResponse({ _id: { $in: createdMatchIds } });
    const payload = buildLegacyPlayoffPayload(createdMatches);
    emitTournamentEventFromRequest(
      req,
      tournament.publicCode,
      TOURNAMENT_EVENT_TYPES.MATCHES_GENERATED,
      {
        phase: 'playoffs',
        matchIds: createdMatches.map((match) => toIdString(match._id)).filter(Boolean),
      }
    );
    PLAYOFF_BRACKETS.forEach((bracket) => {
      const affectedMatchIds = createdMatches
        .filter((match) => normalizeBracket(match.bracket) === bracket)
        .map((match) => toIdString(match._id))
        .filter(Boolean);

      emitTournamentEventFromRequest(
        req,
        tournament.publicCode,
        TOURNAMENT_EVENT_TYPES.PLAYOFFS_BRACKET_UPDATED,
        {
          bracket,
          affectedMatchIds,
        }
      );
    });

    return res.status(201).json({
      source: ranking.usedPhase2OverallOverride ? 'override' : 'finalized',
      seeds: seedAssignments.brackets,
      phase2: {
        totalMatches: ranking.phase2MatchCount,
        finalizedMatches: ranking.phase2FinalizedCount,
        allFinalized: ranking.phase2AllFinalized,
      },
      ...payload,
    });
  } catch (error) {
    return next(error);
  }
}

router.post('/:id/generate/playoffs', requireAuth, handleGenerateLegacyPlayoffs);

// GET /api/tournaments/:id/playoffs -> tournament-admin playoff bracket + ops schedule
router.get('/:id/playoffs', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const ownedContext = await getOwnedTournamentAndTeamCount(
      id,
      req.user.id,
      'settings facilities'
    );

    if (!ownedContext) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }
    const formatContext = getTournamentFormatContext(
      ownedContext.tournament,
      ownedContext.teamCount
    );
    const phaseLabels = buildPhaseLabelLookup(formatContext.formatDef);
    const stageDefinitions = buildStageDefinitionLookup(formatContext.formatDef);
    const stageLabels = buildStageLabelLookup(formatContext.formatDef);

    const playoffMatches = await loadMatchesForResponse({
      tournamentId: id,
      phase: 'playoffs',
    });
    let payload = buildFormatAwarePlayoffPayload(playoffMatches, formatContext.formatDef);
    const isLegacyFormat = formatContext.formatDef?.id === DEFAULT_15_TEAM_FORMAT_ID;
    if (!isLegacyFormat && (!Array.isArray(payload?.opsSchedule) || payload.opsSchedule.length === 0)) {
      const schedulePlanResult = await loadSchedulePlanSlotViews({
        tournament: ownedContext.tournament,
        formatContext,
        phaseLabels,
        stageDefinitions,
        stageLabels,
        stageKeysFilter: ['playoffs'],
        kindsFilter: ['match'],
        includeLegacyFallback: false,
        io: req.app?.get('io'),
      });
      const fallbackOpsSchedule = buildPlayoffOpsScheduleFromSchedulePlanSlots(schedulePlanResult?.slots);
      if (fallbackOpsSchedule.length > 0) {
        payload = {
          ...payload,
          opsSchedule: fallbackOpsSchedule,
        };
      }
    }

    return res.json(payload);
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/playoffs/ops -> tournament-admin printable playoff ops schedule
router.get('/:id/playoffs/ops', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const ownedContext = await getOwnedTournamentAndTeamCount(
      id,
      req.user.id,
      'settings facilities'
    );

    if (!ownedContext) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }
    const formatContext = getTournamentFormatContext(
      ownedContext.tournament,
      ownedContext.teamCount
    );
    const phaseLabels = buildPhaseLabelLookup(formatContext.formatDef);
    const stageDefinitions = buildStageDefinitionLookup(formatContext.formatDef);
    const stageLabels = buildStageLabelLookup(formatContext.formatDef);

    const playoffMatches = await loadMatchesForResponse({
      tournamentId: id,
      phase: 'playoffs',
    });
    let payload = buildFormatAwarePlayoffPayload(playoffMatches, formatContext.formatDef);
    const isLegacyFormat = formatContext.formatDef?.id === DEFAULT_15_TEAM_FORMAT_ID;
    if (!isLegacyFormat && (!Array.isArray(payload?.opsSchedule) || payload.opsSchedule.length === 0)) {
      const schedulePlanResult = await loadSchedulePlanSlotViews({
        tournament: ownedContext.tournament,
        formatContext,
        phaseLabels,
        stageDefinitions,
        stageLabels,
        stageKeysFilter: ['playoffs'],
        kindsFilter: ['match'],
        includeLegacyFallback: false,
        io: req.app?.get('io'),
      });
      const fallbackOpsSchedule = buildPlayoffOpsScheduleFromSchedulePlanSlots(schedulePlanResult?.slots);
      if (fallbackOpsSchedule.length > 0) {
        payload = {
          ...payload,
          opsSchedule: fallbackOpsSchedule,
        };
      }
    }

    return res.json({
      roundBlocks: payload.opsSchedule,
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/schedule-plan -> tournament-admin schedulePlan slot views
router.get('/:id/schedule-plan', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const ownedContext = await getOwnedTournamentAndTeamCount(
      id,
      req.user.id,
      'timezone settings.schedule settings.schedulePlan settings.format settings.venue facilities'
    );

    if (!ownedContext) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const formatContext = getTournamentFormatContext(
      ownedContext.tournament,
      ownedContext.teamCount
    );
    const phaseLabels = buildPhaseLabelLookup(formatContext.formatDef);
    const stageDefinitions = buildStageDefinitionLookup(formatContext.formatDef);
    const stageLabels = buildStageLabelLookup(formatContext.formatDef);
    const includeLegacyFallback = parseBooleanFlag(req.query?.includeLegacyFallback, true);

    const schedulePlanResult = await loadSchedulePlanSlotViews({
      tournament: ownedContext.tournament,
      formatContext,
      phaseLabels,
      stageDefinitions,
      stageLabels,
      stageKeysFilter: req.query?.stageKeys,
      kindsFilter: req.query?.kinds,
      includeLegacyFallback,
      io: req.app?.get('io'),
    });

    return res.json({
      slots: Array.isArray(schedulePlanResult?.slots) ? schedulePlanResult.slots : [],
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/matches?phase=phase1|phase2|playoffs -> accessible tournament matches
router.get('/:id/matches', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const phaseError = validateMatchPhaseFilter(req.query?.phase);

    if (phaseError) {
      return res.status(400).json({ message: phaseError });
    }

    const ownedTournament = await ensureTournamentAdminAccess(id, req.user.id);

    if (!ownedTournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const query = { tournamentId: id };

    if (req.query?.phase) {
      query.phase = req.query.phase;
    }

    const matches = await loadMatchesForResponse(query);
    return res.json(matches);
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/standings?phase=phase1|phase2|cumulative -> accessible tournament standings
router.get('/:id/standings', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const phase = normalizeStandingsPhase(req.query?.phase);

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const phaseError = validateStandingsPhaseFilter(phase);

    if (phaseError) {
      return res.status(400).json({ message: phaseError });
    }

    const ownedTournament = await ensureTournamentAdminAccess(id, req.user.id);

    if (!ownedTournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const standings = await computeStandingsBundle(id, phase);

    return res.json({
      phase,
      basedOn: 'finalized',
      ...formatStandingsPayload(standings),
    });
  } catch (error) {
    return next(error);
  }
});

// PUT /api/tournaments/:id/standings-overrides -> tournament-admin tie/ordering overrides
router.put('/:id/standings-overrides', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const phase = normalizeStandingsPhase(req.body?.phase);
    const hasPoolOrder = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'poolOrder');
    const hasOverallOrder = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'overallOrder');
    const poolName = req.body?.poolName;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const phaseError = validateStandingsOverridePhaseFilter(phase);

    if (phaseError) {
      return res.status(400).json({ message: phaseError });
    }

    if (!hasPoolOrder && !hasOverallOrder) {
      return res.status(400).json({ message: 'Provide poolOrder and/or overallOrder' });
    }

    const poolOrder = hasPoolOrder ? normalizeTeamIdList(req.body?.poolOrder) : null;
    const overallOrder = hasOverallOrder ? normalizeTeamIdList(req.body?.overallOrder) : null;

    if (hasPoolOrder && !poolOrder) {
      return res.status(400).json({ message: 'poolOrder must be an array of team ids' });
    }

    if (hasOverallOrder && !overallOrder) {
      return res.status(400).json({ message: 'overallOrder must be an array of team ids' });
    }

    const adminContext = await requireTournamentAdminContext(id, req.user.id, '_id standingsOverrides');
    const tournament = adminContext?.tournament || null;
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const allTeams = await TournamentTeam.find({ tournamentId: id }).select('_id').lean();
    const allTeamIds = allTeams.map((team) => toIdString(team._id));
    const tournamentTeamIdSet = new Set(allTeamIds);

    const updates = {};

    if (hasPoolOrder) {
      if (!isNonEmptyString(poolName)) {
        return res.status(400).json({ message: 'poolName is required when setting poolOrder' });
      }

      if (poolOrder.some((teamId) => !isObjectId(teamId))) {
        return res.status(400).json({ message: 'poolOrder includes an invalid team id' });
      }

      if (!poolOrder.every((teamId) => tournamentTeamIdSet.has(teamId))) {
        return res.status(400).json({ message: 'poolOrder teams must belong to this tournament' });
      }

      const pool = await Pool.findOne({
        tournamentId: id,
        phase,
        name: poolName.trim(),
      })
        .select('teamIds name')
        .lean();

      if (!pool) {
        return res.status(404).json({ message: 'Pool not found for this phase' });
      }

      const poolTeamIds = Array.isArray(pool.teamIds)
        ? pool.teamIds.map((teamId) => toIdString(teamId)).filter(Boolean)
        : [];

      if (!isPermutation(poolOrder, poolTeamIds)) {
        return res.status(400).json({
          message: 'poolOrder must be a permutation of the teams assigned to that pool',
        });
      }

      updates[`standingsOverrides.${phase}.poolOrderOverrides.${pool.name}`] = poolOrder;
    }

    if (hasOverallOrder) {
      if (overallOrder.some((teamId) => !isObjectId(teamId))) {
        return res.status(400).json({ message: 'overallOrder includes an invalid team id' });
      }

      if (!overallOrder.every((teamId) => tournamentTeamIdSet.has(teamId))) {
        return res.status(400).json({ message: 'overallOrder teams must belong to this tournament' });
      }

      if (!isPermutation(overallOrder, allTeamIds)) {
        return res.status(400).json({
          message: 'overallOrder must be a permutation of all tournament teams',
        });
      }

      updates[`standingsOverrides.${phase}.overallOrderOverrides`] = overallOrder;
    }

    const updatedTournament = await Tournament.findOneAndUpdate(
      {
        _id: id,
      },
      { $set: updates },
      {
        new: true,
        runValidators: true,
        omitUndefined: true,
      }
    ).lean();

    return res.json({
      phase,
      overrides: serializePhaseOverrides(updatedTournament?.standingsOverrides?.[phase]),
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/access -> list owner/admin access and share-link metadata
router.get('/:id/access', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const accessContext = await getTournamentAccessContext(
      id,
      req.user.id,
      'name createdByUserId'
    );
    const tournament = accessContext?.tournament || null;

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const [ownerUser, adminAccessEntries, shareLink, pendingInvites] = await Promise.all([
      User.findById(tournament.createdByUserId).select('_id email displayName').lean(),
      listTournamentAdminAccessEntries(id),
      TournamentShareLink.findOne({ tournamentId: id }).lean(),
      accessContext.isOwner
        ? TournamentInvite.find({
            tournamentId: id,
            usedAt: null,
            expiresAt: { $gt: new Date() },
          })
            .sort({ createdAt: -1 })
            .lean()
        : Promise.resolve([]),
    ]);

    const owner = {
      ...serializeAccessUser(ownerUser, tournament.createdByUserId),
      role: 'owner',
    };

    const admins = adminAccessEntries
      .map(serializeAdminAccessRecord)
      .filter((entry) => entry.userId && entry.userId !== owner.userId);

    const hasShareToken = isNonEmptyString(shareLink?.token);
    const shareLinkPayload = {
      enabled: Boolean(shareLink?.enabled),
      role: shareLink?.role || TOURNAMENT_ADMIN_ROLE,
      hasLink: hasShareToken,
      joinPath:
        accessContext.isOwner && hasShareToken
          ? buildTournamentJoinPath(shareLink.token)
          : null,
      joinUrl:
        accessContext.isOwner && hasShareToken
          ? buildTournamentJoinUrl(shareLink.token)
          : null,
    };

    return res.json({
      tournamentId: toIdString(tournament._id),
      tournamentName: tournament.name || '',
      callerRole: accessContext.role,
      isOwner: Boolean(accessContext.isOwner),
      owner,
      admins,
      pendingInvites: accessContext.isOwner
        ? pendingInvites.map(serializePendingInviteRecord)
        : [],
      shareLink: shareLinkPayload,
    });
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments/:id/share/email -> owner invites an admin by email
router.post('/:id/share/email', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const role = typeof req.body?.role === 'string' ? req.body.role.trim().toLowerCase() : '';
    const normalizedRole = role || TOURNAMENT_ADMIN_ROLE;
    const email = normalizeEmail(req.body?.email);

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    if (normalizedRole !== TOURNAMENT_ADMIN_ROLE) {
      return res.status(400).json({ message: 'role must be admin' });
    }

    if (!email) {
      return res.status(400).json({ message: 'email is required' });
    }

    const ownerContext = await requireTournamentOwnerContext(id, req.user.id, 'name createdByUserId');
    const tournament = ownerContext?.tournament || null;
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const ownerUser = await User.findById(tournament.createdByUserId).select('_id email').lean();
    const ownerEmail = normalizeEmail(ownerUser?.email);
    if (ownerEmail && ownerEmail === email) {
      return res.status(400).json({ message: 'Owner already has access' });
    }

    const existingUser = await User.findOne({ email }).select('_id email displayName').lean();
    if (existingUser) {
      const existingAccess = await TournamentAccess.findOne({
        tournamentId: id,
        userId: existingUser._id,
        role: TOURNAMENT_ADMIN_ROLE,
      })
        .select('_id')
        .lean();

      const accessRecord = await upsertTournamentAdminAccess(id, existingUser._id);
      return res.json({
        granted: true,
        role: TOURNAMENT_ADMIN_ROLE,
        alreadyHadAccess: Boolean(existingAccess),
        user: serializeAccessUser(existingUser),
        accessId: toIdString(accessRecord?._id),
      });
    }

    const ttlHours = resolveInviteTtlHours();
    const { token, tokenHash, expiresAt } = createTokenPair(ttlHours * 60 * 60 * 1000);
    const invitePath = buildTournamentJoinPath(token, { invite: '1' });
    const inviteUrl = buildTournamentJoinUrl(token, { invite: '1' });

    await TournamentInvite.create({
      tournamentId: id,
      email,
      role: TOURNAMENT_ADMIN_ROLE,
      tokenHash,
      expiresAt,
      createdByUserId: req.user.id,
    });

    let emailDelivered = false;
    let emailError = null;

    if (isEmailConfigured()) {
      try {
        const inviterName = req.user.displayName || req.user.email || 'Tournament owner';
        const message = buildTournamentInviteEmail({
          displayName: '',
          inviterName,
          tournamentName: tournament.name || 'Tournament',
          joinUrl: inviteUrl,
        });

        const mailResult = await sendMail({
          to: email,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });

        emailDelivered = Boolean(mailResult?.delivered);
      } catch (error) {
        emailError = error?.message || 'Unable to send invite email';
      }
    }

    return res.status(201).json({
      invited: true,
      role: TOURNAMENT_ADMIN_ROLE,
      email,
      emailDelivered,
      emailError,
      invitePath,
      inviteUrl,
      expiresAt,
    });
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments/:id/share/link -> create or return active admin join link
router.post('/:id/share/link', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const ownerContext = await requireTournamentOwnerContext(id, req.user.id, '_id');
    if (!ownerContext?.tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    let shareLink = await TournamentShareLink.findOne({ tournamentId: id });

    if (shareLink && shareLink.enabled && isNonEmptyString(shareLink.token)) {
      return res.json({
        enabled: true,
        role: shareLink.role || TOURNAMENT_ADMIN_ROLE,
        joinPath: buildTournamentJoinPath(shareLink.token),
        joinUrl: buildTournamentJoinUrl(shareLink.token),
      });
    }

    if (!shareLink) {
      shareLink = new TournamentShareLink({
        tournamentId: id,
        role: TOURNAMENT_ADMIN_ROLE,
        enabled: true,
        createdByUserId: req.user.id,
      });
    } else {
      shareLink.role = TOURNAMENT_ADMIN_ROLE;
      shareLink.enabled = true;
      shareLink.createdByUserId = req.user.id;
    }

    await persistShareLinkWithUniqueToken(shareLink);

    return res.status(201).json({
      enabled: true,
      role: TOURNAMENT_ADMIN_ROLE,
      joinPath: buildTournamentJoinPath(shareLink.token),
      joinUrl: buildTournamentJoinUrl(shareLink.token),
    });
  } catch (error) {
    return next(error);
  }
});

// PATCH /api/tournaments/:id/share/link -> owner toggles share-link enabled state
router.patch('/:id/share/link', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { enabled } = req.body ?? {};

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ message: 'enabled must be a boolean' });
    }

    const ownerContext = await requireTournamentOwnerContext(id, req.user.id, '_id');
    if (!ownerContext?.tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    let shareLink = await TournamentShareLink.findOne({ tournamentId: id });

    if (!shareLink && !enabled) {
      return res.json({
        enabled: false,
        role: TOURNAMENT_ADMIN_ROLE,
        joinPath: null,
        joinUrl: null,
      });
    }

    if (!shareLink) {
      shareLink = new TournamentShareLink({
        tournamentId: id,
        role: TOURNAMENT_ADMIN_ROLE,
        enabled: true,
        createdByUserId: req.user.id,
      });
      await persistShareLinkWithUniqueToken(shareLink);
    }

    if (enabled) {
      if (!isNonEmptyString(shareLink.token)) {
        await persistShareLinkWithUniqueToken(shareLink);
      }
      shareLink.enabled = true;
      shareLink.role = TOURNAMENT_ADMIN_ROLE;
      shareLink.createdByUserId = req.user.id;
      await shareLink.save();
    } else {
      shareLink.enabled = false;
      await shareLink.save();
    }

    return res.json({
      enabled: Boolean(shareLink.enabled),
      role: shareLink.role || TOURNAMENT_ADMIN_ROLE,
      joinPath:
        shareLink.enabled && isNonEmptyString(shareLink.token)
          ? buildTournamentJoinPath(shareLink.token)
          : null,
      joinUrl:
        shareLink.enabled && isNonEmptyString(shareLink.token)
          ? buildTournamentJoinUrl(shareLink.token)
          : null,
    });
  } catch (error) {
    return next(error);
  }
});

// DELETE /api/tournaments/:id/access/:userId -> owner revokes an admin
router.delete('/:id/access/:userId', requireAuth, async (req, res, next) => {
  try {
    const { id, userId } = req.params;

    if (!isObjectId(id) || !isObjectId(userId)) {
      return res.status(400).json({ message: 'Invalid tournament id or user id' });
    }

    const ownerContext = await requireTournamentOwnerContext(id, req.user.id, 'createdByUserId');
    const tournament = ownerContext?.tournament || null;
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    if (toIdString(tournament.createdByUserId) === toIdString(userId)) {
      return res.status(400).json({ message: 'Owner access cannot be revoked' });
    }

    const result = await removeTournamentAdminAccess(id, userId);
    return res.json({
      revoked: result?.deletedCount > 0,
      userId: toIdString(userId),
    });
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments/:id/access/leave -> admin removes own access (owner cannot leave)
router.post('/:id/access/leave', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const accessContext = await getTournamentAccessContext(id, req.user.id, 'createdByUserId');
    const tournament = accessContext?.tournament || null;
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    if (accessContext.isOwner) {
      return res.status(400).json({ message: 'Owner cannot leave the tournament' });
    }

    await removeTournamentAdminAccess(id, req.user.id);
    return res.json({
      left: true,
      tournamentId: toIdString(id),
    });
  } catch (error) {
    return next(error);
  }
});

// PATCH /api/tournaments/:id/owner -> owner transfers ownership to another user
router.patch('/:id/owner', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const nextOwnerUserId = toIdString(req.body?.userId);

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    if (!isObjectId(nextOwnerUserId)) {
      return res.status(400).json({ message: 'userId is required' });
    }

    const ownerContext = await requireTournamentOwnerContext(id, req.user.id, '_id createdByUserId');
    if (!ownerContext?.tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const nextOwner = await User.findById(nextOwnerUserId).select('_id email displayName').lean();
    if (!nextOwner) {
      return res.status(404).json({ message: 'Target user not found' });
    }

    const transferred = await transferTournamentOwnership({
      tournamentId: id,
      currentOwnerUserId: req.user.id,
      nextOwnerUserId,
    });

    if (!transferred) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const previousOwner = await User.findById(req.user.id).select('_id email displayName').lean();

    return res.json({
      transferred: true,
      tournamentId: toIdString(id),
      owner: {
        ...serializeAccessUser(nextOwner),
        role: 'owner',
      },
      previousOwner: {
        ...serializeAccessUser(previousOwner, req.user.id),
        role: TOURNAMENT_ADMIN_ROLE,
      },
    });
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments/join -> join via enabled share-link token
router.post('/join', requireAuth, async (req, res, next) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token) {
      return res.status(400).json({ message: 'token is required' });
    }

    const shareLink = await TournamentShareLink.findOne({
      token,
      enabled: true,
      role: TOURNAMENT_ADMIN_ROLE,
    })
      .select('tournamentId role enabled')
      .lean();

    if (!shareLink) {
      return res.status(400).json({ message: 'Share link is invalid or disabled' });
    }

    await upsertTournamentAdminAccess(shareLink.tournamentId, req.user.id);
    const accessContext = await getTournamentAccessContext(shareLink.tournamentId, req.user.id);

    return res.json({
      joined: true,
      tournamentId: toIdString(shareLink.tournamentId),
      role: accessContext?.role || TOURNAMENT_ADMIN_ROLE,
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id -> fetch tournament details and basic counts
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const adminContext = await getTournamentAccessContext(
      id,
      req.user.id,
      'name date timezone status details facilities settings.schedule settings.format settings.venue'
    );
    const tournament = adminContext?.tournament || null;
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const [teamsCount, poolsCount, matchesCount] = await Promise.all([
      TournamentTeam.countDocuments({ tournamentId: id }),
      Pool.countDocuments({ tournamentId: id }),
      Match.countDocuments({ tournamentId: id }),
    ]);

    return res.json({
      ...attachTournamentScheduleDefaults(tournament, { teamCount: teamsCount }),
      accessRole: adminContext.role,
      isOwner: Boolean(adminContext.isOwner),
      teamsCount,
      poolsCount,
      matchesCount,
    });
  } catch (error) {
    return next(error);
  }
});

// POST /api/tournaments/:id/teams -> create one or many tournament teams
router.post('/:id/teams', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const ownedTournament = await ensureTournamentAdminAccess(id, req.user.id);

    if (!ownedTournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const rawTeams = Array.isArray(req.body) ? req.body : [req.body];

    if (!rawTeams.length) {
      return res.status(400).json({ message: 'At least one team payload is required' });
    }

    for (let index = 0; index < rawTeams.length; index += 1) {
      const validationError = validateTeamPayload(rawTeams[index], index);

      if (validationError) {
        return res.status(400).json({ message: validationError });
      }
    }

    const existingTeams = await TournamentTeam.find({ tournamentId: id })
      .select('_id orderIndex createdAt name shortName')
      .lean();
    const maxExistingOrderIndex = existingTeams.reduce((maxValue, team) => {
      const normalized = normalizeTeamOrderIndex(team?.orderIndex);
      if (normalized === null) {
        return maxValue;
      }

      return Math.max(maxValue, normalized);
    }, 0);

    let nextOrderIndex =
      maxExistingOrderIndex > 0 ? maxExistingOrderIndex + 1 : existingTeams.length + 1;
    const reservedCodes = new Set();
    const payload = [];

    for (const team of rawTeams) {
      const publicTeamCode = await createUniqueTeamPublicCode(TournamentTeam, id, {
        reservedCodes,
      });
      reservedCodes.add(publicTeamCode);
      const teamPayload = buildTeamInsertPayload(team, id, nextOrderIndex, publicTeamCode);
      nextOrderIndex += 1;
      payload.push(teamPayload);
    }

    if (Array.isArray(req.body)) {
      const createdTeams = await TournamentTeam.insertMany(payload, { ordered: true });
      return res.status(201).json(createdTeams.map((team) => team.toObject()));
    }

    const createdTeam = await TournamentTeam.create(payload[0]);
    return res.status(201).json(createdTeam.toObject());
  } catch (error) {
    return next(error);
  }
});

// PUT /api/tournaments/:id/teams/order -> update tournament team order indices
router.put('/:id/teams/order', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const ownedTournament = await ensureTournamentAdminAccess(id, req.user.id);

    if (!ownedTournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    if (!Array.isArray(req.body?.orderedTeamIds)) {
      return res.status(400).json({ message: 'orderedTeamIds must be an array of team ids' });
    }

    const orderedTeamIds = req.body.orderedTeamIds.map((teamId) => toIdString(teamId)).filter(Boolean);

    if (orderedTeamIds.some((teamId) => !isObjectId(teamId))) {
      return res.status(400).json({ message: 'orderedTeamIds includes an invalid team id' });
    }

    const tournamentTeams = await TournamentTeam.find({ tournamentId: id })
      .select('_id')
      .lean();
    const tournamentTeamIds = tournamentTeams.map((team) => toIdString(team._id)).filter(Boolean);

    if (!isPermutation(orderedTeamIds, tournamentTeamIds)) {
      return res.status(400).json({
        message: 'orderedTeamIds must be a permutation of all tournament team ids',
      });
    }

    const writeOperations = orderedTeamIds.map((teamId, index) => ({
      updateOne: {
        filter: { _id: teamId, tournamentId: id },
        update: { $set: { orderIndex: index + 1 } },
      },
    }));

    if (writeOperations.length > 0) {
      await TournamentTeam.bulkWrite(writeOperations, { ordered: true });
    }

    const teams = await TournamentTeam.find({ tournamentId: id }).lean();
    teams.sort(compareTeamsByTournamentOrder);
    return res.json(teams);
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/teams/links -> list relative team public links for accessible tournament
router.get('/:id/teams/links', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const adminContext = await requireTournamentAdminContext(id, req.user.id, 'publicCode');
    const tournament = adminContext?.tournament || null;
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const teams = await ensureTournamentTeamPublicCodes(id);

    return res.json(
      teams.map((team) => {
        const teamCode = normalizeTeamPublicCode(team.publicTeamCode);
        return {
          teamId: toIdString(team._id),
          shortName: team.shortName || team.name || 'TBD',
          publicTeamCode: teamCode,
          teamLinkUrl: `/t/${tournament.publicCode}/team/${teamCode}`,
        };
      })
    );
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/teams -> list teams for an accessible tournament
router.get('/:id/teams', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const ownedTournament = await ensureTournamentAdminAccess(id, req.user.id);

    if (!ownedTournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const teams = await TournamentTeam.find({ tournamentId: id }).lean();
    teams.sort(compareTeamsByTournamentOrder);

    return res.json(teams);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

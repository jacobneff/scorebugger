const express = require('express');
const mongoose = require('mongoose');

const Tournament = require('../models/Tournament');
const TournamentTeam = require('../models/TournamentTeam');
const Pool = require('../models/Pool');
const Match = require('../models/Match');
const Scoreboard = require('../models/Scoreboard');
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
  scheduleStageMatches,
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

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

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
  const parsedRoundBlock = Number(roundBlock);

  if (!Number.isFinite(parsedRoundBlock)) {
    return '';
  }

  const schedule = normalizeTournamentSchedule(tournament?.settings?.schedule);
  const dayStartMinutes = parseClockTimeToMinutes(schedule.dayStartTime);
  const timeIndex = Math.max(0, Math.floor(parsedRoundBlock) - 1);
  const minutesSinceMidnight = dayStartMinutes + timeIndex * schedule.matchDurationMinutes;
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
  const normalizedActiveCourtsResult = normalizeActiveCourtsSelection({
    requestedActiveCourts: formatSettings.activeCourts,
    availableCourts,
  });
  const activeCourts =
    normalizedActiveCourtsResult.ok && normalizedActiveCourtsResult.activeCourts.length > 0
      ? normalizedActiveCourtsResult.activeCourts
      : availableCourts;
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
        activeCourts,
      },
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

async function ensureTournamentOwnership(tournamentId, userId) {
  return Tournament.exists({
    _id: tournamentId,
    createdByUserId: userId,
  });
}

function getTournamentFormatContext(tournament, teamCount) {
  const availableCourts = flattenFacilityCourts(tournament?.facilities);
  const explicitFormatId = tournament?.settings?.format?.formatId;
  const formatId = resolveDefaultFormatId({
    explicitFormatId,
    teamCount,
  });
  const activeCourtsResult = normalizeActiveCourtsSelection({
    requestedActiveCourts: tournament?.settings?.format?.activeCourts,
    availableCourts,
  });
  const activeCourts =
    activeCourtsResult.ok && activeCourtsResult.activeCourts.length > 0
      ? activeCourtsResult.activeCourts
      : availableCourts;
  const formatDef = formatId ? getFormat(formatId) : null;

  return {
    formatId,
    formatDef,
    availableCourts,
    activeCourts,
  };
}

async function getOwnedTournamentAndTeamCount(tournamentId, userId, projection = '') {
  const tournament = await Tournament.findOne({
    _id: tournamentId,
    createdByUserId: userId,
  })
    .select(projection || 'settings facilities publicCode status standingsOverrides')
    .lean();

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
  const pool = match?.poolId && typeof match.poolId === 'object' ? match.poolId : null;
  const scoreboard =
    match?.scoreboardId && typeof match.scoreboardId === 'object' ? match.scoreboardId : null;

  const refTeams = Array.isArray(match?.refTeamIds)
    ? match.refTeamIds.map((team) =>
        team && typeof team === 'object' && team._id ? serializeTeam(team) : { id: toIdString(team) }
      )
    : [];

  return {
    _id: toIdString(match?._id),
    phase: match?.phase ?? null,
    stageKey: match?.stageKey ?? null,
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
    teamAId: teamA ? toIdString(teamA._id) : toIdString(match?.teamAId),
    teamBId: teamB ? toIdString(teamB._id) : toIdString(match?.teamBId),
    teamA: teamA ? serializeTeam(teamA) : null,
    teamB: teamB ? serializeTeam(teamB) : null,
    refTeamIds: refTeams.map((team) => team.id),
    refTeams,
    scoreboardId: scoreboard ? toIdString(scoreboard._id) : toIdString(match?.scoreboardId),
    scoreboardCode: scoreboard?.code ?? null,
    status: match?.status ?? null,
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
    .populate('scoreboardId', 'code')
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

function sortPlayoffMatches(matches) {
  const bracketOrder = {
    gold: 0,
    silver: 1,
    bronze: 2,
  };
  const roundOrder = {
    R1: 0,
    R2: 1,
    R3: 2,
  };

  return [...(Array.isArray(matches) ? matches : [])].sort((left, right) => {
    const byBracket =
      (bracketOrder[normalizeBracket(left?.bracket)] ?? Number.MAX_SAFE_INTEGER) -
      (bracketOrder[normalizeBracket(right?.bracket)] ?? Number.MAX_SAFE_INTEGER);
    if (byBracket !== 0) {
      return byBracket;
    }

    const byRound =
      (roundOrder[left?.bracketRound] ?? Number.MAX_SAFE_INTEGER) -
      (roundOrder[right?.bracketRound] ?? Number.MAX_SAFE_INTEGER);
    if (byRound !== 0) {
      return byRound;
    }

    if ((left?.roundBlock || 0) !== (right?.roundBlock || 0)) {
      return (left?.roundBlock || 0) - (right?.roundBlock || 0);
    }

    return String(left?.court || '').localeCompare(String(right?.court || ''));
  });
}

function buildPlayoffPayload(matches) {
  const orderedMatches = sortPlayoffMatches(matches);
  return {
    matches: orderedMatches,
    brackets: buildPlayoffBracketView(orderedMatches),
    opsSchedule: buildPlayoffOpsSchedule(orderedMatches),
  };
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

function serializeMatchForCourtSchedule(match) {
  return {
    matchId: toIdString(match?._id),
    phase: match?.phase ?? null,
    phaseLabel: PHASE_LABELS[match?.phase] || match?.phase || '',
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

function normalizeMatchStatus(status) {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';

  if (normalized === 'live') {
    return 'live';
  }

  if (normalized === 'final') {
    return 'final';
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

function resolveFacilityLabel(match) {
  const facilityCode = match?.facility || getFacilityFromCourt(match?.court);
  return FACILITY_LABELS[facilityCode] || facilityCode || '';
}

function serializeMatchForLiveView(match, tournament) {
  const teamA = match?.teamAId && typeof match.teamAId === 'object' ? match.teamAId : null;
  const teamB = match?.teamBId && typeof match.teamBId === 'object' ? match.teamBId : null;
  const scoreboard = match?.scoreboardId && typeof match.scoreboardId === 'object' ? match.scoreboardId : null;
  const resultScore = serializeCourtScheduleScore(match?.result);
  const scoreboardScore = serializeScoreSummaryFromScoreboard(scoreboard);

  return {
    matchId: toIdString(match?._id),
    phase: match?.phase ?? null,
    phaseLabel: PHASE_LABELS[match?.phase] || match?.phase || '',
    bracket: match?.bracket ?? null,
    roundBlock: match?.roundBlock ?? null,
    timeLabel: formatRoundBlockStartTime(match?.roundBlock, tournament),
    facility: match?.facility ?? getFacilityFromCourt(match?.court),
    facilityLabel: resolveFacilityLabel(match),
    courtCode: match?.court ?? null,
    courtLabel: mapCourtDisplayLabel(match?.court),
    teamA: formatPublicTeamSnippet(teamA),
    teamB: formatPublicTeamSnippet(teamB),
    status: normalizeMatchStatus(match?.status),
    scoreSummary: resultScore || scoreboardScore || null,
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

function serializeMatchForTeamView(match, focusTeamId, tournament) {
  const teamA = match?.teamAId && typeof match.teamAId === 'object' ? match.teamAId : null;
  const teamB = match?.teamBId && typeof match.teamBId === 'object' ? match.teamBId : null;
  const teamAId = toIdString(teamA?._id || match?.teamAId);
  const teamBId = toIdString(teamB?._id || match?.teamBId);
  const normalizedFocusTeamId = toIdString(focusTeamId);
  const isTeamHome = normalizedFocusTeamId && teamAId === normalizedFocusTeamId;
  const opponentTeam = isTeamHome ? teamB : teamA;
  const status = normalizeMatchStatus(match?.status);
  const resultScore = serializeCourtScheduleScore(match?.result);
  const scoreboardScore = serializeScoreSummaryFromScoreboard(
    match?.scoreboardId && typeof match.scoreboardId === 'object' ? match.scoreboardId : null
  );

  return {
    matchId: toIdString(match?._id),
    phase: match?.phase ?? null,
    phaseLabel: PHASE_LABELS[match?.phase] || match?.phase || '',
    bracket: match?.bracket ?? null,
    bracketLabel: BRACKET_LABELS[normalizeBracket(match?.bracket)] || null,
    roundLabel: match?.bracketRound ?? null,
    roundBlock: match?.roundBlock ?? null,
    timeLabel: formatRoundBlockStartTime(match?.roundBlock, tournament),
    facility: match?.facility ?? getFacilityFromCourt(match?.court),
    facilityLabel: resolveFacilityLabel(match),
    courtCode: match?.court ?? null,
    courtLabel: mapCourtDisplayLabel(match?.court),
    opponent: formatPublicTeamSnippet(opponentTeam),
    teamA: formatPublicTeamSnippet(teamA),
    teamB: formatPublicTeamSnippet(teamB),
    isTeamHome: Boolean(isTeamHome),
    status,
    scoreSummary: resultScore || scoreboardScore,
    refBy: Array.isArray(match?.refTeamIds)
      ? match.refTeamIds
          .map((team) => (team && typeof team === 'object' ? { shortName: team.shortName || team.name || 'TBD' } : null))
          .filter(Boolean)
      : [],
  };
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
  const pools = await Pool.find({
    tournamentId,
    phase,
    name: { $in: poolNames },
    $or: [{ stageKey: stageDef.key }, { stageKey: null }, { stageKey: { $exists: false } }],
  })
    .select('_id name stageKey requiredTeamCount teamIds homeCourt')
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
  stagePools.forEach((pool, index) => {
    const requiredTeamCount =
      Number.isFinite(Number(pool?.requiredTeamCount)) && Number(pool.requiredTeamCount) > 0
        ? Number(pool.requiredTeamCount)
        : Number(stagePoolDefinitions[index]?.size || 0);

    if (!Array.isArray(pool?.teamIds) || pool.teamIds.length !== requiredTeamCount) {
      throw new Error(`Pool ${pool?.name || '?'} must have exactly ${requiredTeamCount} teams`);
    }

    if (!isValidHomeCourt(pool.homeCourt)) {
      throw new Error(`Pool ${pool?.name || '?'} needs a valid home court`);
    }

    pool.teamIds.forEach((teamId) => duplicateCheck.push(toIdString(teamId)));
  });

  if (new Set(duplicateCheck).size !== duplicateCheck.length) {
    throw new Error(`Each ${stageDef.displayName || stageDef.key} team must appear in one pool only`);
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
      homeCourt: pool.homeCourt,
      matches: roundRobinMatches,
    };
  });

  const startRoundBlock = await resolveStageStartRoundBlock(tournamentId, formatDef, stageDef.key);
  const scheduledMatches = scheduleStageMatches(matchesByPool, activeCourts, startRoundBlock);
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
        teamAId: scheduledMatch.teamAId,
        teamBId: scheduledMatch.teamBId,
        refTeamIds: scheduledMatch.refTeamIds || [],
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
  const startRoundBlock = await resolveStageStartRoundBlock(tournamentId, formatDef, stageDef.key);
  const normalizedActiveCourts = uniqueValues(activeCourts);

  if (normalizedActiveCourts.length === 0) {
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
    .select('homeCourt')
    .lean();

  const pickSingleFacility = (facilityCounts) => {
    const entries = Array.from(facilityCounts.entries());
    if (entries.length === 0) {
      return null;
    }

    entries.sort((left, right) => {
      if (left[1] !== right[1]) {
        return right[1] - left[1];
      }

      if (left[0] === 'VC' && right[0] === 'SRC') {
        return -1;
      }

      if (left[0] === 'SRC' && right[0] === 'VC') {
        return 1;
      }

      return String(left[0]).localeCompare(String(right[0]));
    });

    return entries[0][0];
  };

  const sourceFacilityCounts = sourcePools.reduce((lookup, pool) => {
    const facility = getFacilityFromCourt(pool?.homeCourt);
    if (!facility) {
      return lookup;
    }
    lookup.set(facility, (lookup.get(facility) || 0) + 1);
    return lookup;
  }, new Map());
  const activeFacilityCounts = normalizedActiveCourts.reduce((lookup, courtCode) => {
    const facility = getFacilityFromCourt(courtCode);
    if (!facility) {
      return lookup;
    }
    lookup.set(facility, (lookup.get(facility) || 0) + 1);
    return lookup;
  }, new Map());
  const preferredFacility =
    pickSingleFacility(sourceFacilityCounts) || pickSingleFacility(activeFacilityCounts);
  const crossoverCourts = preferredFacility
    ? normalizedActiveCourts.filter(
        (courtCode) => getFacilityFromCourt(courtCode) === preferredFacility
      )
    : [];
  const courtsForCrossover = crossoverCourts.length > 0 ? crossoverCourts : [normalizedActiveCourts[0]];

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

      const court = courtsForCrossover[index % courtsForCrossover.length];
      const roundBlock = startRoundBlock + Math.floor(index / courtsForCrossover.length);
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
        facility: getFacilityFromCourt(court),
        court,
        teamAId: leftTeamId,
        teamBId: rightTeamId,
        refTeamIds: [],
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
  const scheduledMatches = schedulePlayoffMatches(allPlannedMatches, activeCourts, startRoundBlock);
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
      .select('_id timezone settings.schedule')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const liveMatches = await Match.find({
      tournamentId: tournament._id,
      status: 'live',
    })
      .select('phase bracket roundBlock facility court teamAId teamBId status result scoreboardId')
      .populate('teamAId', 'name shortName logoUrl')
      .populate('teamBId', 'name shortName logoUrl')
      .populate('scoreboardId', 'code teams.score sets')
      .lean();

    const cards = sortLiveMatchCards(
      liveMatches.map((match) => serializeMatchForLiveView(match, tournament))
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
      .select('_id name date timezone publicCode facilities settings.schedule')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Not found' });
    }

    const team = await TournamentTeam.findOne({
      tournamentId: tournament._id,
      publicTeamCode: teamCode,
    })
      .select('_id name shortName logoUrl')
      .lean();

    if (!team) {
      return res.status(404).json({ message: 'Not found' });
    }

    const relevantMatches = await Match.find({
      tournamentId: tournament._id,
      $or: [
        { teamAId: team._id },
        { teamBId: team._id },
        { refTeamIds: team._id },
      ],
    })
      .select(
        'phase bracket bracketRound roundBlock facility court teamAId teamBId refTeamIds status result scoreboardId createdAt'
      )
      .populate('teamAId', 'name shortName logoUrl')
      .populate('teamBId', 'name shortName logoUrl')
      .populate('refTeamIds', 'name shortName')
      .populate('scoreboardId', 'teams.score sets')
      .lean();

    const teamId = toIdString(team._id);
    const tournamentForTimeLabels = {
      timezone: tournament.timezone,
      settings: {
        schedule: normalizeTournamentSchedule(tournament?.settings?.schedule),
      },
    };

    const participantMatches = sortMatchesForCourtSchedule(
      relevantMatches.filter((match) => {
        const teamAId = toIdString(match?.teamAId?._id || match?.teamAId);
        const teamBId = toIdString(match?.teamBId?._id || match?.teamBId);
        return teamAId === teamId || teamBId === teamId;
      })
    ).map((match) => serializeMatchForTeamView(match, teamId, tournamentForTimeLabels));

    const refAssignments = sortMatchesForCourtSchedule(
      relevantMatches.filter((match) =>
        Array.isArray(match?.refTeamIds)
          ? match.refTeamIds.some((refTeam) => toIdString(refTeam?._id || refTeam) === teamId)
          : false
      )
    ).map((match) => serializeMatchForTeamView(match, teamId, tournamentForTimeLabels));

    const nextUp = participantMatches.find((match) => match.status !== 'final') || null;

    return res.json({
      tournament: {
        name: tournament.name,
        date: tournament.date,
        timezone: tournament.timezone,
        publicCode: tournament.publicCode,
        facilities: tournament.facilities,
        courts: PHASE1_COURT_ORDER.map((courtCode) => {
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
        },
      },
      team: {
        teamId,
        shortName: team.shortName || team.name || 'TBD',
        logoUrl: team.logoUrl || null,
      },
      nextUp,
      matches: participantMatches,
      refs: refAssignments,
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

    const tournament = await Tournament.findOne({ publicCode }).select('_id').lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    return res.json({
      courts: PHASE1_COURT_ORDER.map((courtCode) => ({
        code: courtCode,
        label: mapCourtDisplayLabel(courtCode),
        facility: getFacilityFromCourt(courtCode),
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
    const courtCode = normalizeCourtCode(req.params.courtCode);

    if (!new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(publicCode)) {
      return res.status(400).json({ message: 'Invalid tournament code' });
    }

    if (!isValidHomeCourt(courtCode)) {
      return res.status(400).json({ message: 'Invalid court code' });
    }

    const tournament = await Tournament.findOne({ publicCode }).select('_id').lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const matches = await Match.find({
      tournamentId: tournament._id,
      court: courtCode,
    })
      .select('phase roundBlock poolId teamAId teamBId refTeamIds status result createdAt')
      .populate('poolId', 'name')
      .populate('teamAId', 'name shortName')
      .populate('teamBId', 'name shortName')
      .populate('refTeamIds', 'name shortName')
      .lean();

    const orderedMatches = sortMatchesForCourtSchedule(matches).map(serializeMatchForCourtSchedule);

    return res.json({
      court: {
        code: courtCode,
        label: mapCourtDisplayLabel(courtCode),
        facility: getFacilityFromCourt(courtCode),
      },
      matches: orderedMatches,
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
      .select('_id name timezone status publicCode settings.schedule')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const matches = await loadMatchesForResponse({
      tournamentId: tournament._id,
      phase: 'playoffs',
    });
    const sanitizedMatches = matches.map(sanitizePlayoffMatchForPublic);
    const payload = buildPlayoffPayload(sanitizedMatches);

    return res.json({
      tournament: {
        id: tournament._id.toString(),
        name: tournament.name,
        timezone: tournament.timezone,
        status: tournament.status,
        settings: {
          schedule: normalizeTournamentSchedule(tournament?.settings?.schedule),
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

// GET /api/tournaments -> list tournaments created by current user
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const tournaments = await Tournament.find({ createdByUserId: req.user.id })
      .sort({ date: -1, createdAt: -1 })
      .lean();

    return res.json(tournaments);
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

    const tournament = await Tournament.findOneAndUpdate(
      {
        _id: id,
        createdByUserId: req.user.id,
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

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('_id')
      .lean();

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

    if (scoreboardIds.length > 0) {
      await Scoreboard.deleteMany({
        _id: { $in: scoreboardIds },
      });
    }

    await Tournament.deleteOne({
      _id: id,
      createdByUserId: req.user.id,
    });

    return res.json({
      deleted: true,
      tournamentId: id,
    });
  } catch (error) {
    return next(error);
  }
});

// PATCH /api/tournaments/:id/details -> owner-only tournament details content update
router.patch('/:id/details', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const ownedTournament = await ensureTournamentOwnership(id, req.user.id);

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
        createdByUserId: req.user.id,
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

// POST /api/tournaments/:id/apply-format -> owner applies a format + active courts
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

    const activeCourts = activeCourtsResult.activeCourts;

    if (activeCourts.length === 0) {
      return res.status(400).json({ message: 'At least one active court is required' });
    }

    if (
      Number.isFinite(Number(formatDef.minCourts)) &&
      activeCourts.length < Number(formatDef.minCourts)
    ) {
      return res.status(400).json({
        message: `${formatDef.name} requires at least ${formatDef.minCourts} active courts`,
      });
    }

    if (
      Number.isFinite(Number(formatDef.maxCourts)) &&
      activeCourts.length > Number(formatDef.maxCourts)
    ) {
      return res.status(400).json({
        message: `${formatDef.name} supports at most ${formatDef.maxCourts} active courts`,
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

    await Tournament.updateOne(
      { _id: id, createdByUserId: req.user.id },
      {
        $set: {
          'settings.format.formatId': formatDef.id,
          'settings.format.activeCourts': activeCourts,
        },
      }
    );

    const firstPoolStage = getFirstPoolPlayStage(formatDef);
    const pools = firstPoolStage
      ? await instantiatePools(id, formatDef, firstPoolStage.key, activeCourts, {
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

    return res.json({
      format: {
        id: formatDef.id,
        name: formatDef.name,
      },
      teamCount,
      activeCourts,
      pools: serializedPools,
    });
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

    const pools = await instantiatePools(
      id,
      formatContext.formatDef,
      stageDef.key,
      formatContext.activeCourts,
      {
        clearTeamIds: true,
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

    return res.status(201).json(generatedMatches);
  } catch (error) {
    if (error?.message && /(must have exactly|missing|unknown|requires|unsupported|Unable)/i.test(error.message)) {
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

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('publicCode')
      .lean();

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

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('publicCode')
      .lean();

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

// GET /api/tournaments/:id/phase1/pools -> list phase1 pools for an owned tournament
router.get('/:id/phase1/pools', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('publicCode')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const pools = await loadPhase1Pools(id, { populateTeams: true });
    return res.json(pools.map(serializePool));
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/phase2/pools -> list phase2 pools for an owned tournament
router.get('/:id/phase2/pools', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('publicCode')
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const pools = await loadPhase2Pools(id, { populateTeams: true });
    return res.json(pools.map(serializePool));
  } catch (error) {
    return next(error);
  }
});

// PUT /api/tournaments/:id/pools/courts -> owner-only court assignments per phase
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

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('publicCode')
      .lean();

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

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('publicCode')
      .lean();

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

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('settings status publicCode')
      .lean();

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

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('settings status publicCode')
      .lean();

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

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('settings status standingsOverrides publicCode')
      .lean();

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
    const payload = buildPlayoffPayload(createdMatches);
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

// GET /api/tournaments/:id/playoffs -> owner playoff bracket + ops schedule
router.get('/:id/playoffs', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const ownedTournament = await ensureTournamentOwnership(id, req.user.id);

    if (!ownedTournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const playoffMatches = await loadMatchesForResponse({
      tournamentId: id,
      phase: 'playoffs',
    });

    return res.json(buildPlayoffPayload(playoffMatches));
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/playoffs/ops -> owner printable playoff ops schedule
router.get('/:id/playoffs/ops', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const ownedTournament = await ensureTournamentOwnership(id, req.user.id);

    if (!ownedTournament) {
      return res.status(404).json({ message: 'Tournament not found or unauthorized' });
    }

    const playoffMatches = await loadMatchesForResponse({
      tournamentId: id,
      phase: 'playoffs',
    });
    const payload = buildPlayoffPayload(playoffMatches);

    return res.json({
      roundBlocks: payload.opsSchedule,
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/tournaments/:id/matches?phase=phase1|phase2|playoffs -> owned tournament matches
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

    const ownedTournament = await ensureTournamentOwnership(id, req.user.id);

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

// GET /api/tournaments/:id/standings?phase=phase1|phase2|cumulative -> owned tournament standings
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

    const ownedTournament = await ensureTournamentOwnership(id, req.user.id);

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

// PUT /api/tournaments/:id/standings-overrides -> owner-only tie/ordering overrides
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

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('_id standingsOverrides')
      .lean();

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
        createdByUserId: req.user.id,
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

// GET /api/tournaments/:id -> fetch tournament details and basic counts
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    }).lean();

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

    const ownedTournament = await ensureTournamentOwnership(id, req.user.id);

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

    const ownedTournament = await ensureTournamentOwnership(id, req.user.id);

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

// GET /api/tournaments/:id/teams/links -> list relative team public links for owned tournament
router.get('/:id/teams/links', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const tournament = await Tournament.findOne({
      _id: id,
      createdByUserId: req.user.id,
    })
      .select('publicCode')
      .lean();

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

// GET /api/tournaments/:id/teams -> list teams for an owned tournament
router.get('/:id/teams', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tournament id' });
    }

    const ownedTournament = await ensureTournamentOwnership(id, req.user.id);

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

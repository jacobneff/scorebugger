const Tournament = require('../models/Tournament');
const TournamentTeam = require('../models/TournamentTeam');
const Pool = require('../models/Pool');
const Match = require('../models/Match');
const Scoreboard = require('../models/Scoreboard');
const { DEFAULT_15_TEAM_FORMAT_ID, getFormat } = require('../tournamentFormats/formatRegistry');
const { resolvePoolPhase } = require('../tournamentEngine/formatEngine');
const { computeStandingsBundle } = require('./tournamentEngine/standings');
const { createMatchScoreboard } = require('./scoreboards');
const { normalizeScoringConfig } = require('./phase1');
const { findCourtInVenue, getEnabledCourts, normalizeVenueFacilities } = require('../utils/venue');
const {
  cacheTournamentMatchEntry,
  emitTournamentEvent,
  TOURNAMENT_EVENT_TYPES,
} = require('./tournamentRealtime');

const DEFAULT_COURTS = Object.freeze(['SRC-1', 'SRC-2', 'SRC-3', 'VC-1', 'VC-2']);
const FINALIZED_MATCH_STATUSES = new Set(['final']);

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const toIdString = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value._id) return value._id.toString();
  return value.toString();
};

const toPositiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
};

const uniqueValues = (values) => {
  const seen = new Set();
  const normalized = [];
  (Array.isArray(values) ? values : []).forEach((value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    normalized.push(value);
  });
  return normalized;
};

const normalizeTournamentSchedule = (schedule) => ({
  dayStartTime: isNonEmptyString(schedule?.dayStartTime) ? schedule.dayStartTime.trim() : '09:00',
  matchDurationMinutes: toPositiveInteger(schedule?.matchDurationMinutes) || 60,
  lunchStartTime: isNonEmptyString(schedule?.lunchStartTime) ? schedule.lunchStartTime.trim() : null,
  lunchDurationMinutes: toPositiveInteger(schedule?.lunchDurationMinutes) || 45,
});

const parseClockTimeToMinutes = (value) => {
  if (!isNonEmptyString(value)) return 0;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return 0;
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
};

const resolveRoundBlockStartMinutes = (roundBlock, tournamentOrSchedule) => {
  const parsedRoundBlock = Number(roundBlock);
  if (!Number.isFinite(parsedRoundBlock) || parsedRoundBlock <= 0) return null;

  const schedule = normalizeTournamentSchedule(
    tournamentOrSchedule?.settings?.schedule || tournamentOrSchedule
  );
  const blockIndex = Math.floor(parsedRoundBlock) - 1;
  const dayStart = parseClockTimeToMinutes(schedule.dayStartTime);
  const lunchStart = isNonEmptyString(schedule.lunchStartTime)
    ? parseClockTimeToMinutes(schedule.lunchStartTime)
    : null;
  const lunchDuration = toPositiveInteger(schedule.lunchDurationMinutes) || 0;
  const blockDuration = schedule.matchDurationMinutes;

  let cursor = dayStart;
  let lunchApplied = false;

  for (let i = 0; i < blockIndex; i += 1) {
    const end = cursor + blockDuration;
    if (!lunchApplied && lunchStart !== null && (cursor >= lunchStart || end > lunchStart)) {
      cursor = lunchStart + lunchDuration;
      lunchApplied = true;
    }
    cursor += blockDuration;
  }

  if (!lunchApplied && lunchStart !== null) {
    const end = cursor + blockDuration;
    if (cursor >= lunchStart || end > lunchStart) {
      return lunchStart + lunchDuration;
    }
  }

  return cursor;
};

const flattenLegacyCourts = (tournament) =>
  uniqueValues(
    [
      ...(Array.isArray(tournament?.facilities?.SRC) ? tournament.facilities.SRC : []),
      ...(Array.isArray(tournament?.facilities?.VC) ? tournament.facilities.VC : []),
    ]
      .map((entry) => (isNonEmptyString(entry) ? entry.trim() : ''))
      .filter(Boolean)
  );

const resolveTournamentVenueState = (tournament) => {
  const formatSettings =
    tournament?.settings?.format && typeof tournament.settings.format === 'object'
      ? tournament.settings.format
      : {};
  const totalCourts =
    toPositiveInteger(formatSettings?.totalCourts) ||
    toPositiveInteger(formatSettings?.activeCourts?.length) ||
    5;
  const venueFacilities = normalizeVenueFacilities(tournament?.settings?.venue?.facilities);
  const enabledCount = venueFacilities.reduce(
    (sum, facility) =>
      sum +
      (Array.isArray(facility?.courts)
        ? facility.courts.filter((court) => court?.isEnabled !== false).length
        : 0),
    0
  );

  if (enabledCount > 0) {
    return {
      totalCourts,
      venue: { facilities: venueFacilities },
    };
  }

  const fallbackCourts = uniqueValues([
    ...(Array.isArray(formatSettings?.activeCourts) ? formatSettings.activeCourts : []),
    ...flattenLegacyCourts(tournament),
    ...DEFAULT_COURTS,
  ]).slice(0, totalCourts);

  return {
    totalCourts,
    venue: {
      facilities: [
        {
          facilityId: 'legacy',
          name: 'Legacy',
          courts: fallbackCourts.map((court) => ({
            courtId: court,
            name: court,
            isEnabled: true,
          })),
        },
      ],
    },
  };
};

const getCourtReference = (venue, courtIdOrName) => {
  const venueCourt = findCourtInVenue(venue, courtIdOrName);
  if (venueCourt) {
    return {
      courtId: toIdString(venueCourt.courtId) || null,
      facilityId: toIdString(venueCourt.facilityId) || null,
      courtName: isNonEmptyString(venueCourt.courtName) ? venueCourt.courtName.trim() : null,
      facilityName: isNonEmptyString(venueCourt.facilityName) ? venueCourt.facilityName.trim() : null,
    };
  }

  if (isNonEmptyString(courtIdOrName)) {
    return {
      courtId: courtIdOrName.trim(),
      facilityId: null,
      courtName: courtIdOrName.trim(),
      facilityName: null,
    };
  }

  return null;
};

const isFinalizedMatch = (match) =>
  Boolean(match?.result) &&
  FINALIZED_MATCH_STATUSES.has(String(match?.status || '').trim().toLowerCase());

const getRoundRobinMatchCount = (poolSize) => {
  const parsed = Number(poolSize);
  if (!Number.isFinite(parsed) || parsed <= 1) return 0;
  return Math.floor((parsed * (parsed - 1)) / 2);
};

const toRankRef = (poolName, rank) => ({ type: 'rankRef', poolName, rank });
const toTeamRef = (teamId, sourceRankRef = null) => ({ type: 'teamId', teamId, sourceRankRef });

const formatRankRefLabel = (ref) => {
  if (!ref || ref.type !== 'rankRef') return '';
  const poolName = String(ref.poolName || '').trim();
  const rank = Number(ref.rank);
  if (!poolName || !Number.isFinite(rank) || rank <= 0) return '';
  return `${poolName} (#${Math.floor(rank)})`;
};

const normalizeRef = (ref) => {
  if (!ref || typeof ref !== 'object') return null;

  if (ref.type === 'rankRef') {
    const poolName = String(ref.poolName || '').trim();
    const rank = Number(ref.rank);
    if (!poolName || !Number.isFinite(rank) || rank <= 0) return null;
    return {
      type: 'rankRef',
      poolName,
      rank: Math.floor(rank),
    };
  }

  if (ref.type === 'teamId') {
    const teamId = toIdString(ref.teamId);
    if (!teamId) return null;
    return {
      type: 'teamId',
      teamId,
      sourceRankRef: normalizeRef(ref.sourceRankRef),
    };
  }

  return null;
};

const normalizeSlot = (slot) => {
  const participants = Array.isArray(slot?.participants)
    ? slot.participants.map((entry) => normalizeRef(entry)).filter(Boolean)
    : [];
  const byeRefs = Array.isArray(slot?.byeRefs)
    ? slot.byeRefs.map((entry) => normalizeRef(entry)).filter(Boolean)
    : [];

  return {
    slotId: isNonEmptyString(slot?.slotId) ? slot.slotId.trim() : '',
    stageKey: isNonEmptyString(slot?.stageKey) ? slot.stageKey.trim() : '',
    roundBlock:
      Number.isFinite(Number(slot?.roundBlock)) && Number(slot.roundBlock) > 0
        ? Math.floor(Number(slot.roundBlock))
        : null,
    timeIndex: Number.isFinite(Number(slot?.timeIndex)) ? Number(slot.timeIndex) : null,
    courtId: isNonEmptyString(slot?.courtId) ? slot.courtId.trim() : null,
    facilityId: isNonEmptyString(slot?.facilityId) ? slot.facilityId.trim() : null,
    kind: slot?.kind === 'lunch' ? 'lunch' : 'match',
    participants,
    ref: normalizeRef(slot?.ref),
    byeRefs: byeRefs.length > 0 ? byeRefs : undefined,
    matchId: toIdString(slot?.matchId) || null,
  };
};

const serializeSlotsForCompare = (slots) =>
  JSON.stringify(
    (Array.isArray(slots) ? slots : [])
      .map((slot) => normalizeSlot(slot))
      .sort((left, right) => String(left.slotId || '').localeCompare(String(right.slotId || '')))
  );

const toRoundCourtKey = (roundBlock, courtRef) => {
  const round = Number(roundBlock);
  if (!Number.isFinite(round) || round <= 0) return '';

  const courtKey =
    isNonEmptyString(courtRef?.courtId)
      ? `id:${courtRef.courtId.trim()}`
      : isNonEmptyString(courtRef?.courtName)
        ? `name:${courtRef.courtName.trim().toLowerCase()}`
        : '';

  if (!courtKey) return '';
  return `${Math.floor(round)}:${courtKey}`;
};

const createSlotFromMatch = ({ match, venue, schedule }) => {
  const roundBlock =
    Number.isFinite(Number(match?.roundBlock)) && Number(match.roundBlock) > 0
      ? Math.floor(Number(match.roundBlock))
      : null;
  const courtRef = getCourtReference(venue, match?.courtId || match?.court);
  const teamAId = toIdString(match?.teamAId);
  const teamBId = toIdString(match?.teamBId);
  const refTeamId =
    Array.isArray(match?.refTeamIds) && match.refTeamIds.length > 0
      ? toIdString(match.refTeamIds[0])
      : '';
  const byeTeamId = toIdString(match?.byeTeamId);

  return normalizeSlot({
    slotId: isNonEmptyString(match?.plannedSlotId)
      ? match.plannedSlotId.trim()
      : `match:${toIdString(match?._id)}`,
    stageKey: isNonEmptyString(match?.stageKey)
      ? match.stageKey.trim()
      : isNonEmptyString(match?.phase)
        ? match.phase.trim()
        : 'stage',
    roundBlock,
    timeIndex:
      roundBlock && Number.isFinite(resolveRoundBlockStartMinutes(roundBlock, schedule))
        ? resolveRoundBlockStartMinutes(roundBlock, schedule)
        : null,
    courtId: courtRef?.courtId || null,
    facilityId: courtRef?.facilityId || null,
    kind: 'match',
    participants: [teamAId ? toTeamRef(teamAId) : null, teamBId ? toTeamRef(teamBId) : null].filter(Boolean),
    ref: refTeamId ? toTeamRef(refTeamId) : null,
    byeRefs: byeTeamId ? [toTeamRef(byeTeamId)] : [],
    matchId: toIdString(match?._id) || null,
  });
};

const resolveTeamIdForRank = (standingsByPool, rankRef) => {
  if (!rankRef || rankRef.type !== 'rankRef') return '';
  const poolName = String(rankRef.poolName || '').trim();
  const rank = Number(rankRef.rank);
  if (!poolName || !Number.isFinite(rank) || rank <= 0) return '';

  const poolStanding = standingsByPool.get(poolName);
  const teams = Array.isArray(poolStanding?.teams) ? poolStanding.teams : [];
  const entry = teams.find((team) => Number(team?.rank) === Math.floor(rank));
  return toIdString(entry?.teamId);
};

const getCrossoverRefForIndex = (pairingCount, leftPoolName, rightPoolName, index) => {
  if (pairingCount >= 3) {
    if (index === 0) return toRankRef(leftPoolName, 3);
    if (index === 1) return toRankRef(rightPoolName, 3);
    if (index === 2) return toRankRef(rightPoolName, 2);
    return null;
  }
  if (index === 0) return toRankRef(leftPoolName, 2);
  if (index === 1) return toRankRef(rightPoolName, 2);
  return null;
};

const getCrossoverByeRefsForIndex = (pairingCount, leftPoolName, rightPoolName, index) => {
  if (pairingCount < 3 || index !== 2) return [];
  return [
    toRankRef(leftPoolName, 1),
    toRankRef(rightPoolName, 1),
    toRankRef(leftPoolName, 2),
  ];
};

const buildCrossoverSlots = ({
  formatDef,
  tournament,
  venue,
  schedule,
  pools,
  matches,
}) => {
  const crossoverStage = Array.isArray(formatDef?.stages)
    ? formatDef.stages.find((stage) => stage?.type === 'crossover') || null
    : null;
  if (!crossoverStage || !Array.isArray(crossoverStage.fromPools) || crossoverStage.fromPools.length !== 2) {
    return {
      stage: null,
      slots: [],
      previousPhase: 'phase1',
      previousStageKey: null,
      sourcePoolIds: [],
      sourcePoolTeamsByName: new Map(),
      ready: false,
    };
  }

  const stageOrder = Array.isArray(formatDef?.stages) ? formatDef.stages : [];
  const crossoverIndex = stageOrder.findIndex((stage) => stage?.key === crossoverStage.key);
  const previousPoolStage =
    crossoverIndex > 0
      ? [...stageOrder.slice(0, crossoverIndex)].reverse().find((stage) => stage?.type === 'poolPlay') || null
      : null;
  const previousPhase = previousPoolStage
    ? resolvePoolPhase(formatDef, previousPoolStage.key, previousPoolStage)
    : 'phase1';
  const [leftPoolName, rightPoolName] = crossoverStage.fromPools
    .map((poolName) => String(poolName || '').trim())
    .filter(Boolean);
  if (!leftPoolName || !rightPoolName) {
    return {
      stage: crossoverStage,
      slots: [],
      previousPhase,
      previousStageKey: previousPoolStage?.key || null,
      sourcePoolIds: [],
      sourcePoolTeamsByName: new Map(),
      ready: false,
    };
  }

  const sourcePoolsByName = new Map(
    (Array.isArray(pools) ? pools : [])
      .map((pool) => [String(pool?.name || '').trim(), pool])
      .filter(([poolName]) => Boolean(poolName))
  );
  const leftPool = sourcePoolsByName.get(leftPoolName);
  const rightPool = sourcePoolsByName.get(rightPoolName);
  const sourcePoolIds = [toIdString(leftPool?._id), toIdString(rightPool?._id)].filter(Boolean);
  const sourcePoolTeamsByName = new Map([
    [leftPoolName, Array.isArray(leftPool?.teamIds) ? leftPool.teamIds.map((teamId) => toIdString(teamId)).filter(Boolean) : []],
    [rightPoolName, Array.isArray(rightPool?.teamIds) ? rightPool.teamIds.map((teamId) => toIdString(teamId)).filter(Boolean) : []],
  ]);

  const poolSizeByName = new Map(
    (Array.isArray(previousPoolStage?.pools) ? previousPoolStage.pools : [])
      .map((poolDef) => [String(poolDef?.name || '').trim(), Number(poolDef?.size || 0)])
      .filter(([poolName]) => Boolean(poolName))
  );
  const leftPoolSize = Number(poolSizeByName.get(leftPoolName) || 0);
  const rightPoolSize = Number(poolSizeByName.get(rightPoolName) || 0);
  const pairingCount = Math.min(leftPoolSize, rightPoolSize);
  if (!Number.isFinite(pairingCount) || pairingCount <= 0) {
    return {
      stage: crossoverStage,
      slots: [],
      previousPhase,
      previousStageKey: previousPoolStage?.key || null,
      sourcePoolIds,
      sourcePoolTeamsByName,
      ready: false,
    };
  }

  const sourcePoolMatches = (Array.isArray(matches) ? matches : []).filter((match) =>
    sourcePoolIds.includes(toIdString(match?.poolId))
  );
  const requiredLeftMatches = getRoundRobinMatchCount(leftPoolSize);
  const requiredRightMatches = getRoundRobinMatchCount(rightPoolSize);
  const leftMatches = sourcePoolMatches.filter((match) => toIdString(match?.poolId) === toIdString(leftPool?._id));
  const rightMatches = sourcePoolMatches.filter((match) => toIdString(match?.poolId) === toIdString(rightPool?._id));
  const ready =
    requiredLeftMatches > 0 &&
    requiredRightMatches > 0 &&
    leftMatches.length >= requiredLeftMatches &&
    rightMatches.length >= requiredRightMatches &&
    leftMatches.every((match) => isFinalizedMatch(match)) &&
    rightMatches.every((match) => isFinalizedMatch(match));

  const sourcePoolCourts = [leftPool, rightPool]
    .map((pool) => getCourtReference(venue, pool?.assignedCourtId || pool?.homeCourt))
    .filter((court) => court && isNonEmptyString(court?.courtId));
  const sourcePoolCourtIds = uniqueValues(
    sourcePoolCourts.map((court) => toIdString(court?.courtId)).filter(Boolean)
  );
  const enabledCourtIds = uniqueValues(
    getEnabledCourts(venue).map((court) => toIdString(court?.courtId)).filter(Boolean)
  );
  const activeCourtIds = uniqueValues(
    (Array.isArray(tournament?.settings?.format?.activeCourts) ? tournament.settings.format.activeCourts : [])
      .map((court) => getCourtReference(venue, court))
      .filter(Boolean)
      .map((court) => toIdString(court?.courtId))
      .filter(Boolean)
  );
  const selectedCourtIds =
    sourcePoolCourtIds.length > 0
      ? sourcePoolCourtIds
      : activeCourtIds.length > 0
        ? activeCourtIds
        : enabledCourtIds;
  const selectedCourts = (selectedCourtIds.length > 0 ? selectedCourtIds : [null])
    .map((courtId) => (courtId ? getCourtReference(venue, courtId) : null));
  const maxSourceRoundBlock = sourcePoolMatches.reduce((maxValue, match) => {
    const roundBlock = Number(match?.roundBlock);
    if (!Number.isFinite(roundBlock) || roundBlock <= 0) return maxValue;
    return Math.max(maxValue, Math.floor(roundBlock));
  }, 0);
  const startRoundBlock =
    maxSourceRoundBlock > 0
      ? maxSourceRoundBlock + 1
      : Math.max(1, Math.max(requiredLeftMatches, requiredRightMatches) + 1);

  const slots = Array.from({ length: pairingCount }, (_, index) => {
    const roundBlock =
      selectedCourts.length >= 2
        ? index <= 1
          ? startRoundBlock
          : startRoundBlock + 1
        : startRoundBlock + index;
    const court =
      selectedCourts.length >= 2
        ? selectedCourts[index <= 1 ? index : 0]
        : selectedCourts[0];
    return normalizeSlot({
      slotId: `crossover:${leftPoolName}:${rightPoolName}:${index + 1}`,
      stageKey: crossoverStage.key,
      roundBlock,
      timeIndex:
        Number.isFinite(resolveRoundBlockStartMinutes(roundBlock, schedule))
          ? resolveRoundBlockStartMinutes(roundBlock, schedule)
          : null,
      courtId: court?.courtId || null,
      facilityId: court?.facilityId || null,
      kind: 'match',
      participants: [toRankRef(leftPoolName, index + 1), toRankRef(rightPoolName, index + 1)],
      ref: getCrossoverRefForIndex(pairingCount, leftPoolName, rightPoolName, index),
      byeRefs: getCrossoverByeRefsForIndex(pairingCount, leftPoolName, rightPoolName, index),
      matchId: null,
    });
  });

  return {
    stage: crossoverStage,
    slots,
    previousPhase,
    previousStageKey: previousPoolStage?.key || null,
    sourcePoolIds,
    sourcePoolTeamsByName,
    ready,
  };
};

async function resolveCrossoverSlotsIfReady({ tournamentId, previousPhase, slots, ready }) {
  if (!ready || !Array.isArray(slots) || slots.length === 0) {
    return slots;
  }

  const standings = await computeStandingsBundle(tournamentId, previousPhase === 'phase2' ? 'phase2' : 'phase1');
  const standingsByPool = new Map(
    (Array.isArray(standings?.pools) ? standings.pools : []).map((pool) => [pool.poolName, pool])
  );

  return slots.map((slot) => {
    const participants = (Array.isArray(slot?.participants) ? slot.participants : []).map((entry) => {
      if (entry?.type !== 'rankRef') return entry;
      const teamId = resolveTeamIdForRank(standingsByPool, entry);
      return teamId ? toTeamRef(teamId, toRankRef(entry.poolName, entry.rank)) : entry;
    });
    const ref =
      slot?.ref?.type === 'rankRef'
        ? (() => {
            const teamId = resolveTeamIdForRank(standingsByPool, slot.ref);
            return teamId
              ? toTeamRef(teamId, toRankRef(slot.ref.poolName, slot.ref.rank))
              : slot.ref;
          })()
        : slot?.ref || null;
    const byeRefs = (Array.isArray(slot?.byeRefs) ? slot.byeRefs : []).map((entry) => {
      if (entry?.type !== 'rankRef') return entry;
      const teamId = resolveTeamIdForRank(standingsByPool, entry);
      return teamId ? toTeamRef(teamId, toRankRef(entry.poolName, entry.rank)) : entry;
    });
    return normalizeSlot({ ...slot, participants, ref, byeRefs });
  });
}

async function linkCrossoverSlotsToMatches({ venue, slots, matches, crossoverStageKey }) {
  const matchesByPlannedSlotId = new Map(
    (Array.isArray(matches) ? matches : [])
      .map((match) => [toIdString(match?.plannedSlotId), match])
      .filter(([plannedSlotId]) => Boolean(plannedSlotId))
  );
  const fallbackByKey = new Map();

  (Array.isArray(matches) ? matches : [])
    .filter((match) => !isNonEmptyString(match?.plannedSlotId))
    .forEach((match) => {
      const courtRef = getCourtReference(venue, match?.courtId || match?.court);
      const key = toRoundCourtKey(match?.roundBlock, courtRef);
      if (!key) return;
      if (!fallbackByKey.has(key)) fallbackByKey.set(key, []);
      fallbackByKey.get(key).push(match);
    });

  const plannedSlotBackfills = [];
  const linkedSlots = (Array.isArray(slots) ? slots : []).map((slot) => {
    if (String(slot?.stageKey || '') !== String(crossoverStageKey || '')) return slot;

    const slotId = toIdString(slot?.slotId);
    let match = slotId ? matchesByPlannedSlotId.get(slotId) : null;

    if (!match) {
      const courtRef = getCourtReference(venue, slot?.courtId);
      const key = toRoundCourtKey(slot?.roundBlock, courtRef || { courtId: slot?.courtId });
      const queue = key ? fallbackByKey.get(key) : null;
      match = Array.isArray(queue) && queue.length > 0 ? queue.shift() : null;
      if (match && slotId) {
        plannedSlotBackfills.push({
          matchId: toIdString(match?._id),
          plannedSlotId: slotId,
        });
      }
    }

    if (!match) return slot;

    const teamAId = toIdString(match?.teamAId);
    const teamBId = toIdString(match?.teamBId);
    const refTeamId =
      Array.isArray(match?.refTeamIds) && match.refTeamIds.length > 0
        ? toIdString(match.refTeamIds[0])
        : '';
    const rankRefs = (Array.isArray(slot?.participants) ? slot.participants : []).filter(
      (entry) => entry?.type === 'rankRef'
    );
    const participants = [
      teamAId ? toTeamRef(teamAId, rankRefs[0] || null) : null,
      teamBId ? toTeamRef(teamBId, rankRefs[1] || null) : null,
    ].filter(Boolean);

    return normalizeSlot({
      ...slot,
      participants: participants.length > 0 ? participants : slot.participants,
      ref: refTeamId ? toTeamRef(refTeamId, slot?.ref?.type === 'rankRef' ? slot.ref : null) : slot.ref,
      matchId: toIdString(match?._id) || null,
    });
  });

  if (plannedSlotBackfills.length > 0) {
    await Match.bulkWrite(
      plannedSlotBackfills.map((entry) => ({
        updateOne: {
          filter: { _id: entry.matchId },
          update: {
            $set: {
              plannedSlotId: entry.plannedSlotId,
            },
          },
        },
      })),
      { ordered: true }
    );
  }

  return linkedSlots;
}

async function createMissingCrossoverMatches({
  tournament,
  tournamentId,
  actorUserId,
  formatDef,
  stageDef,
  venue,
  slots,
}) {
  const phase = resolvePoolPhase(formatDef, stageDef.key, stageDef);
  const scoring = normalizeScoringConfig(tournament?.settings?.scoring);
  const matchableSlots = (Array.isArray(slots) ? slots : []).filter((slot) => {
    if (String(slot?.stageKey || '') !== String(stageDef?.key || '')) return false;
    if (slot?.kind !== 'match') return false;
    if (toIdString(slot?.matchId)) return false;
    const participants = Array.isArray(slot?.participants) ? slot.participants : [];
    return (
      participants.length >= 2 &&
      participants[0]?.type === 'teamId' &&
      participants[1]?.type === 'teamId' &&
      toIdString(participants[0]?.teamId) &&
      toIdString(participants[1]?.teamId)
    );
  });

  if (matchableSlots.length === 0) {
    return { slots, createdMatchIds: [] };
  }

  const teamIds = uniqueValues(
    matchableSlots
      .flatMap((slot) =>
        (Array.isArray(slot?.participants) ? slot.participants : []).map((entry) =>
          toIdString(entry?.teamId)
        )
      )
      .filter(Boolean)
  );
  const teams = await TournamentTeam.find({
    _id: { $in: teamIds },
    tournamentId,
  })
    .select('name shortName logoUrl seed')
    .lean();
  const teamsById = new Map(teams.map((team) => [toIdString(team?._id), team]));
  const createdMatchIds = [];
  const createdScoreboardIds = [];
  const slotToMatchId = new Map();

  try {
    for (const slot of matchableSlots) {
      const slotId = toIdString(slot?.slotId);
      if (!slotId) continue;

      const existingMatch = await Match.findOne({ tournamentId, plannedSlotId: slotId }).select('_id').lean();
      if (existingMatch) {
        slotToMatchId.set(slotId, toIdString(existingMatch._id));
        continue;
      }

      const teamAId = toIdString(slot?.participants?.[0]?.teamId);
      const teamBId = toIdString(slot?.participants?.[1]?.teamId);
      const teamA = teamsById.get(teamAId);
      const teamB = teamsById.get(teamBId);
      if (!teamA || !teamB) continue;

      const courtRef = getCourtReference(venue, slot?.courtId);
      const refTeamId = toIdString(slot?.ref?.type === 'teamId' ? slot.ref.teamId : '');
      const scoreboard = await createMatchScoreboard({
        ownerId: actorUserId || null,
        title: `${stageDef.displayName || stageDef.key} Slot`,
        teamA,
        teamB,
        scoring,
      });
      const match = await Match.create({
        tournamentId,
        phase,
        stageKey: stageDef.key,
        poolId: null,
        roundBlock: slot.roundBlock,
        facility: courtRef?.facilityName || null,
        court: courtRef?.courtName || slot.courtId || null,
        facilityId: slot.facilityId || courtRef?.facilityId || null,
        courtId: slot.courtId || courtRef?.courtId || null,
        teamAId,
        teamBId,
        refTeamIds: refTeamId ? [refTeamId] : [],
        plannedSlotId: slotId,
        scoreboardId: scoreboard._id,
        status: 'scheduled',
      });

      cacheTournamentMatchEntry({
        scoreboardId: scoreboard._id,
        matchId: match._id,
        tournamentCode: tournament?.publicCode,
      });

      createdScoreboardIds.push(toIdString(scoreboard._id));
      createdMatchIds.push(toIdString(match._id));
      slotToMatchId.set(slotId, toIdString(match._id));
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

  return {
    slots: (Array.isArray(slots) ? slots : []).map((slot) => {
      const slotId = toIdString(slot?.slotId);
      if (!slotId || !slotToMatchId.has(slotId)) return slot;
      return normalizeSlot({
        ...slot,
        matchId: slotToMatchId.get(slotId),
      });
    }),
    createdMatchIds,
  };
}

async function syncSchedulePlan({
  tournamentId,
  actorUserId = null,
  io = null,
  emitEvents = true,
  emitPoolsUpdated = false,
} = {}) {
  const normalizedTournamentId = toIdString(tournamentId);
  if (!normalizedTournamentId) {
    return {
      slots: [],
      createdMatchIds: [],
      scheduleChanged: false,
      tournamentCode: '',
      previousPoolPhase: 'phase1',
      previousPoolStageKey: null,
      sourcePoolIds: [],
    };
  }

  const tournament = await Tournament.findById(normalizedTournamentId)
    .select(
      '_id publicCode timezone facilities settings.schedule settings.scoring settings.format settings.venue settings.schedulePlan'
    )
    .lean();
  if (!tournament) {
    return {
      slots: [],
      createdMatchIds: [],
      scheduleChanged: false,
      tournamentCode: '',
      previousPoolPhase: 'phase1',
      previousPoolStageKey: null,
      sourcePoolIds: [],
    };
  }

  const teamCount = await TournamentTeam.countDocuments({ tournamentId: normalizedTournamentId });
  const formatId = isNonEmptyString(tournament?.settings?.format?.formatId)
    ? tournament.settings.format.formatId.trim()
    : teamCount === 15
      ? DEFAULT_15_TEAM_FORMAT_ID
      : '';
  const formatDef = formatId ? getFormat(formatId) : null;
  const currentSlotsCanonical = serializeSlotsForCompare(tournament?.settings?.schedulePlan?.slots);

  if (!formatDef) {
    const nextSlotsCanonical = serializeSlotsForCompare([]);
    if (currentSlotsCanonical !== nextSlotsCanonical) {
      await Tournament.updateOne(
        { _id: normalizedTournamentId },
        { $set: { 'settings.schedulePlan.slots': [] } }
      );
      if (emitEvents && io && isNonEmptyString(tournament?.publicCode)) {
        emitTournamentEvent(
          io,
          tournament.publicCode,
          TOURNAMENT_EVENT_TYPES.SCHEDULE_PLAN_UPDATED,
          {}
        );
      }
    }

    return {
      slots: [],
      createdMatchIds: [],
      scheduleChanged: currentSlotsCanonical !== nextSlotsCanonical,
      tournamentCode: tournament?.publicCode || '',
      previousPoolPhase: 'phase1',
      previousPoolStageKey: null,
      sourcePoolIds: [],
    };
  }

  const schedule = normalizeTournamentSchedule(tournament?.settings?.schedule);
  const venueState = resolveTournamentVenueState(tournament);
  const allMatches = await Match.find({ tournamentId: normalizedTournamentId })
    .select(
      '_id phase stageKey poolId roundBlock facility court facilityId courtId teamAId teamBId refTeamIds byeTeamId plannedSlotId status result scoreboardId'
    )
    .lean();
  const poolStageKeys = uniqueValues(
    (Array.isArray(formatDef?.stages) ? formatDef.stages : [])
      .filter((stage) => stage?.type === 'poolPlay')
      .map((stage) => String(stage?.key || '').trim())
      .filter(Boolean)
  );
  const pools = await Pool.find({
    tournamentId: normalizedTournamentId,
    ...(poolStageKeys.length > 0
      ? { $or: [{ stageKey: { $in: poolStageKeys } }, { stageKey: null }, { stageKey: { $exists: false } }] }
      : {}),
  })
    .select('_id name phase stageKey requiredTeamCount teamIds homeCourt assignedCourtId assignedFacilityId')
    .lean();

  const baseSlots = allMatches.map((match) =>
    createSlotFromMatch({
      match,
      venue: venueState.venue,
      schedule,
    })
  );

  const crossoverBundle = buildCrossoverSlots({
    formatDef,
    tournament,
    venue: venueState.venue,
    schedule,
    pools,
    matches: allMatches,
  });

  let crossoverSlots = await resolveCrossoverSlotsIfReady({
    tournamentId: normalizedTournamentId,
    previousPhase: crossoverBundle.previousPhase,
    slots: crossoverBundle.slots,
    ready: crossoverBundle.ready,
  });
  crossoverSlots = await linkCrossoverSlotsToMatches({
    venue: venueState.venue,
    slots: crossoverSlots,
    matches: allMatches.filter(
      (match) =>
        String(match?.stageKey || '').trim() === String(crossoverBundle?.stage?.key || '').trim()
    ),
    crossoverStageKey: crossoverBundle?.stage?.key || null,
  });

  let createdMatchIds = [];
  if (crossoverBundle.stage && crossoverBundle.ready) {
    const created = await createMissingCrossoverMatches({
      tournament,
      tournamentId: normalizedTournamentId,
      actorUserId,
      formatDef,
      stageDef: crossoverBundle.stage,
      venue: venueState.venue,
      slots: crossoverSlots,
    });
    crossoverSlots = created.slots;
    createdMatchIds = created.createdMatchIds;
  }

  const mappedCrossoverMatchIds = new Set(
    crossoverSlots.map((slot) => toIdString(slot?.matchId)).filter(Boolean)
  );
  const orphanCrossoverSlots = baseSlots.filter((slot) => {
    if (String(slot?.stageKey || '') !== String(crossoverBundle?.stage?.key || '')) return false;
    const matchId = toIdString(slot?.matchId);
    return matchId && !mappedCrossoverMatchIds.has(matchId);
  });
  const nonCrossoverSlots = baseSlots.filter(
    (slot) => String(slot?.stageKey || '') !== String(crossoverBundle?.stage?.key || '')
  );
  const lunchSlots = [];
  if (isNonEmptyString(schedule?.lunchStartTime) && Number(schedule?.lunchDurationMinutes) > 0) {
    lunchSlots.push(
      normalizeSlot({
        slotId: 'lunch:main',
        stageKey: 'lunch',
        roundBlock: null,
        timeIndex: parseClockTimeToMinutes(schedule.lunchStartTime),
        courtId: null,
        facilityId: null,
        kind: 'lunch',
        participants: [],
        ref: null,
        byeRefs: [],
        matchId: null,
      })
    );
  }

  const nextSlots = [...nonCrossoverSlots, ...crossoverSlots, ...orphanCrossoverSlots, ...lunchSlots]
    .map((slot) => normalizeSlot(slot))
    .filter((slot) => slot.slotId && slot.stageKey)
    .sort((left, right) => {
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
      if (leftTime !== rightTime) return leftTime - rightTime;
      const byRound =
        (Number.isFinite(Number(left?.roundBlock)) ? Number(left.roundBlock) : Number.MAX_SAFE_INTEGER) -
        (Number.isFinite(Number(right?.roundBlock)) ? Number(right.roundBlock) : Number.MAX_SAFE_INTEGER);
      if (byRound !== 0) return byRound;
      const byCourt = String(left?.courtId || '').localeCompare(String(right?.courtId || ''));
      if (byCourt !== 0) return byCourt;
      return String(left?.slotId || '').localeCompare(String(right?.slotId || ''));
    });

  const nextSlotsCanonical = serializeSlotsForCompare(nextSlots);
  const scheduleChanged = currentSlotsCanonical !== nextSlotsCanonical;
  if (scheduleChanged) {
    await Tournament.updateOne(
      { _id: normalizedTournamentId },
      {
        $set: {
          'settings.schedulePlan.slots': nextSlots,
        },
      }
    );
  }

  if (emitEvents && io && isNonEmptyString(tournament?.publicCode)) {
    if (emitPoolsUpdated) {
      emitTournamentEvent(io, tournament.publicCode, TOURNAMENT_EVENT_TYPES.POOLS_UPDATED, {
        phase: crossoverBundle.previousPhase || 'phase1',
        stageKey: crossoverBundle.previousStageKey || null,
        poolIds: crossoverBundle.sourcePoolIds || [],
      });
    }

    if (createdMatchIds.length > 0) {
      emitTournamentEvent(io, tournament.publicCode, TOURNAMENT_EVENT_TYPES.MATCHES_GENERATED, {
        phase: crossoverBundle.stage
          ? resolvePoolPhase(formatDef, crossoverBundle.stage.key, crossoverBundle.stage)
          : 'phase1',
        stageKey: crossoverBundle.stage?.key || null,
        matchIds: createdMatchIds,
      });
    }

    if (scheduleChanged || createdMatchIds.length > 0) {
      emitTournamentEvent(io, tournament.publicCode, TOURNAMENT_EVENT_TYPES.SCHEDULE_PLAN_UPDATED, {
        stageKey: crossoverBundle.stage?.key || null,
      });
    }
  }

  return {
    slots: nextSlots,
    createdMatchIds,
    scheduleChanged,
    tournamentCode: tournament?.publicCode || '',
    previousPoolPhase: crossoverBundle.previousPhase || 'phase1',
    previousPoolStageKey: crossoverBundle.previousStageKey || null,
    sourcePoolIds: crossoverBundle.sourcePoolIds || [],
  };
}

module.exports = {
  formatRankRefLabel,
  resolveRoundBlockStartMinutes,
  syncSchedulePlan,
  toIdString,
};

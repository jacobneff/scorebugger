import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { API_URL } from '../config/env.js';
import CourtAssignmentsBoard from '../components/CourtAssignmentsBoard.jsx';
import TournamentAdminNav from '../components/TournamentAdminNav.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useTournamentRealtime } from '../hooks/useTournamentRealtime.js';
import {
  formatRoundBlockStartTime,
  formatSetRecord,
  mapCourtLabel,
} from '../utils/phase1.js';
import {
  formatSetSummaryWithScores,
  toSetSummaryFromLiveSummary,
  toSetSummaryFromScoreSummary,
} from '../utils/matchSetSummary.js';
import { buildTournamentMatchControlHref } from '../utils/tournamentMatchControl.js';
import {
  TEAM_BANK_CONTAINER_ID,
  buildTeamBankFromPools,
  buildTwoPassPoolPatchPlan,
  clonePoolsForDnd,
  collectChangedPoolIds,
  computeTeamDragPreview,
} from '../utils/phase1PoolDnd.js';

const ODU_15_FORMAT_ID = 'odu_15_5courts_v1';
const DEFAULT_TOTAL_COURTS = 5;
const MAX_TOTAL_COURTS = 64;

const authHeaders = (token) => ({ Authorization: `Bearer ${token}` });
const jsonHeaders = (token) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
});

const toIdString = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};

const toPositiveInteger = (value, fallback = null, min = 1, max = MAX_TOTAL_COURTS) => {
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

let localVenueIdCounter = 0;
const createLocalVenueId = (prefix) => {
  localVenueIdCounter += 1;
  return `${prefix}-tmp-${Date.now()}-${localVenueIdCounter}`;
};

const countVenueCourts = (facilities, { enabledOnly = false } = {}) =>
  (Array.isArray(facilities) ? facilities : []).reduce((sum, facility) => {
    const courts = Array.isArray(facility?.courts) ? facility.courts : [];
    return (
      sum + courts.filter((court) => (enabledOnly ? court?.isEnabled !== false : true)).length
    );
  }, 0);

const flattenVenueCourts = (facilities) =>
  (Array.isArray(facilities) ? facilities : []).flatMap((facility, facilityIndex) => {
    const facilityId = toIdString(facility?.facilityId) || createLocalVenueId('facility');
    const facilityName =
      typeof facility?.name === 'string' && facility.name.trim()
        ? facility.name.trim()
        : facilityIndex === 0
          ? 'Main Facility'
          : `Facility ${facilityIndex + 1}`;
    const courts = Array.isArray(facility?.courts) ? facility.courts : [];
    return courts.map((court, courtIndex) => ({
      facilityId,
      facilityName,
      courtId: toIdString(court?.courtId) || createLocalVenueId('court'),
      courtName:
        typeof court?.name === 'string' && court.name.trim()
          ? court.name.trim()
          : `Court ${courtIndex + 1}`,
      isEnabled: court?.isEnabled !== false,
    }));
  });

const buildDefaultFacility = (index, courtCount = 1) => ({
  facilityId: createLocalVenueId('facility'),
  name: index === 0 ? 'Main Facility' : `Facility ${index + 1}`,
  courts: Array.from({ length: Math.max(1, courtCount) }, (_, courtIndex) => ({
    courtId: createLocalVenueId('court'),
    name: `Court ${courtIndex + 1}`,
    isEnabled: true,
  })),
});

const normalizeVenuePayload = (payload, fallbackTotalCourts = DEFAULT_TOTAL_COURTS) => {
  const totalCourts =
    toPositiveInteger(payload?.totalCourts)
    || toPositiveInteger(fallbackTotalCourts)
    || DEFAULT_TOTAL_COURTS;
  const rawFacilities = Array.isArray(payload?.venue?.facilities)
    ? payload.venue.facilities
    : Array.isArray(payload?.facilities)
      ? payload.facilities
      : [];

  const facilities = (rawFacilities.length > 0 ? rawFacilities : [buildDefaultFacility(0, totalCourts)])
    .map((facility, facilityIndex) => {
      const courts = Array.isArray(facility?.courts) ? facility.courts : [];
      return {
        facilityId: toIdString(facility?.facilityId) || createLocalVenueId('facility'),
        name:
          typeof facility?.name === 'string' && facility.name.trim()
            ? facility.name.trim()
            : facilityIndex === 0
              ? 'Main Facility'
              : `Facility ${facilityIndex + 1}`,
        courts: (courts.length > 0 ? courts : [null]).map((court, courtIndex) => ({
          courtId: toIdString(court?.courtId) || createLocalVenueId('court'),
          name:
            typeof court?.name === 'string' && court.name.trim()
              ? court.name.trim()
              : `Court ${courtIndex + 1}`,
          isEnabled: court?.isEnabled !== false,
        })),
      };
    });

  return {
    facilities,
    totalCourts,
  };
};

const FINALIZED_MATCH_STATUSES = new Set(['final', 'ended']);

const isMatchFinalized = (match) => {
  const status = String(match?.status || '').trim().toLowerCase();
  return Boolean(match?.result) || FINALIZED_MATCH_STATUSES.has(status);
};

const getRoundRobinMatchCountForPoolSize = (poolSize) => {
  const normalizedPoolSize = Number(poolSize);
  if (!Number.isFinite(normalizedPoolSize) || normalizedPoolSize <= 1) {
    return 0;
  }

  return Math.floor((normalizedPoolSize * (normalizedPoolSize - 1)) / 2);
};

const formatPoolRankLabel = (poolName, rank) => `${poolName} (#${rank})`;

const normalizeTeam = (team) => ({
  _id: String(team?._id || ''),
  name: team?.name || '',
  shortName: team?.shortName || '',
  logoUrl: team?.logoUrl ?? null,
  orderIndex: Number.isFinite(Number(team?.orderIndex)) ? Number(team.orderIndex) : null,
});

const normalizePool = (pool) => ({
  ...pool,
  _id: String(pool?._id || ''),
  homeCourt: typeof pool?.homeCourt === 'string' && pool.homeCourt.trim() ? pool.homeCourt.trim() : null,
  assignedCourtId:
    typeof pool?.assignedCourtId === 'string' && pool.assignedCourtId.trim()
      ? pool.assignedCourtId.trim()
      : null,
  assignedFacilityId:
    typeof pool?.assignedFacilityId === 'string' && pool.assignedFacilityId.trim()
      ? pool.assignedFacilityId.trim()
      : null,
  requiredTeamCount:
    Number.isFinite(Number(pool?.requiredTeamCount)) && Number(pool.requiredTeamCount) > 0
      ? Number(pool.requiredTeamCount)
      : 3,
  teamIds: Array.isArray(pool?.teamIds) ? pool.teamIds.map((team) => normalizeTeam(team)) : [],
});

const getPoolStages = (formatDef) =>
  Array.isArray(formatDef?.stages)
    ? formatDef.stages.filter((stage) => stage?.type === 'poolPlay')
    : [];

const getStageByType = (formatDef, stageType) =>
  Array.isArray(formatDef?.stages)
    ? formatDef.stages.find((stage) => stage?.type === stageType) || null
    : null;

const normalizeStandings = (payload) => ({
  pools: Array.isArray(payload?.pools) ? payload.pools : [],
  overall: Array.isArray(payload?.overall) ? payload.overall : [],
});

const formatTeamLabel = (team) => team?.shortName || team?.name || 'TBD';

const formatPointDiff = (value) => {
  const parsed = Number(value) || 0;
  return parsed > 0 ? `+${parsed}` : `${parsed}`;
};

const getScheduleStatusMeta = (status) => {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';

  if (normalized === 'scheduled_tbd') {
    return {
      label: 'Scheduled / TBD',
      className: 'court-schedule-status court-schedule-status--tbd',
    };
  }
  if (normalized === 'live') {
    return {
      label: 'LIVE',
      className: 'court-schedule-status court-schedule-status--live',
    };
  }
  if (normalized === 'final') {
    return {
      label: 'FINAL',
      className: 'court-schedule-status court-schedule-status--final',
    };
  }
  if (normalized === 'ended') {
    return {
      label: 'ENDED',
      className: 'court-schedule-status court-schedule-status--ended',
    };
  }

  return {
    label: 'Scheduled',
    className: 'court-schedule-status court-schedule-status--scheduled',
  };
};

function DraggableTeamCard({ team, disabled }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: team._id,
    disabled,
  });

  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`phase1-team-card ${isDragging ? 'is-dragging' : ''}`}
    >
      <div className="phase1-team-card-main">
        {team.logoUrl ? (
          <img className="phase1-team-card-logo" src={team.logoUrl} alt={`${formatTeamLabel(team)} logo`} />
        ) : null}
        <strong>{formatTeamLabel(team)}</strong>
      </div>
      <button
        type="button"
        className="phase1-team-drag-handle"
        aria-label={`Drag ${formatTeamLabel(team)}`}
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        Drag
      </button>
    </article>
  );
}

function TeamCardPreview({ team }) {
  if (!team) return null;
  return (
    <article className="phase1-team-card phase1-team-card--overlay">
      <div className="phase1-team-card-main">
        {team.logoUrl ? (
          <img className="phase1-team-card-logo" src={team.logoUrl} alt={`${formatTeamLabel(team)} logo`} />
        ) : null}
        <strong>{formatTeamLabel(team)}</strong>
      </div>
      <span className="phase1-team-drag-handle">Drag</span>
    </article>
  );
}

function TeamDropContainer({ containerId, className = '', children }) {
  const { setNodeRef, isOver } = useDroppable({ id: containerId });
  return (
    <div ref={setNodeRef} className={`${className} ${isOver ? 'is-active' : ''}`.trim()}>
      {children}
    </div>
  );
}

function TournamentPoolPlayAdmin() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { token, user, initializing } = useAuth();

  const [tournament, setTournament] = useState(null);
  const [formatDef, setFormatDef] = useState(null);
  const [teams, setTeams] = useState([]);
  const [pools, setPools] = useState([]);
  const [poolPlayMatches, setPoolPlayMatches] = useState([]);
  const [crossoverMatches, setCrossoverMatches] = useState([]);
  const [schedulePlanSlots, setSchedulePlanSlots] = useState([]);
  const [venue, setVenue] = useState({ facilities: [], totalCourts: DEFAULT_TOTAL_COURTS });
  const [venueDraft, setVenueDraft] = useState({
    facilities: [],
    totalCourts: DEFAULT_TOTAL_COURTS,
  });
  const [standingsByPhase, setStandingsByPhase] = useState({
    phase1: { pools: [], overall: [] },
    cumulative: { pools: [], overall: [] },
  });
  const [activeStandingsTab, setActiveStandingsTab] = useState('phase1');
  const [loading, setLoading] = useState(true);
  const [savingPools, setSavingPools] = useState(false);
  const [initializingPools, setInitializingPools] = useState(false);
  const [autofillingPools, setAutofillingPools] = useState(false);
  const [generatingMatches, setGeneratingMatches] = useState(false);
  const [savingVenue, setSavingVenue] = useState(false);
  const [savingCourtAssignments, setSavingCourtAssignments] = useState(false);
  const [resettingTournament, setResettingTournament] = useState(false);
  const [activeDragTeamId, setActiveDragTeamId] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [poolActionMessage, setPoolActionMessage] = useState('');
  const [liveSummariesByMatchId, setLiveSummariesByMatchId] = useState({});
  const formatDefRef = useRef(null);
  const stageReloadInFlightRef = useRef(false);
  const autoInitStageKeyRef = useRef('');
  const autoInitAttemptedRef = useRef(false);
  const autoGenerateCrossoverAttemptKeyRef = useRef('');
  const autoGenerateCrossoverInFlightRef = useRef(false);
  const autoRepairCrossoverAttemptKeyRef = useRef('');

  const dragSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const fetchJson = useCallback(async (url, options = {}) => {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.message || 'Request failed');
    return payload;
  }, []);

  useEffect(() => {
    formatDefRef.current = formatDef;
  }, [formatDef]);

  const loadVenueData = useCallback(async (fallbackTournament = null) => {
    if (!token || !id) {
      return normalizeVenuePayload(null, DEFAULT_TOTAL_COURTS);
    }

    const fallbackTotalCourts =
      toPositiveInteger(
        fallbackTournament?.settings?.format?.totalCourts
      )
      || toPositiveInteger(tournament?.settings?.format?.totalCourts)
      || DEFAULT_TOTAL_COURTS;
    const payload = await fetchJson(`${API_URL}/api/tournaments/${id}/venue`, {
      headers: authHeaders(token),
    }).catch(() => null);
    return normalizeVenuePayload(payload, fallbackTotalCourts);
  }, [fetchJson, id, token, tournament?.settings?.format?.totalCourts]);

  const loadStageData = useCallback(async (nextFormatDef) => {
    const formatToUse = nextFormatDef || formatDefRef.current;
    const firstPoolStage = getPoolStages(formatToUse)[0] || null;
    if (!firstPoolStage || !token || !id) {
      setPools([]);
      setPoolPlayMatches([]);
      setCrossoverMatches([]);
      setSchedulePlanSlots([]);
      setStandingsByPhase({ phase1: { pools: [], overall: [] }, cumulative: { pools: [], overall: [] } });
      return;
    }

    const nextCrossoverStage = getStageByType(formatToUse, 'crossover');
    const [poolPayload, poolMatchPayload, phase1Standings, cumulativeStandings, crossoverPayload, schedulePlanPayload] = await Promise.all([
      fetchJson(`${API_URL}/api/tournaments/${id}/stages/${firstPoolStage.key}/pools`, { headers: authHeaders(token) }),
      fetchJson(`${API_URL}/api/tournaments/${id}/stages/${firstPoolStage.key}/matches`, { headers: authHeaders(token) }),
      fetchJson(`${API_URL}/api/tournaments/${id}/standings?phase=phase1`, { headers: authHeaders(token) }),
      fetchJson(`${API_URL}/api/tournaments/${id}/standings?phase=cumulative`, { headers: authHeaders(token) }),
      nextCrossoverStage
        ? fetchJson(`${API_URL}/api/tournaments/${id}/stages/${nextCrossoverStage.key}/matches`, { headers: authHeaders(token) }).catch(() => [])
        : Promise.resolve([]),
      fetchJson(
        `${API_URL}/api/tournaments/${id}/schedule-plan?stageKeys=${encodeURIComponent(
          [firstPoolStage.key, nextCrossoverStage?.key].filter(Boolean).join(',')
        )}&kinds=match`,
        { headers: authHeaders(token) }
      ).catch(() => ({ slots: [] })),
    ]);

    setPools(Array.isArray(poolPayload) ? poolPayload.map((pool) => normalizePool(pool)) : []);
    setPoolPlayMatches(Array.isArray(poolMatchPayload) ? poolMatchPayload : []);
    setCrossoverMatches(Array.isArray(crossoverPayload) ? crossoverPayload : []);
    setSchedulePlanSlots(Array.isArray(schedulePlanPayload?.slots) ? schedulePlanPayload.slots : []);
    setStandingsByPhase({
      phase1: normalizeStandings(phase1Standings),
      cumulative: normalizeStandings(cumulativeStandings),
    });
  }, [fetchJson, id, token]);

  const refreshStageData = useCallback(async (nextFormatDef) => {
    if (stageReloadInFlightRef.current) {
      return;
    }

    stageReloadInFlightRef.current = true;
    try {
      await loadStageData(nextFormatDef);
    } finally {
      stageReloadInFlightRef.current = false;
    }
  }, [loadStageData]);

  const loadData = useCallback(async () => {
    if (!token || !id) return;
    setLoading(true);
    setError('');
    setPoolActionMessage('');
    setLiveSummariesByMatchId({});

    try {
      const [tournamentPayload, teamsPayload] = await Promise.all([
        fetchJson(`${API_URL}/api/tournaments/${id}`, { headers: authHeaders(token) }),
        fetchJson(`${API_URL}/api/tournaments/${id}/teams`, { headers: authHeaders(token) }),
      ]);

      const nextFormatId = typeof tournamentPayload?.settings?.format?.formatId === 'string'
        ? tournamentPayload.settings.format.formatId.trim()
        : '';
      const fallbackTotalCourts =
        toPositiveInteger(tournamentPayload?.settings?.format?.totalCourts)
        || DEFAULT_TOTAL_COURTS;

      setTeams(Array.isArray(teamsPayload) ? teamsPayload.map((team) => normalizeTeam(team)) : []);

      if (!nextFormatId) {
        setTournament(tournamentPayload);
        setFormatDef(null);
        formatDefRef.current = null;
        setPools([]);
        setPoolPlayMatches([]);
        setCrossoverMatches([]);
        setSchedulePlanSlots([]);
        const defaultVenue = normalizeVenuePayload(null, fallbackTotalCourts);
        setVenue(defaultVenue);
        setVenueDraft(defaultVenue);
        return;
      }

      const nextFormatDef = await fetchJson(`${API_URL}/api/tournament-formats/${nextFormatId}`);
      setFormatDef(nextFormatDef);
      formatDefRef.current = nextFormatDef;

      if (nextFormatId === ODU_15_FORMAT_ID) {
        setTournament(tournamentPayload);
        setPools([]);
        setPoolPlayMatches([]);
        setCrossoverMatches([]);
        setSchedulePlanSlots([]);
        const defaultVenue = normalizeVenuePayload(tournamentPayload?.settings?.venue, fallbackTotalCourts);
        setVenue(defaultVenue);
        setVenueDraft(defaultVenue);
        return;
      }

      const [nextVenue] = await Promise.all([
        loadVenueData(tournamentPayload),
        loadStageData(nextFormatDef),
      ]);
      const resolvedTotalCourts =
        toPositiveInteger(nextVenue?.totalCourts)
        || fallbackTotalCourts;
      const patchedTournament = {
        ...tournamentPayload,
        settings: {
          ...(tournamentPayload?.settings || {}),
          format: {
            ...(tournamentPayload?.settings?.format || {}),
            totalCourts: resolvedTotalCourts,
          },
          venue: {
            facilities: nextVenue.facilities,
          },
        },
      };
      setTournament(patchedTournament);
      setVenue(nextVenue);
      setVenueDraft(nextVenue);
    } catch (loadError) {
      setError(loadError.message || 'Unable to load pool play setup');
    } finally {
      setLoading(false);
    }
  }, [fetchJson, id, loadStageData, loadVenueData, token]);

  useEffect(() => {
    if (initializing) return;
    if (!token) {
      setLoading(false);
      return;
    }
    loadData();
  }, [initializing, loadData, token]);

  const appliedFormatId = typeof tournament?.settings?.format?.formatId === 'string'
    ? tournament.settings.format.formatId.trim()
    : '';
  const isLegacyFormat = appliedFormatId === ODU_15_FORMAT_ID;
  const hasAppliedFormat = Boolean(appliedFormatId);
  const poolPlayStage = getPoolStages(formatDef)[0] || null;
  const crossoverStage = getStageByType(formatDef, 'crossover');
  const poolPlayStageLabel = poolPlayStage?.displayName || 'Pool Play';
  const crossoverStageLabel = crossoverStage?.displayName || 'Crossover';
  const nonLegacySchedulingNav = {
    activeSubTab: 'phase1',
    showPhase2: false,
    phase1Label: 'Pool Play Setup',
    phase1Href: `/tournaments/${id}/pool-play`,
    playoffsLabel: 'Playoffs Setup',
    playoffsHref: `/tournaments/${id}/playoffs`,
  };
  const legacySchedulingNav = {
    activeSubTab: 'phase1',
    showPhase2: true,
    phase1Label: 'Pool Play 1',
    phase1Href: `/tournaments/${id}/phase1`,
    phase2Label: 'Pool Play 2',
    phase2Href: `/tournaments/${id}/phase2`,
    playoffsLabel: 'Playoffs',
    playoffsHref: `/tournaments/${id}/playoffs`,
  };

  const handleTournamentRealtimeEvent = useCallback((event) => {
    if (!event || typeof event !== 'object') return;

    if (event.type === 'SCOREBOARD_SUMMARY') {
      const matchId = event.data?.matchId;
      if (!matchId) {
        return;
      }

      setLiveSummariesByMatchId((previous) => ({
        ...previous,
        [matchId]: event.data,
      }));
      return;
    }

    if (event.type === 'TOURNAMENT_RESET') {
      loadData().catch(() => {});
      return;
    }

    if (event.type === 'POOLS_UPDATED' && event.data?.stageKey === poolPlayStage?.key) {
      refreshStageData(formatDefRef.current).catch(() => {});
      return;
    }

    if (event.type === 'MATCHES_GENERATED') {
      const stageKey = String(event.data?.stageKey || '');
      if (stageKey && (stageKey === poolPlayStage?.key || stageKey === crossoverStage?.key)) {
        refreshStageData(formatDefRef.current).catch(() => {});
      }
      return;
    }

    if (event.type === 'SCHEDULE_PLAN_UPDATED') {
      refreshStageData(formatDefRef.current).catch(() => {});
      return;
    }

    if (['MATCH_STATUS_UPDATED', 'MATCH_FINALIZED', 'MATCH_UNFINALIZED'].includes(event.type)) {
      refreshStageData(formatDefRef.current).catch(() => {});
    }
  }, [crossoverStage?.key, loadData, poolPlayStage?.key, refreshStageData]);

  useTournamentRealtime({
    tournamentCode: tournament?.publicCode,
    enabled: Boolean(token && tournament?.publicCode),
    onEvent: handleTournamentRealtimeEvent,
  });

  const teamBank = useMemo(() => buildTeamBankFromPools(teams, pools), [pools, teams]);
  const teamsById = useMemo(() => new Map(teams.map((team) => [toIdString(team._id), team])), [teams]);
  const activeDragTeam = useMemo(() => {
    if (!activeDragTeamId) return null;

    const pooledTeam = pools
      .flatMap((pool) => (Array.isArray(pool.teamIds) ? pool.teamIds : []))
      .find((team) => toIdString(team?._id) === activeDragTeamId);
    if (pooledTeam) return pooledTeam;

    const bankTeam = teamBank.find((team) => toIdString(team?._id) === activeDragTeamId);
    if (bankTeam) return bankTeam;

    return teamsById.get(activeDragTeamId) || null;
  }, [activeDragTeamId, pools, teamBank, teamsById]);

  const expectedTotalCourts =
    toPositiveInteger(tournament?.settings?.format?.totalCourts)
    || toPositiveInteger(venue?.totalCourts)
    || DEFAULT_TOTAL_COURTS;
  const configuredCourtCount = useMemo(
    () => countVenueCourts(venueDraft?.facilities),
    [venueDraft?.facilities]
  );
  const enabledCourtCount = useMemo(
    () => countVenueCourts(venueDraft?.facilities, { enabledOnly: true }),
    [venueDraft?.facilities]
  );
  const flattenedVenueCourts = useMemo(
    () => flattenVenueCourts(venueDraft?.facilities),
    [venueDraft?.facilities]
  );
  const venueCourtById = useMemo(
    () => new Map(flattenedVenueCourts.map((court) => [court.courtId, court])),
    [flattenedVenueCourts]
  );
  const venueCourtByName = useMemo(
    () =>
      new Map(
        flattenedVenueCourts
          .map((court) => [String(court?.courtName || '').trim().toLowerCase(), court])
          .filter(([courtName]) => Boolean(courtName))
      ),
    [flattenedVenueCourts]
  );
  const venueCountMatchesFormat = configuredCourtCount === expectedTotalCourts;
  const venueDraftSignature = useMemo(() => JSON.stringify(venueDraft), [venueDraft]);
  const savedVenueSignature = useMemo(() => JSON.stringify(venue), [venue]);
  const venueHasUnsavedChanges = venueDraftSignature !== savedVenueSignature;

  const assignmentState = useMemo(() => {
    const missingPoolNames = [];
    const invalidPoolNames = [];
    const courtIdCounts = new Map();

    pools.forEach((pool) => {
      const assignedCourtId = toIdString(pool?.assignedCourtId);
      if (!assignedCourtId) {
        missingPoolNames.push(pool?.name || '?');
        return;
      }

      if (!venueCourtById.has(assignedCourtId)) {
        invalidPoolNames.push(pool?.name || '?');
      }

      courtIdCounts.set(assignedCourtId, (courtIdCounts.get(assignedCourtId) || 0) + 1);
    });

    const duplicateCourtIds = Array.from(courtIdCounts.entries())
      .filter(([, count]) => count > 1)
      .map(([courtId]) => courtId);
    const duplicateCourtLabels = duplicateCourtIds.map((courtId) => {
      const venueCourt = venueCourtById.get(courtId);
      return venueCourt?.courtName || courtId;
    });

    return {
      missingPoolNames,
      invalidPoolNames,
      duplicateCourtIds,
      duplicateCourtLabels,
    };
  }, [pools, venueCourtById]);

  const poolIssues = useMemo(() => pools
    .filter((pool) => (Array.isArray(pool.teamIds) ? pool.teamIds.length : 0) !== pool.requiredTeamCount)
    .map((pool) => {
      const currentCount = Array.isArray(pool.teamIds) ? pool.teamIds.length : 0;
      if (currentCount < pool.requiredTeamCount) {
        const missing = pool.requiredTeamCount - currentCount;
        return `Pool ${pool.name} needs ${missing} more team${missing === 1 ? '' : 's'}`;
      }
      return `Pool ${pool.name} has too many teams`;
    }), [pools]);

  const setFacilityCount = useCallback((nextCount) => {
    const normalizedCount = toPositiveInteger(nextCount, 1, 1, 12) || 1;
    setVenueDraft((current) => {
      const currentFacilities = Array.isArray(current?.facilities) ? current.facilities : [];
      const nextFacilities = [...currentFacilities];

      if (normalizedCount > nextFacilities.length) {
        while (nextFacilities.length < normalizedCount) {
          nextFacilities.push(buildDefaultFacility(nextFacilities.length, 1));
        }
      } else if (normalizedCount < nextFacilities.length) {
        nextFacilities.splice(normalizedCount);
      }

      return {
        ...current,
        facilities: nextFacilities,
      };
    });
  }, []);

  const updateFacility = useCallback((facilityId, updater) => {
    setVenueDraft((current) => ({
      ...current,
      facilities: (Array.isArray(current?.facilities) ? current.facilities : []).map((facility, index) =>
        toIdString(facility?.facilityId) === facilityId
          ? updater(facility, index)
          : facility
      ),
    }));
  }, []);

  const resizeFacilityCourts = useCallback((facilityId, requestedCount) => {
    const targetCount = toPositiveInteger(requestedCount, 1, 1, MAX_TOTAL_COURTS) || 1;
    updateFacility(facilityId, (facility) => {
      const existingCourts = Array.isArray(facility?.courts) ? [...facility.courts] : [];
      if (targetCount > existingCourts.length) {
        while (existingCourts.length < targetCount) {
          existingCourts.push({
            courtId: createLocalVenueId('court'),
            name: `Court ${existingCourts.length + 1}`,
            isEnabled: true,
          });
        }
      } else if (targetCount < existingCourts.length) {
        existingCourts.splice(targetCount);
      }

      return {
        ...facility,
        courts: existingCourts,
      };
    });
  }, [updateFacility]);

  const addCourtToFacility = useCallback((facilityId) => {
    updateFacility(facilityId, (facility) => {
      const currentCourts = Array.isArray(facility?.courts) ? facility.courts : [];
      return {
        ...facility,
        courts: [
          ...currentCourts,
          {
            courtId: createLocalVenueId('court'),
            name: `Court ${currentCourts.length + 1}`,
            isEnabled: true,
          },
        ],
      };
    });
  }, [updateFacility]);

  const removeCourtFromFacility = useCallback((facilityId, courtId) => {
    updateFacility(facilityId, (facility) => {
      const currentCourts = Array.isArray(facility?.courts) ? facility.courts : [];
      if (currentCourts.length <= 1) {
        return facility;
      }

      return {
        ...facility,
        courts: currentCourts.filter((court) => toIdString(court?.courtId) !== courtId),
      };
    });
  }, [updateFacility]);

  const handleSaveVenueSetup = useCallback(async () => {
    if (savingVenue) return;
    setSavingVenue(true);
    setError('');
    setMessage('');
    setPoolActionMessage('');

    try {
      const payload = await fetchJson(`${API_URL}/api/tournaments/${id}/venue`, {
        method: 'PUT',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          facilities: (Array.isArray(venueDraft?.facilities) ? venueDraft.facilities : []).map((facility) => ({
            facilityId: toIdString(facility?.facilityId) || undefined,
            name: typeof facility?.name === 'string' ? facility.name.trim() : '',
            courts: (Array.isArray(facility?.courts) ? facility.courts : []).map((court) => ({
              courtId: toIdString(court?.courtId) || undefined,
              name: typeof court?.name === 'string' ? court.name.trim() : '',
              isEnabled: court?.isEnabled !== false,
            })),
          })),
        }),
      });

      const normalizedVenue = normalizeVenuePayload(payload, expectedTotalCourts);
      setVenue(normalizedVenue);
      setVenueDraft(normalizedVenue);
      setTournament((current) => {
        if (!current) return current;
        return {
          ...current,
          settings: {
            ...(current.settings || {}),
            format: {
              ...(current.settings?.format || {}),
              totalCourts: toPositiveInteger(payload?.totalCourts) || expectedTotalCourts,
            },
            venue: {
              facilities: normalizedVenue.facilities,
            },
          },
        };
      });
      setMessage('Venue setup saved.');
    } catch (saveError) {
      setError(saveError.message || 'Unable to save venue setup');
    } finally {
      setSavingVenue(false);
    }
  }, [expectedTotalCourts, fetchJson, id, savingVenue, token, venueDraft]);

  const handlePoolAssignmentsChange = useCallback(async (nextPools) => {
    const normalizedNextPools = Array.isArray(nextPools)
      ? nextPools.map((pool) => normalizePool(pool))
      : [];
    const poolLookup = new Map(pools.map((pool) => [pool._id, pool]));
    const changedPools = normalizedNextPools.filter((pool) => {
      const previous = poolLookup.get(pool._id);
      return toIdString(previous?.assignedCourtId) !== toIdString(pool?.assignedCourtId);
    });

    if (changedPools.length === 0 || savingCourtAssignments) {
      return;
    }

    const previousPools = pools;
    setPools(normalizedNextPools);
    setSavingCourtAssignments(true);
    setError('');
    setMessage('');
    setPoolActionMessage('');

    try {
      for (const pool of changedPools) {
        const assignedCourtId = toIdString(pool?.assignedCourtId);

        if (!assignedCourtId) {
          await fetchJson(`${API_URL}/api/pools/${pool._id}`, {
            method: 'PATCH',
            headers: jsonHeaders(token),
            body: JSON.stringify({ assignedCourtId: null }),
          });
          continue;
        }

        await fetchJson(`${API_URL}/api/pools/${pool._id}/assign-court`, {
          method: 'PUT',
          headers: jsonHeaders(token),
          body: JSON.stringify({ assignedCourtId }),
        });
      }

      await refreshStageData(formatDefRef.current);
      setMessage('Pool court assignments saved.');
    } catch (assignError) {
      setPools(previousPools);
      setError(assignError.message || 'Unable to save pool court assignments');
    } finally {
      setSavingCourtAssignments(false);
    }
  }, [fetchJson, pools, refreshStageData, savingCourtAssignments, token]);

  const persistPoolChanges = useCallback(async ({ previousPools, nextPools, poolIdsToPersist }) => {
    const plan = buildTwoPassPoolPatchPlan({ previousPools, nextPools, poolIdsToPersist });
    const runPass = async (updates) => {
      for (const update of updates) {
        await fetchJson(`${API_URL}/api/pools/${update.poolId}`, {
          method: 'PATCH',
          headers: jsonHeaders(token),
          body: JSON.stringify({ teamIds: update.teamIds }),
        });
      }
    };

    if (plan.passOne.length > 0) await runPass(plan.passOne);
    if (plan.passTwo.length > 0) await runPass(plan.passTwo);
  }, [fetchJson, token]);

  const handleDragStart = useCallback((event) => setActiveDragTeamId(String(event?.active?.id || '')), []);
  const handleDragCancel = useCallback(() => setActiveDragTeamId(''), []);

  const handleDragEnd = useCallback(async (event) => {
    setActiveDragTeamId('');
    if (!event?.active?.id || !event?.over?.id || savingPools || savingVenue || savingCourtAssignments) return;

    const previousPools = clonePoolsForDnd(pools);
    const preview = computeTeamDragPreview({
      pools: previousPools,
      teams,
      activeTeamId: String(event.active.id),
      overId: String(event.over.id),
    });

    if (!preview) return;
    if (preview.error) {
      setError(preview.error);
      return;
    }

    const changedPoolIds = collectChangedPoolIds(previousPools, preview.nextPools);
    const poolIdsToPersist = changedPoolIds.filter((poolId) => preview.poolIdsToPersist.includes(poolId));
    if (poolIdsToPersist.length === 0) return;

    setPools(clonePoolsForDnd(preview.nextPools));
    setSavingPools(true);
    setError('');

    try {
      await persistPoolChanges({ previousPools, nextPools: preview.nextPools, poolIdsToPersist });
      await refreshStageData(formatDefRef.current);
    } catch (persistError) {
      setPools(previousPools);
      setError(persistError.message || 'Unable to save pools');
    } finally {
      setSavingPools(false);
    }
  }, [persistPoolChanges, pools, refreshStageData, savingCourtAssignments, savingPools, savingVenue, teams]);

  const initializePoolsFromTemplate = useCallback(async () => {
    if (!poolPlayStage || initializingPools) return;
    setInitializingPools(true);
    setError('');
    setMessage('');
    setPoolActionMessage('');

    try {
      const payload = await fetchJson(`${API_URL}/api/tournaments/${id}/stages/${poolPlayStage.key}/pools/init`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      setPools(Array.isArray(payload) ? payload.map((pool) => normalizePool(pool)) : []);
      setPoolActionMessage(`${poolPlayStageLabel} pools initialized from template.`);
    } catch (initError) {
      setError(initError.message || 'Unable to initialize pools');
    } finally {
      setInitializingPools(false);
    }
  }, [fetchJson, id, initializingPools, poolPlayStage, poolPlayStageLabel, token]);

  useEffect(() => {
    const nextStageKey = toIdString(poolPlayStage?.key);
    if (autoInitStageKeyRef.current !== nextStageKey) {
      autoInitStageKeyRef.current = nextStageKey;
      autoInitAttemptedRef.current = false;
    }
  }, [poolPlayStage?.key]);

  useEffect(() => {
    if (!poolPlayStage || loading || initializingPools || savingPools || savingVenue || savingCourtAssignments) {
      return;
    }
    if (pools.length > 0) {
      return;
    }
    if (autoInitAttemptedRef.current) {
      return;
    }

    autoInitAttemptedRef.current = true;
    initializePoolsFromTemplate().catch(() => {});
  }, [
    initializePoolsFromTemplate,
    initializingPools,
    loading,
    poolPlayStage,
    pools.length,
    savingCourtAssignments,
    savingPools,
    savingVenue,
  ]);

  const handleAutofillPools = useCallback(async () => {
    if (!poolPlayStage || autofillingPools) return;
    setAutofillingPools(true);
    setError('');
    setMessage('');
    setPoolActionMessage('');

    const runAutofill = async (force) => {
      const response = await fetch(`${API_URL}/api/tournaments/${id}/stages/${poolPlayStage.key}/pools/autofill${force ? '?force=true' : ''}`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      const payload = await response.json().catch(() => null);

      if (response.status === 409 && !force) {
        return { requiresForce: true, message: payload?.message || 'Pools already have assignments.' };
      }
      if (!response.ok) throw new Error(payload?.message || 'Unable to distribute teams');
      return { requiresForce: false, payload };
    };

    try {
      const firstAttempt = await runAutofill(false);
      if (firstAttempt.requiresForce) {
        const shouldForce = window.confirm(`${firstAttempt.message}\n\nThis will overwrite current assignments. Continue?`);
        if (!shouldForce) {
          setPoolActionMessage(firstAttempt.message);
          return;
        }

        const forcedAttempt = await runAutofill(true);
        setPools(Array.isArray(forcedAttempt.payload) ? forcedAttempt.payload.map((pool) => normalizePool(pool)) : []);
      } else {
        setPools(Array.isArray(firstAttempt.payload) ? firstAttempt.payload.map((pool) => normalizePool(pool)) : []);
      }
      setPoolActionMessage('Teams distributed by ranking order.');
    } catch (autofillError) {
      setError(autofillError.message || 'Unable to distribute teams');
    } finally {
      setAutofillingPools(false);
    }
  }, [autofillingPools, id, poolPlayStage, token]);

  const generationBlockingIssues = useMemo(() => {
    const issues = [];

    if (!poolPlayStage) {
      issues.push('Pool play stage is not configured for the selected format.');
      return issues;
    }

    if (pools.length === 0) {
      if (initializingPools) {
        issues.push('Pool shells are being initialized from the applied format template.');
      } else {
        issues.push('Pool shells are missing. Re-apply format if they do not auto-initialize.');
      }
      return issues;
    }

    if (poolIssues.length > 0) {
      issues.push(...poolIssues);
    }

    if (!venueCountMatchesFormat) {
      issues.push(
        `Total courts configured (${configuredCourtCount}) must equal courts available in Format (${expectedTotalCourts}).`
      );
    }

    if (enabledCourtCount < 1) {
      issues.push('Enable at least one court in Venue Setup.');
    }

    if (assignmentState.missingPoolNames.length > 0) {
      issues.push(
        `Assign courts for: ${assignmentState.missingPoolNames
          .map((poolName) => `Pool ${poolName}`)
          .join(', ')}.`
      );
    }

    if (assignmentState.invalidPoolNames.length > 0) {
      issues.push(
        `Pools reference removed courts: ${assignmentState.invalidPoolNames
          .map((poolName) => `Pool ${poolName}`)
          .join(', ')}.`
      );
    }

    if (assignmentState.duplicateCourtLabels.length > 0) {
      issues.push(
        `Each pool must have a unique court. Duplicates: ${assignmentState.duplicateCourtLabels.join(', ')}.`
      );
    }

    if (pools.length > enabledCourtCount) {
      issues.push(
        `${poolPlayStageLabel} has ${pools.length} pools but only ${enabledCourtCount} enabled courts. Wave scheduling is not supported yet.`
      );
    }

    return issues;
  }, [
    assignmentState.duplicateCourtLabels,
    assignmentState.invalidPoolNames,
    assignmentState.missingPoolNames,
    configuredCourtCount,
    enabledCourtCount,
    expectedTotalCourts,
    poolIssues,
    poolPlayStage,
    poolPlayStageLabel,
    pools.length,
    initializingPools,
    venueCountMatchesFormat,
  ]);

  const canGenerateMatches = Boolean(poolPlayStage)
    && pools.length > 0
    && generationBlockingIssues.length === 0
    && !savingPools
    && !savingVenue
    && !savingCourtAssignments;

  const handleGenerateMatches = useCallback(async () => {
    if (!poolPlayStage || !canGenerateMatches || generatingMatches) return;
    setGeneratingMatches(true);
    setError('');
    setMessage('');
    setPoolActionMessage('');

    const runGenerate = async (force) => {
      const response = await fetch(`${API_URL}/api/tournaments/${id}/stages/${poolPlayStage.key}/matches/generate${force ? '?force=true' : ''}`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      const payload = await response.json().catch(() => null);

      if (response.status === 409 && !force) {
        return { requiresForce: true, message: payload?.message || 'Matches already generated.' };
      }
      if (!response.ok) throw new Error(payload?.message || 'Unable to generate matches');
      return { requiresForce: false };
    };

    try {
      const firstAttempt = await runGenerate(false);
      if (firstAttempt.requiresForce) {
        const shouldForce = window.confirm(`${firstAttempt.message}\n\nThis will delete and regenerate stage matches. Continue?`);
        if (!shouldForce) {
          setPoolActionMessage(firstAttempt.message);
          return;
        }
        await runGenerate(true);
      }

      await refreshStageData(formatDefRef.current);
      setPoolActionMessage(`${poolPlayStageLabel} matches generated.`);
    } catch (generateError) {
      setError(generateError.message || 'Unable to generate matches');
    } finally {
      setGeneratingMatches(false);
    }
  }, [canGenerateMatches, generatingMatches, id, poolPlayStage, poolPlayStageLabel, refreshStageData, token]);

  const handleResetTournament = useCallback(async () => {
    if (!token || !id || resettingTournament || !tournament?.isOwner) return;

    const confirmed = window.confirm(
      'Reset this tournament?\n\nThis deletes all pools, matches, and linked scoreboards, clears standings overrides, and sets status back to setup. Teams, details, and format settings stay.'
    );
    if (!confirmed) return;

    setResettingTournament(true);
    setError('');
    setMessage('');
    setPoolActionMessage('');

    try {
      await fetchJson(`${API_URL}/api/tournaments/${id}/reset`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      setMessage('Tournament reset. Redirecting to format setup.');
      navigate(`/tournaments/${id}/format`, { replace: true });
    } catch (resetError) {
      setError(resetError.message || 'Unable to reset tournament');
    } finally {
      setResettingTournament(false);
    }
  }, [fetchJson, id, navigate, resettingTournament, token, tournament?.isOwner]);

  const crossoverSourcePoolNames = useMemo(
    () =>
      (Array.isArray(crossoverStage?.fromPools) ? crossoverStage.fromPools : [])
        .map((poolName) => String(poolName || '').trim())
        .filter(Boolean),
    [crossoverStage?.fromPools]
  );
  const crossoverSourcePoolMatchTargets = useMemo(() => {
    const poolSizesByName = new Map(
      (Array.isArray(poolPlayStage?.pools) ? poolPlayStage.pools : [])
        .map((poolDef) => [String(poolDef?.name || '').trim(), Number(poolDef?.size || 0)])
        .filter(([poolName]) => Boolean(poolName))
    );
    const targetsByName = new Map();
    crossoverSourcePoolNames.forEach((poolName) => {
      const poolSize = poolSizesByName.get(poolName);
      const targetMatches = getRoundRobinMatchCountForPoolSize(poolSize);
      if (targetMatches > 0) {
        targetsByName.set(poolName, targetMatches);
      }
    });
    return targetsByName;
  }, [crossoverSourcePoolNames, poolPlayStage?.pools]);
  const areCrossoverSourcePoolsFinalized = useMemo(() => {
    if (crossoverSourcePoolNames.length === 0) {
      return false;
    }

    return crossoverSourcePoolNames.every((poolName) => {
      const matchesForPool = poolPlayMatches.filter(
        (match) => String(match?.poolName || '').trim() === poolName
      );
      const requiredMatchCount = crossoverSourcePoolMatchTargets.get(poolName) || 0;
      if (requiredMatchCount <= 0 || matchesForPool.length < requiredMatchCount) {
        return false;
      }

      const finalizedCount = matchesForPool.filter((match) => isMatchFinalized(match)).length;
      return finalizedCount >= requiredMatchCount;
    });
  }, [crossoverSourcePoolMatchTargets, crossoverSourcePoolNames, poolPlayMatches]);
  const crossoverTemplateMatches = useMemo(() => {
    if (!crossoverStage || crossoverSourcePoolNames.length !== 2) {
      return [];
    }

    const [leftPoolName, rightPoolName] = crossoverSourcePoolNames;
    const sourcePoolMatchRows = poolPlayMatches.filter((match) =>
      crossoverSourcePoolNames.includes(String(match?.poolName || '').trim())
    );

    // Keep schedule empty until Pool Play matches have been generated.
    if (sourcePoolMatchRows.length === 0) {
      return [];
    }

    const maxSourceRoundBlock = sourcePoolMatchRows.reduce((maxValue, match) => {
      const roundBlock = Number(match?.roundBlock);
      if (!Number.isFinite(roundBlock) || roundBlock <= 0) {
        return maxValue;
      }

      return Math.max(maxValue, Math.floor(roundBlock));
    }, 0);

    if (maxSourceRoundBlock <= 0) {
      return [];
    }

    const poolDefByName = new Map(
      (Array.isArray(poolPlayStage?.pools) ? poolPlayStage.pools : [])
        .map((poolDef) => [String(poolDef?.name || '').trim(), poolDef])
        .filter(([poolName]) => Boolean(poolName))
    );
    const poolByName = new Map(
      pools
        .map((pool) => [String(pool?.name || '').trim(), pool])
        .filter(([poolName]) => Boolean(poolName))
    );
    const leftPoolSize = Number(poolDefByName.get(leftPoolName)?.size || 0);
    const rightPoolSize = Number(poolDefByName.get(rightPoolName)?.size || 0);
    const pairingCount = Math.min(leftPoolSize, rightPoolSize);

    if (!Number.isFinite(pairingCount) || pairingCount <= 0) {
      return [];
    }

    const toCourtEntry = (court) => {
      if (!court) {
        return null;
      }

      const courtId = toIdString(court?.courtId);
      const courtName =
        typeof court?.courtName === 'string'
          ? court.courtName.trim()
          : typeof court?.name === 'string'
            ? court.name.trim()
            : '';

      if (!courtId && !courtName) {
        return null;
      }

      return {
        courtId: courtId || null,
        facilityId: toIdString(court?.facilityId) || null,
        courtName: courtName || null,
      };
    };

    const resolvePoolCourt = (poolName) => {
      const pool = poolByName.get(poolName);
      if (!pool) {
        return null;
      }

      const assignedCourtId = toIdString(pool?.assignedCourtId);
      if (assignedCourtId && venueCourtById.has(assignedCourtId)) {
        return toCourtEntry(venueCourtById.get(assignedCourtId));
      }

      const homeCourtName =
        typeof pool?.homeCourt === 'string' ? pool.homeCourt.trim().toLowerCase() : '';
      if (homeCourtName && venueCourtByName.has(homeCourtName)) {
        return toCourtEntry(venueCourtByName.get(homeCourtName));
      }

      return null;
    };

    const sourcePoolCourts = crossoverSourcePoolNames
      .map((poolName) => resolvePoolCourt(poolName))
      .filter(Boolean);
    const sourceMatchCourts = sourcePoolMatchRows
      .map((match) => {
        const courtId = toIdString(match?.courtId);
        if (courtId && venueCourtById.has(courtId)) {
          return toCourtEntry(venueCourtById.get(courtId));
        }

        const courtName =
          typeof match?.court === 'string' ? match.court.trim().toLowerCase() : '';
        if (courtName && venueCourtByName.has(courtName)) {
          return toCourtEntry(venueCourtByName.get(courtName));
        }

        return toCourtEntry({
          courtId: courtId || null,
          facilityId: null,
          courtName: typeof match?.court === 'string' ? match.court.trim() : '',
        });
      })
      .filter(Boolean);

    const selectedCourts = [];
    const seenCourtKeys = new Set();
    [...sourcePoolCourts, ...sourceMatchCourts].forEach((court) => {
      const key =
        toIdString(court?.courtId)
        || (typeof court?.courtName === 'string' ? court.courtName.trim().toLowerCase() : '');
      if (!key || seenCourtKeys.has(key)) {
        return;
      }

      seenCourtKeys.add(key);
      selectedCourts.push(court);
    });

    if (selectedCourts.length === 0) {
      flattenedVenueCourts
        .filter((court) => court?.isEnabled !== false)
        .forEach((court) => {
          const normalized = toCourtEntry(court);
          const key =
            toIdString(normalized?.courtId)
            || (typeof normalized?.courtName === 'string'
              ? normalized.courtName.trim().toLowerCase()
              : '');
          if (!key || seenCourtKeys.has(key)) {
            return;
          }
          seenCourtKeys.add(key);
          selectedCourts.push(normalized);
        });
    }

    if (selectedCourts.length === 0) {
      return [];
    }

    const getRoundBlock = (index) => {
      if (selectedCourts.length >= 2) {
        return index <= 1 ? maxSourceRoundBlock + 1 : maxSourceRoundBlock + 2;
      }
      return maxSourceRoundBlock + 1 + index;
    };

    const getCourt = (index) => {
      if (selectedCourts.length >= 2) {
        return selectedCourts[index <= 1 ? index : 0];
      }
      return selectedCourts[0];
    };

    const getRefLabel = (index) => {
      if (pairingCount >= 3) {
        if (index === 0) return formatPoolRankLabel(leftPoolName, 3);
        if (index === 1) return formatPoolRankLabel(rightPoolName, 3);
        if (index === 2) return formatPoolRankLabel(rightPoolName, 2);
        return '';
      }

      if (index === 0) return pairingCount >= 2 ? formatPoolRankLabel(leftPoolName, 2) : '';
      if (index === 1) return pairingCount >= 2 ? formatPoolRankLabel(rightPoolName, 2) : '';
      return '';
    };

    const getByeLabel = (index) => {
      if (pairingCount < 3 || index !== 2) {
        return '';
      }

      return [
        formatPoolRankLabel(leftPoolName, 1),
        formatPoolRankLabel(rightPoolName, 1),
        formatPoolRankLabel(leftPoolName, 2),
      ].join(', ');
    };

    return Array.from({ length: pairingCount }, (_, index) => {
      const scheduledCourt = getCourt(index);
      const teamALabel = formatPoolRankLabel(leftPoolName, index + 1);
      const teamBLabel = formatPoolRankLabel(rightPoolName, index + 1);
      const refLabel = getRefLabel(index);
      const byeLabel = getByeLabel(index);

      return {
        _id: `crossover-template-${leftPoolName}-${rightPoolName}-${index + 1}`,
        stageKey: crossoverStage.key,
        roundBlock: getRoundBlock(index),
        courtId: scheduledCourt?.courtId || null,
        facilityId: scheduledCourt?.facilityId || null,
        court: scheduledCourt?.courtName || null,
        poolName: null,
        status: 'scheduled',
        teamA: { shortName: teamALabel, name: teamALabel },
        teamB: { shortName: teamBLabel, name: teamBLabel },
        refTeams: refLabel ? [{ shortName: refLabel, name: refLabel }] : [],
        __isTemplate: true,
        __templateByeLabel: byeLabel || null,
      };
    });
  }, [
    crossoverSourcePoolNames,
    crossoverStage,
    flattenedVenueCourts,
    poolPlayMatches,
    poolPlayStage?.pools,
    pools,
    venueCourtById,
    venueCourtByName,
  ]);
  const crossoverTemplateRoundBlocks = useMemo(
    () =>
      crossoverTemplateMatches
        .map((match) => Number(match?.roundBlock))
        .filter((roundBlock) => Number.isFinite(roundBlock) && roundBlock > 0)
        .sort((left, right) => left - right),
    [crossoverTemplateMatches]
  );
  const crossoverRoundBlocks = useMemo(
    () =>
      crossoverMatches
        .map((match) => Number(match?.roundBlock))
        .filter((roundBlock) => Number.isFinite(roundBlock) && roundBlock > 0)
        .sort((left, right) => left - right),
    [crossoverMatches]
  );
  const crossoverRoundBlockMismatch = useMemo(() => {
    if (crossoverMatches.length === 0 || crossoverTemplateRoundBlocks.length === 0) {
      return false;
    }

    if (crossoverRoundBlocks.length !== crossoverTemplateRoundBlocks.length) {
      return true;
    }

    return crossoverRoundBlocks.some((roundBlock, index) => (
      roundBlock !== crossoverTemplateRoundBlocks[index]
    ));
  }, [crossoverMatches.length, crossoverRoundBlocks, crossoverTemplateRoundBlocks]);
  const crossoverHasLegacyCourtAssignments = useMemo(
    () =>
      crossoverMatches.some((match) => {
        const courtName = typeof match?.court === 'string' ? match.court.trim() : '';
        return Boolean(courtName && !toIdString(match?.courtId));
      }),
    [crossoverMatches]
  );
  const crossoverHasStartedMatches = useMemo(
    () =>
      crossoverMatches.some((match) => {
        const status = String(match?.status || '').trim().toLowerCase();
        return status === 'live' || isMatchFinalized(match);
      }),
    [crossoverMatches]
  );
  const shouldAutoRepairCrossoverSchedule = Boolean(
    crossoverStage?.key
    && areCrossoverSourcePoolsFinalized
    && crossoverMatches.length > 0
    && crossoverTemplateMatches.length > 0
    && !crossoverHasStartedMatches
    && (crossoverRoundBlockMismatch || crossoverHasLegacyCourtAssignments)
  );
  const displayedCrossoverMatches = crossoverMatches.length > 0
    ? crossoverMatches
    : crossoverTemplateMatches;
  const showingCrossoverTemplates = Boolean(crossoverStage)
    && crossoverMatches.length === 0
    && displayedCrossoverMatches.length > 0;
  const crossoverTemplateNote = useMemo(() => {
    const poolLabels = crossoverSourcePoolNames.map((poolName) => `Pool ${poolName}`);
    const poolsText =
      poolLabels.length === 0
        ? 'the source pools'
        : poolLabels.length === 1
          ? poolLabels[0]
          : `${poolLabels.slice(0, -1).join(', ')} and ${poolLabels[poolLabels.length - 1]}`;
    const requiredCounts = crossoverSourcePoolNames
      .map((poolName) => crossoverSourcePoolMatchTargets.get(poolName))
      .filter((count) => Number.isFinite(count) && count > 0);
    const matchesText =
      requiredCounts.length > 0 && requiredCounts.every((count) => count === requiredCounts[0])
        ? `${requiredCounts[0]} match${requiredCounts[0] === 1 ? '' : 'es'}`
        : 'all matches';

    return `Crossover slots are placeholders by pool rank. Complete ${matchesText} in ${poolsText} to auto-populate crossover matchups.`;
  }, [crossoverSourcePoolMatchTargets, crossoverSourcePoolNames]);
  const autoGenerateCrossoverMatches = useCallback(async ({
    force = false,
    successMessage = 'Crossover matches auto-populated from finalized source pool standings.',
  } = {}) => {
    if (!token || !id || !crossoverStage?.key) {
      return;
    }

    const query = force ? '?force=true' : '';
    const response = await fetch(
      `${API_URL}/api/tournaments/${id}/stages/${crossoverStage.key}/matches/generate${query}`,
      {
        method: 'POST',
        headers: authHeaders(token),
      }
    );
    const payload = await response.json().catch(() => null);

    if (!response.ok && response.status !== 409) {
      throw new Error(payload?.message || 'Unable to auto-generate crossover matches');
    }

    await refreshStageData(formatDefRef.current);
    if (response.status !== 409 && successMessage) {
      setPoolActionMessage(successMessage);
    }
  }, [crossoverStage?.key, id, refreshStageData, token]);

  useEffect(() => {
    if (
      !crossoverStage?.key
      || !areCrossoverSourcePoolsFinalized
      || crossoverMatches.length > 0
      || generatingMatches
      || savingPools
      || savingVenue
      || savingCourtAssignments
      || stageReloadInFlightRef.current
    ) {
      return;
    }

    const finalizedCount = poolPlayMatches.filter((match) => isMatchFinalized(match)).length;
    const attemptKey = `${crossoverStage.key}:${finalizedCount}:${crossoverSourcePoolNames.join(',')}`;

    if (autoGenerateCrossoverAttemptKeyRef.current === attemptKey) {
      return;
    }
    if (autoGenerateCrossoverInFlightRef.current) {
      return;
    }

    autoGenerateCrossoverAttemptKeyRef.current = attemptKey;
    autoGenerateCrossoverInFlightRef.current = true;
    autoGenerateCrossoverMatches()
      .catch((autoGenerateError) => {
        setPoolActionMessage(
          autoGenerateError?.message
          || 'Crossover matchups are still pending. Finalize source pool matches to continue.'
        );
      })
      .finally(() => {
        autoGenerateCrossoverInFlightRef.current = false;
      });
  }, [
    areCrossoverSourcePoolsFinalized,
    autoGenerateCrossoverMatches,
    crossoverMatches.length,
    crossoverSourcePoolNames,
    crossoverStage?.key,
    generatingMatches,
    poolPlayMatches,
    savingCourtAssignments,
    savingPools,
    savingVenue,
  ]);
  useEffect(() => {
    if (
      !shouldAutoRepairCrossoverSchedule
      || generatingMatches
      || savingPools
      || savingVenue
      || savingCourtAssignments
      || stageReloadInFlightRef.current
    ) {
      return;
    }

    const repairAttemptKey = `${crossoverStage?.key || ''}:${crossoverRoundBlocks.join(',')}:${Number(crossoverHasLegacyCourtAssignments)}`;
    if (autoRepairCrossoverAttemptKeyRef.current === repairAttemptKey) {
      return;
    }
    if (autoGenerateCrossoverInFlightRef.current) {
      return;
    }

    autoRepairCrossoverAttemptKeyRef.current = repairAttemptKey;
    autoGenerateCrossoverInFlightRef.current = true;
    autoGenerateCrossoverMatches({
      force: true,
      successMessage: 'Crossover schedule refreshed to match format time slots and court assignments.',
    })
      .catch((autoGenerateError) => {
        setPoolActionMessage(
          autoGenerateError?.message
          || 'Unable to refresh crossover schedule. Regenerate crossover matches after pool results finalize.'
        );
      })
      .finally(() => {
        autoGenerateCrossoverInFlightRef.current = false;
      });
  }, [
    autoGenerateCrossoverMatches,
    crossoverHasLegacyCourtAssignments,
    crossoverRoundBlocks,
    crossoverStage?.key,
    generatingMatches,
    savingCourtAssignments,
    savingPools,
    savingVenue,
    shouldAutoRepairCrossoverSchedule,
  ]);

  const scheduleTableSlots = useMemo(
    () =>
      (Array.isArray(schedulePlanSlots) ? schedulePlanSlots : []).filter(
        (slot) => String(slot?.kind || 'match').trim().toLowerCase() === 'match'
      ),
    [schedulePlanSlots]
  );
  const scheduleRoundBlocks = useMemo(
    () => Array.from(new Set(
      scheduleTableSlots
        .map((slot) => Number(slot?.roundBlock))
        .filter((roundBlock) => Number.isFinite(roundBlock) && roundBlock > 0)
        .map((roundBlock) => Math.floor(roundBlock))
    )).sort((a, b) => a - b),
    [scheduleTableSlots]
  );
  const scheduleCourts = useMemo(() => {
    const usedCourts = new Map();

    scheduleTableSlots.forEach((slot) => {
      const courtCode = typeof slot?.courtCode === 'string' ? slot.courtCode.trim() : '';
      if (!courtCode || usedCourts.has(courtCode)) {
        return;
      }

      const venueCourt = venueCourtById.get(courtCode)
        || venueCourtByName.get(courtCode.toLowerCase());
      usedCourts.set(courtCode, {
        key: courtCode,
        label: mapCourtLabel(venueCourt?.courtName || courtCode),
      });
    });

    if (usedCourts.size > 0) {
      return Array.from(usedCourts.values()).sort((a, b) => a.label.localeCompare(b.label));
    }

    return flattenedVenueCourts
      .filter((court) => court.isEnabled !== false)
      .map((court) => ({
        key: court.courtId,
        label: court.courtName,
      }));
  }, [scheduleTableSlots, flattenedVenueCourts, venueCourtById, venueCourtByName]);
  const scheduleLookup = useMemo(() => {
    const lookup = {};
    scheduleTableSlots.forEach((slot) => {
      const roundBlock = Number(slot?.roundBlock);
      const courtCode = typeof slot?.courtCode === 'string' ? slot.courtCode.trim() : '';
      if (!Number.isFinite(roundBlock) || roundBlock <= 0 || !courtCode) {
        return;
      }

      lookup[`${Math.floor(roundBlock)}-${courtCode}`] = slot;
    });
    return lookup;
  }, [scheduleTableSlots]);

  const activeStandings = activeStandingsTab === 'cumulative'
    ? standingsByPhase.cumulative
    : standingsByPhase.phase1;

  if (initializing || loading) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <TournamentAdminNav
            tournamentId={id}
            publicCode={tournament?.publicCode || ''}
            activeMainTab="scheduling"
            scheduling={nonLegacySchedulingNav}
          />
          <p className="subtle">Loading pool play setup...</p>
        </section>
      </main>
    );
  }

  if (!user || !token) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <h1 className="title">Pool Play Setup</h1>
          <TournamentAdminNav
            tournamentId={id}
            publicCode={tournament?.publicCode || ''}
            activeMainTab="scheduling"
            scheduling={nonLegacySchedulingNav}
          />
          <p className="subtle">Sign in to manage pool play scheduling.</p>
          <a className="primary-button" href="/?mode=signin">Sign In</a>
        </section>
      </main>
    );
  }

  if (!hasAppliedFormat) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <h1 className="title">Pool Play Setup</h1>
          <TournamentAdminNav
            tournamentId={id}
            publicCode={tournament?.publicCode || ''}
            activeMainTab="scheduling"
            scheduling={nonLegacySchedulingNav}
          />
          <p className="error">Apply format first.</p>
          <a className="secondary-button" href={`/tournaments/${id}/format`}>Open Format Page</a>
        </section>
      </main>
    );
  }

  if (isLegacyFormat) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <h1 className="title">Pool Play Setup</h1>
          <TournamentAdminNav
            tournamentId={id}
            publicCode={tournament?.publicCode || ''}
            activeMainTab="scheduling"
            scheduling={legacySchedulingNav}
          />
          <p className="error">Wrong page for current format. Use Pool Play 1 for ODU 15.</p>
          <a className="secondary-button" href={`/tournaments/${id}/phase1`}>Open Pool Play 1</a>
        </section>
      </main>
    );
  }

  return (
    <main className="container">
      <section className="card phase1-admin-card">
        <div className="phase1-admin-header">
          <div>
            <h1 className="title">{poolPlayStageLabel} Setup</h1>
            <p className="subtitle">
              {tournament?.name || 'Tournament'} • Build pools from template, distribute teams, and generate matches.
            </p>
            <TournamentAdminNav
              tournamentId={id}
              publicCode={tournament?.publicCode || ''}
              activeMainTab="scheduling"
              scheduling={nonLegacySchedulingNav}
            />
          </div>
          <div className="phase1-admin-actions">
            {tournament?.isOwner && (
              <button className="secondary-button danger-button" type="button" onClick={handleResetTournament} disabled={resettingTournament}>
                {resettingTournament ? 'Resetting...' : 'Reset Tournament'}
              </button>
            )}
          </div>
        </div>

        {(initializingPools || savingPools || savingCourtAssignments || savingVenue) && (
          <p className="subtle">
            {initializingPools
              ? 'Initializing pool shells from format template...'
              : savingVenue
              ? 'Saving venue setup...'
              : savingCourtAssignments
                ? 'Saving pool court assignments...'
                : 'Saving pool changes...'}
          </p>
        )}

        {error && <p className="error">{error}</p>}
        {message && <p className="subtle phase1-success">{message}</p>}

        <section className="venue-setup-section">
          <header className="venue-setup-header">
            <div>
              <h2 className="secondary-title">Venue Setup</h2>
              <p className="subtle">
                Configure facilities and court names. This setup is used for real pool-play match generation.
              </p>
            </div>
            <div className="phase1-admin-actions">
              <label className="venue-setup-count">
                <span>Facilities</span>
                <input
                  type="number"
                  min={1}
                  max={12}
                  value={Array.isArray(venueDraft?.facilities) ? venueDraft.facilities.length : 1}
                  onChange={(event) => setFacilityCount(event.target.value)}
                  disabled={savingVenue || savingCourtAssignments}
                />
              </label>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setFacilityCount((Array.isArray(venueDraft?.facilities) ? venueDraft.facilities.length : 1) + 1)}
                disabled={savingVenue || savingCourtAssignments}
              >
                Add Facility
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={handleSaveVenueSetup}
                disabled={!venueHasUnsavedChanges || savingVenue || savingCourtAssignments || !venueCountMatchesFormat}
              >
                {savingVenue ? 'Saving Venue...' : 'Save Venue Setup'}
              </button>
            </div>
          </header>

          <p className={`subtle venue-setup-total ${venueCountMatchesFormat ? '' : 'venue-setup-total--warn'}`.trim()}>
            Total courts configured: {configuredCourtCount} / {expectedTotalCourts}
          </p>

          <div className="venue-facility-grid">
            {(Array.isArray(venueDraft?.facilities) ? venueDraft.facilities : []).map((facility, facilityIndex) => {
              const facilityId = toIdString(facility?.facilityId);
              const facilityCourts = Array.isArray(facility?.courts) ? facility.courts : [];
              return (
                <article key={facilityId || `facility-${facilityIndex}`} className="venue-facility-card">
                  <div className="venue-facility-header">
                    <h3>Facility {facilityIndex + 1}</h3>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() =>
                        setVenueDraft((current) => {
                          const currentFacilities = Array.isArray(current?.facilities)
                            ? current.facilities
                            : [];
                          if (currentFacilities.length <= 1) {
                            return current;
                          }
                          return {
                            ...current,
                            facilities: currentFacilities.filter(
                              (entry) => toIdString(entry?.facilityId) !== facilityId
                            ),
                          };
                        })
                      }
                      disabled={savingVenue || savingCourtAssignments || (Array.isArray(venueDraft?.facilities) ? venueDraft.facilities.length : 1) <= 1}
                    >
                      Remove Facility
                    </button>
                  </div>

                  <label className="input-label" htmlFor={`facility-name-${facilityId}`}>
                    Facility name
                  </label>
                  <input
                    id={`facility-name-${facilityId}`}
                    className="text-input"
                    type="text"
                    value={facility?.name || ''}
                    onChange={(event) =>
                      updateFacility(facilityId, (entry) => ({
                        ...entry,
                        name: event.target.value,
                      }))
                    }
                    disabled={savingVenue || savingCourtAssignments}
                  />

                  <label className="input-label" htmlFor={`facility-courts-${facilityId}`}>
                    Number of courts
                  </label>
                  <input
                    id={`facility-courts-${facilityId}`}
                    className="text-input venue-courts-count-input"
                    type="number"
                    min={1}
                    max={MAX_TOTAL_COURTS}
                    value={facilityCourts.length || 1}
                    onChange={(event) => resizeFacilityCourts(facilityId, event.target.value)}
                    disabled={savingVenue || savingCourtAssignments}
                  />

                  <div className="venue-court-list">
                    {facilityCourts.map((court, courtIndex) => {
                      const courtId = toIdString(court?.courtId);
                      return (
                        <div key={courtId || `${facilityId}-court-${courtIndex}`} className="venue-court-row">
                          <input
                            className="text-input"
                            type="text"
                            value={court?.name || ''}
                            onChange={(event) =>
                              updateFacility(facilityId, (entry) => ({
                                ...entry,
                                courts: (Array.isArray(entry?.courts) ? entry.courts : []).map((existingCourt) =>
                                  toIdString(existingCourt?.courtId) === courtId
                                    ? {
                                        ...existingCourt,
                                        name: event.target.value,
                                      }
                                    : existingCourt
                                ),
                              }))
                            }
                            placeholder={`Court ${courtIndex + 1}`}
                            disabled={savingVenue || savingCourtAssignments}
                          />
                          <label className="venue-court-enabled">
                            <input
                              type="checkbox"
                              checked={court?.isEnabled !== false}
                              onChange={(event) =>
                                updateFacility(facilityId, (entry) => ({
                                  ...entry,
                                  courts: (Array.isArray(entry?.courts) ? entry.courts : []).map((existingCourt) =>
                                    toIdString(existingCourt?.courtId) === courtId
                                      ? {
                                          ...existingCourt,
                                          isEnabled: event.target.checked,
                                        }
                                      : existingCourt
                                  ),
                                }))
                              }
                              disabled={savingVenue || savingCourtAssignments}
                            />
                            Enabled
                          </label>
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={() => removeCourtFromFacility(facilityId, courtId)}
                            disabled={savingVenue || savingCourtAssignments || facilityCourts.length <= 1}
                          >
                            Remove
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => addCourtToFacility(facilityId)}
                    disabled={savingVenue || savingCourtAssignments}
                  >
                    Add Court
                  </button>
                </article>
              );
            })}
          </div>
        </section>

        <section className="court-assignments-section">
          <h2 className="secondary-title">Pool to Court Assignment</h2>
          <p className="subtle">Drag each pool card to its court. Assign every pool before generating matches.</p>
          {assignmentState.missingPoolNames.length > 0 && (
            <p className="error">
              Missing assignments: {assignmentState.missingPoolNames.map((poolName) => `Pool ${poolName}`).join(', ')}.
            </p>
          )}
          {assignmentState.invalidPoolNames.length > 0 && (
            <p className="error">
              Reassign removed courts for: {assignmentState.invalidPoolNames.map((poolName) => `Pool ${poolName}`).join(', ')}.
            </p>
          )}
          {assignmentState.duplicateCourtLabels.length > 0 && (
            <p className="error">
              Court conflict: {assignmentState.duplicateCourtLabels.join(', ')} assigned to multiple pools.
            </p>
          )}
          <CourtAssignmentsBoard
            pools={pools}
            facilities={venueDraft?.facilities || []}
            disabled={savingPools || savingVenue || savingCourtAssignments || generatingMatches}
            onAssignmentsChange={handlePoolAssignmentsChange}
          />
        </section>

        <div className="phase1-action-help">
          <p className="subtle">Pools auto-initialize from the applied format template.</p>
          <p className="subtle">Distribute applies serpentine team assignment using Team Setup ranking order.</p>
        </div>

        <div className="phase1-admin-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={handleAutofillPools}
            disabled={autofillingPools || savingPools || initializingPools || generatingMatches || savingVenue || savingCourtAssignments}
          >
            {autofillingPools ? 'Distributing...' : 'Distribute Teams by Ranking Order'}
          </button>
          <button className="primary-button" type="button" onClick={handleGenerateMatches} disabled={!canGenerateMatches || generatingMatches}>
            {generatingMatches ? 'Generating...' : 'Generate Pool Play Matches'}
          </button>
        </div>
        {poolActionMessage && <p className="subtle phase1-success">{poolActionMessage}</p>}
        {(poolIssues.length > 0 || generationBlockingIssues.length > 0) && (
          <div className="phase1-warning-group">
            {poolIssues.length > 0 && <p className="error">{poolIssues.join('; ')}</p>}
            {generationBlockingIssues.length > 0 && (
              <p className="error">
                Generate Matches is disabled until the following are resolved: {generationBlockingIssues.join(' ')}
              </p>
            )}
          </div>
        )}

        {pools.length > 0 && (
          <DndContext sensors={dragSensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragCancel={handleDragCancel} onDragEnd={handleDragEnd}>
            <div className="phase1-pool-board">
              <section className="phase1-pool-column phase1-team-bank-column">
                <header className="phase1-pool-header">
                  <h2>Team Bank</h2>
                  <p>{teamBank.length} available</p>
                </header>
                <SortableContext items={teamBank.map((team) => team._id)} strategy={verticalListSortingStrategy}>
                  <TeamDropContainer containerId={TEAM_BANK_CONTAINER_ID} className="phase1-drop-list phase1-drop-list--bank">
                    {teamBank.map((team) => (
                      <DraggableTeamCard
                        key={team._id}
                        team={team}
                        disabled={savingPools || savingVenue || savingCourtAssignments}
                      />
                    ))}
                    {teamBank.length === 0 && <p className="subtle">No teams in bank.</p>}
                  </TeamDropContainer>
                </SortableContext>
              </section>

              <div className="phase1-pool-grid">
                {pools.map((pool) => {
                  const poolTeams = Array.isArray(pool?.teamIds) ? pool.teamIds : [];
                  return (
                    <section key={pool._id} className={`phase1-pool-column ${poolTeams.length === pool.requiredTeamCount ? '' : 'phase1-pool-column--invalid'}`}>
                      <header className="phase1-pool-header">
                        <h2>Pool {pool.name}</h2>
                        <p className="phase1-pool-count">{poolTeams.length}/{pool.requiredTeamCount}</p>
                      </header>
                      <SortableContext items={poolTeams.map((team) => team._id)} strategy={verticalListSortingStrategy}>
                        <TeamDropContainer containerId={pool._id} className="phase1-drop-list">
                          {poolTeams.map((team) => (
                            <DraggableTeamCard
                              key={team._id}
                              team={team}
                              disabled={savingPools || savingVenue || savingCourtAssignments}
                            />
                          ))}
                          {poolTeams.length === 0 && <p className="subtle">Drop teams here.</p>}
                        </TeamDropContainer>
                      </SortableContext>
                    </section>
                  );
                })}
              </div>
            </div>
            <DragOverlay>{activeDragTeam ? <TeamCardPreview team={activeDragTeam} /> : null}</DragOverlay>
          </DndContext>
        )}

        <section className="phase1-schedule">
          <h2 className="secondary-title">{crossoverStage ? `${poolPlayStageLabel} + ${crossoverStageLabel} Schedule` : `${poolPlayStageLabel} Schedule`}</h2>
          {showingCrossoverTemplates ? (
            <p className="subtle">{crossoverTemplateNote}</p>
          ) : null}
          {scheduleTableSlots.length === 0 ? (
            <p className="subtle">No matches generated yet.</p>
          ) : (
            <div className="phase1-table-wrap">
              <table className="phase1-schedule-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    {scheduleCourts.map((court) => <th key={court.key}>{court.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {scheduleRoundBlocks.map((roundBlock) => (
                    <tr key={roundBlock}>
                      <th>{formatRoundBlockStartTime(roundBlock, tournament)}</th>
                      {scheduleCourts.map((court) => {
                        const slot = scheduleLookup[`${roundBlock}-${court.key}`];
                        const stageLabel = slot?.poolName
                          ? `Pool ${slot.poolName}`
                          : slot?.stageLabel
                            || (String(slot?.stageKey || '').trim() || 'Stage');
                        const statusMeta = getScheduleStatusMeta(slot?.status);
                        const liveSummary = slot?.matchId
                          ? liveSummariesByMatchId[slot.matchId] || null
                          : null;
                        const liveSetSummary = liveSummary
                          ? formatSetSummaryWithScores(
                              toSetSummaryFromLiveSummary(liveSummary),
                              liveSummary?.completedSetScores
                            )
                          : '';
                        const slotSetSummary = (slot?.setSummary || slot?.scoreSummary)
                          ? formatSetSummaryWithScores(
                              toSetSummaryFromScoreSummary(slot?.setSummary || slot?.scoreSummary),
                              Array.isArray(slot?.setSummary?.setScores) ? slot.setSummary.setScores : []
                            )
                          : '';
                        const setSummary = liveSetSummary || slotSetSummary;
                        const hasMatchupReference = Boolean(
                          slot?.matchupReferenceLabel
                          && slot.matchupReferenceLabel !== slot?.matchupLabel
                        );
                        const hasRefReference = Boolean(
                          slot?.refReferenceLabel
                          && slot.refReferenceLabel !== slot?.refLabel
                        );
                        const matchControlHref = slot?.matchId
                          ? buildTournamentMatchControlHref({
                              matchId: slot.matchId,
                              scoreboardKey: slot?.scoreboardCode,
                              status: slot?.status,
                              startedAt: slot?.startedAt,
                              endedAt: slot?.endedAt,
                            })
                          : '';
                        const liveScoreHref = slot?.scoreboardCode
                          ? `/board/${encodeURIComponent(slot.scoreboardCode)}/display`
                          : '';
                        const showControlLinks = Boolean(slot?.matchId);

                        return (
                          <td key={`${roundBlock}-${court.key}`}>
                            {slot ? (
                              <div className="phase1-match-cell">
                                <p>
                                  <strong>{stageLabel}</strong>
                                  {`: ${slot?.matchupLabel || 'TBD vs TBD'}`}
                                </p>
                                {hasMatchupReference ? (
                                  <p className="subtle">{slot.matchupReferenceLabel}</p>
                                ) : null}
                                <p>Ref: {slot?.refLabel || 'TBD'}</p>
                                {hasRefReference ? (
                                  <p className="subtle">{slot.refReferenceLabel}</p>
                                ) : null}
                                <p className="subtle">
                                  <span className={statusMeta.className}>{statusMeta.label}</span>
                                </p>
                                {setSummary ? <p className="subtle">{setSummary}</p> : null}
                                {showControlLinks ? (
                                  <p className="subtle">
                                    {matchControlHref ? (
                                      <a href={matchControlHref}>Match Control</a>
                                    ) : null}
                                    {matchControlHref && liveScoreHref ? ' • ' : ''}
                                    {liveScoreHref ? (
                                      <a href={liveScoreHref} target="_blank" rel="noreferrer">
                                        Live Score
                                      </a>
                                    ) : null}
                                  </p>
                                ) : null}
                              </div>
                            ) : <span className="subtle">-</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="phase1-standings">
          <h2 className="secondary-title">Standings</h2>
          <div className="phase1-admin-actions">
            <button className={activeStandingsTab === 'phase1' ? 'primary-button' : 'secondary-button'} type="button" onClick={() => setActiveStandingsTab('phase1')}>
              {poolPlayStageLabel}
            </button>
            <button className={activeStandingsTab === 'cumulative' ? 'primary-button' : 'secondary-button'} type="button" onClick={() => setActiveStandingsTab('cumulative')}>
              Cumulative
            </button>
          </div>

          {activeStandingsTab === 'phase1' && (
            <div className="phase1-standings-grid">
              {(activeStandings.pools || []).map((poolStanding) => (
                <article key={poolStanding.poolName} className="phase1-standings-card">
                  <h3>Pool {poolStanding.poolName}</h3>
                  <div className="phase1-table-wrap">
                    <table className="phase1-standings-table">
                      <thead>
                        <tr><th>#</th><th>Team</th><th>W-L</th><th>Sets</th><th>Pt Diff</th></tr>
                      </thead>
                      <tbody>
                        {(poolStanding.teams || []).map((team) => (
                          <tr key={team.teamId}>
                            <td>{team.rank}</td>
                            <td>{team.shortName || team.name}</td>
                            <td>{team.matchesWon}-{team.matchesLost}</td>
                            <td>{formatSetRecord(team)}</td>
                            <td>{formatPointDiff(team.pointDiff)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </article>
              ))}
            </div>
          )}

          <article className="phase1-standings-card phase1-standings-card--overall">
            <h3>{activeStandingsTab === 'phase1' ? `${poolPlayStageLabel} Overall` : 'Cumulative Overall'}</h3>
            <div className="phase1-table-wrap">
              <table className="phase1-standings-table">
                <thead>
                  <tr><th>Rank</th><th>Team</th><th>W-L</th><th>Sets</th><th>Pt Diff</th></tr>
                </thead>
                <tbody>
                  {(activeStandings.overall || []).map((team) => (
                    <tr key={team.teamId}>
                      <td>{team.rank}</td>
                      <td>{team.shortName || team.name}</td>
                      <td>{team.matchesWon}-{team.matchesLost}</td>
                      <td>{formatSetRecord(team)}</td>
                      <td>{formatPointDiff(team.pointDiff)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        </section>
      </section>
    </main>
  );
}

export default TournamentPoolPlayAdmin;

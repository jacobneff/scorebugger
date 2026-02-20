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

const getScheduleCourtKey = (match) => {
  const courtId = toIdString(match?.courtId);
  if (courtId) {
    return `id:${courtId}`;
  }

  if (typeof match?.court === 'string' && match.court.trim()) {
    return `name:${match.court.trim().toLowerCase()}`;
  }

  return '';
};

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
  const formatDefRef = useRef(null);
  const stageReloadInFlightRef = useRef(false);

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
      setStandingsByPhase({ phase1: { pools: [], overall: [] }, cumulative: { pools: [], overall: [] } });
      return;
    }

    const nextCrossoverStage = getStageByType(formatToUse, 'crossover');
    const [poolPayload, poolMatchPayload, phase1Standings, cumulativeStandings, crossoverPayload] = await Promise.all([
      fetchJson(`${API_URL}/api/tournaments/${id}/stages/${firstPoolStage.key}/pools`, { headers: authHeaders(token) }),
      fetchJson(`${API_URL}/api/tournaments/${id}/stages/${firstPoolStage.key}/matches`, { headers: authHeaders(token) }),
      fetchJson(`${API_URL}/api/tournaments/${id}/standings?phase=phase1`, { headers: authHeaders(token) }),
      fetchJson(`${API_URL}/api/tournaments/${id}/standings?phase=cumulative`, { headers: authHeaders(token) }),
      nextCrossoverStage
        ? fetchJson(`${API_URL}/api/tournaments/${id}/stages/${nextCrossoverStage.key}/matches`, { headers: authHeaders(token) }).catch(() => [])
        : Promise.resolve([]),
    ]);

    setPools(Array.isArray(poolPayload) ? poolPayload.map((pool) => normalizePool(pool)) : []);
    setPoolPlayMatches(Array.isArray(poolMatchPayload) ? poolMatchPayload : []);
    setCrossoverMatches(Array.isArray(crossoverPayload) ? crossoverPayload : []);
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
    phase1Label: poolPlayStageLabel,
    phase1Href: `/tournaments/${id}/pool-play`,
    playoffsHref: `/tournaments/${id}/playoffs`,
  };
  const legacySchedulingNav = {
    activeSubTab: 'phase1',
    showPhase2: true,
    phase1Label: 'Pool Play 1',
    phase1Href: `/tournaments/${id}/phase1`,
    phase2Label: 'Pool Play 2',
    phase2Href: `/tournaments/${id}/phase2`,
    playoffsHref: `/tournaments/${id}/playoffs`,
  };

  const handleTournamentRealtimeEvent = useCallback((event) => {
    if (!event || typeof event !== 'object') return;

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

  const handleInitializePools = useCallback(async () => {
    if (!poolPlayStage || initializingPools) return;
    setInitializingPools(true);
    setError('');
    setMessage('');

    try {
      const payload = await fetchJson(`${API_URL}/api/tournaments/${id}/stages/${poolPlayStage.key}/pools/init`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      setPools(Array.isArray(payload) ? payload.map((pool) => normalizePool(pool)) : []);
      setMessage(`${poolPlayStageLabel} pools initialized from template.`);
    } catch (initError) {
      setError(initError.message || 'Unable to initialize pools');
    } finally {
      setInitializingPools(false);
    }
  }, [fetchJson, id, initializingPools, poolPlayStage, poolPlayStageLabel, token]);

  const handleAutofillPools = useCallback(async () => {
    if (!poolPlayStage || autofillingPools) return;
    setAutofillingPools(true);
    setError('');
    setMessage('');

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
          setMessage(firstAttempt.message);
          return;
        }

        const forcedAttempt = await runAutofill(true);
        setPools(Array.isArray(forcedAttempt.payload) ? forcedAttempt.payload.map((pool) => normalizePool(pool)) : []);
      } else {
        setPools(Array.isArray(firstAttempt.payload) ? firstAttempt.payload.map((pool) => normalizePool(pool)) : []);
      }
      setMessage('Teams distributed by ranking order.');
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
      issues.push('Initialize pools from the format template first.');
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
          setMessage(firstAttempt.message);
          return;
        }
        await runGenerate(true);
      }

      await refreshStageData(formatDefRef.current);
      setMessage(`${poolPlayStageLabel} matches generated.`);
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

  const allScheduleMatches = useMemo(
    () => [...poolPlayMatches, ...crossoverMatches].sort((a, b) => {
      const byRound = (Number(a?.roundBlock) || 0) - (Number(b?.roundBlock) || 0);
      if (byRound !== 0) return byRound;
      const courtA = toIdString(a?.courtId)
        || (typeof a?.court === 'string' ? a.court.trim() : '');
      const courtB = toIdString(b?.courtId)
        || (typeof b?.court === 'string' ? b.court.trim() : '');
      return courtA.localeCompare(courtB);
    }),
    [crossoverMatches, poolPlayMatches]
  );
  const scheduleRoundBlocks = useMemo(
    () => Array.from(new Set(allScheduleMatches.map((match) => Number(match?.roundBlock)).filter(Boolean))).sort((a, b) => a - b),
    [allScheduleMatches]
  );
  const scheduleCourts = useMemo(() => {
    const usedCourts = new Map();

    allScheduleMatches.forEach((match) => {
      const key = getScheduleCourtKey(match);
      if (!key || usedCourts.has(key)) {
        return;
      }

      const venueCourt = venueCourtById.get(toIdString(match?.courtId));
      const baseLabel =
        venueCourt?.courtName
        || (typeof match?.court === 'string' ? match.court.trim() : '');
      const label = baseLabel ? mapCourtLabel(baseLabel) : key;
      usedCourts.set(key, {
        key,
        label,
      });
    });

    if (usedCourts.size > 0) {
      return Array.from(usedCourts.values()).sort((a, b) => a.label.localeCompare(b.label));
    }

    return flattenedVenueCourts
      .filter((court) => court.isEnabled !== false)
      .map((court) => ({
        key: `id:${court.courtId}`,
        label: court.courtName,
      }));
  }, [allScheduleMatches, flattenedVenueCourts, venueCourtById]);
  const scheduleLookup = useMemo(() => {
    const lookup = {};
    allScheduleMatches.forEach((match) => {
      const courtKey = getScheduleCourtKey(match);
      if (!courtKey) {
        return;
      }

      const key = `${Number(match?.roundBlock)}-${courtKey}`;
      lookup[key] = match;
    });
    return lookup;
  }, [allScheduleMatches]);

  const activeStandings = activeStandingsTab === 'cumulative'
    ? standingsByPhase.cumulative
    : standingsByPhase.phase1;

  const isPendingCrossoverMatch = useCallback((match) => {
    if (!crossoverStage?.key) return false;
    if (String(match?.stageKey || '') !== String(crossoverStage.key)) return false;

    const poolInputsFinalized = poolPlayMatches.length > 0 && poolPlayMatches.every((poolMatch) => {
      const status = String(poolMatch?.status || '').toLowerCase();
      return Boolean(poolMatch?.result) || status === 'final' || status === 'ended';
    });

    const matchStatus = String(match?.status || '').toLowerCase();
    if (matchStatus === 'live' || matchStatus === 'final' || matchStatus === 'ended') {
      return false;
    }

    return !poolInputsFinalized;
  }, [crossoverStage?.key, poolPlayMatches]);

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
            <button
              className="secondary-button"
              type="button"
              onClick={handleInitializePools}
              disabled={initializingPools || savingPools || autofillingPools || generatingMatches || savingVenue || savingCourtAssignments}
            >
              {initializingPools ? 'Initializing Pools...' : 'Initialize Pools from Format Template'}
            </button>
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
            {tournament?.isOwner && (
              <button className="secondary-button danger-button" type="button" onClick={handleResetTournament} disabled={resettingTournament}>
                {resettingTournament ? 'Resetting...' : 'Reset Tournament'}
              </button>
            )}
          </div>
        </div>

        <div className="phase1-action-help">
          <p className="subtle">Initialize builds or refreshes pool shells from the applied format template.</p>
          <p className="subtle">Distribute applies serpentine team assignment using Team Setup ranking order.</p>
        </div>

        {(savingPools || savingCourtAssignments || savingVenue) && (
          <p className="subtle">
            {savingVenue
              ? 'Saving venue setup...'
              : savingCourtAssignments
                ? 'Saving pool court assignments...'
                : 'Saving pool changes...'}
          </p>
        )}

        {poolIssues.length > 0 && <p className="error">{poolIssues.join('; ')}</p>}
        {generationBlockingIssues.length > 0 && (
          <p className="error">
            Generate Matches is disabled until the following are resolved: {generationBlockingIssues.join(' ')}
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
                    className="text-input"
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
          {allScheduleMatches.length === 0 ? (
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
                        const match = scheduleLookup[`${roundBlock}-${court.key}`];
                        const isPending = isPendingCrossoverMatch(match);
                        return (
                          <td key={`${roundBlock}-${court.key}`}>
                            {match ? (
                              <div className="phase1-match-cell">
                                <p>
                                  <strong>{match.poolName ? `Pool ${match.poolName}` : String(match?.stageKey || 'Stage')}</strong>
                                  {`: ${isPending ? 'TBD vs TBD' : `${formatTeamLabel(match?.teamA)} vs ${formatTeamLabel(match?.teamB)}`}`}
                                </p>
                                <p>Ref: {isPending ? 'TBD' : formatTeamLabel(match?.refTeams?.[0])}</p>
                                {isPending ? <p className="subtle">Crossover matchup pending completion of pool-play standings.</p> : null}
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

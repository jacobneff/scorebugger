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
import TournamentAdminNav from '../components/TournamentAdminNav.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useTournamentRealtime } from '../hooks/useTournamentRealtime.js';
import {
  PHASE1_COURT_ORDER,
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

const normalizeCourtCode = (value) =>
  typeof value === 'string' ? value.trim().toUpperCase() : '';

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

      setTournament(tournamentPayload);
      setTeams(Array.isArray(teamsPayload) ? teamsPayload.map((team) => normalizeTeam(team)) : []);

      if (!nextFormatId) {
        setFormatDef(null);
        formatDefRef.current = null;
        setPools([]);
        setPoolPlayMatches([]);
        setCrossoverMatches([]);
        return;
      }

      const nextFormatDef = await fetchJson(`${API_URL}/api/tournament-formats/${nextFormatId}`);
      setFormatDef(nextFormatDef);
      formatDefRef.current = nextFormatDef;

      if (nextFormatId === ODU_15_FORMAT_ID) {
        setPools([]);
        setPoolPlayMatches([]);
        setCrossoverMatches([]);
        return;
      }

      await loadStageData(nextFormatDef);
    } catch (loadError) {
      setError(loadError.message || 'Unable to load pool play setup');
    } finally {
      setLoading(false);
    }
  }, [fetchJson, id, loadStageData, token]);

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
    if (!event?.active?.id || !event?.over?.id || savingPools) return;

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
  }, [persistPoolChanges, pools, refreshStageData, savingPools, teams]);

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

  const canGenerateMatches = Boolean(poolPlayStage) && pools.length > 0 && poolIssues.length === 0 && !savingPools;

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
      return String(a?.court || '').localeCompare(String(b?.court || ''));
    }),
    [crossoverMatches, poolPlayMatches]
  );
  const scheduleRoundBlocks = useMemo(
    () => Array.from(new Set(allScheduleMatches.map((match) => Number(match?.roundBlock)).filter(Boolean))).sort((a, b) => a - b),
    [allScheduleMatches]
  );
  const scheduleCourts = useMemo(() => {
    const used = new Set(allScheduleMatches.map((match) => normalizeCourtCode(match?.court)).filter(Boolean));
    const ordered = PHASE1_COURT_ORDER.filter((court) => used.has(court));
    return ordered.length > 0 ? ordered : PHASE1_COURT_ORDER;
  }, [allScheduleMatches]);
  const scheduleLookup = useMemo(() => {
    const lookup = {};
    allScheduleMatches.forEach((match) => {
      const key = `${Number(match?.roundBlock)}-${normalizeCourtCode(match?.court)}`;
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
            <button className="secondary-button" type="button" onClick={handleInitializePools} disabled={initializingPools || savingPools || autofillingPools || generatingMatches}>
              {initializingPools ? 'Initializing Pools...' : 'Initialize Pools from Format Template'}
            </button>
            <button className="secondary-button" type="button" onClick={handleAutofillPools} disabled={autofillingPools || savingPools || initializingPools || generatingMatches}>
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

        {poolIssues.length > 0 && <p className="error">{poolIssues.join('; ')}</p>}
        {error && <p className="error">{error}</p>}
        {message && <p className="subtle phase1-success">{message}</p>}

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
                    {teamBank.map((team) => <DraggableTeamCard key={team._id} team={team} disabled={savingPools} />)}
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
                          {poolTeams.map((team) => <DraggableTeamCard key={team._id} team={team} disabled={savingPools} />)}
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
                    {scheduleCourts.map((court) => <th key={court}>{mapCourtLabel(court)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {scheduleRoundBlocks.map((roundBlock) => (
                    <tr key={roundBlock}>
                      <th>{formatRoundBlockStartTime(roundBlock, tournament)}</th>
                      {scheduleCourts.map((court) => {
                        const match = scheduleLookup[`${roundBlock}-${court}`];
                        const isPending = isPendingCrossoverMatch(match);
                        return (
                          <td key={`${roundBlock}-${court}`}>
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

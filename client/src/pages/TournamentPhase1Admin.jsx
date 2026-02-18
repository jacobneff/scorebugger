import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { API_URL } from '../config/env.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useTournamentRealtime } from '../hooks/useTournamentRealtime.js';
import {
  formatRoundBlockStartTime,
  formatSetRecord,
  PHASE1_COURT_ORDER,
  PHASE1_ROUND_BLOCKS,
  buildPhase1ScheduleLookup,
  mapCourtLabel,
  sortPhase1Pools,
} from '../utils/phase1.js';
import {
  buildTournamentMatchControlHref,
  getMatchStatusMeta,
} from '../utils/tournamentMatchControl.js';

const jsonHeaders = (token) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
});

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
});

const TEAM_BANK_CONTAINER_ID = 'team-bank';

const formatShortTeamLabel = (team) => team?.shortName || team?.name || 'TBD';

function DraggableTeamCard({ team, disabled }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: team._id,
    disabled,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`phase1-team-card ${isDragging ? 'is-dragging' : ''}`}
    >
      <div className="phase1-team-card-main">
        {team.logoUrl ? (
          <img className="phase1-team-card-logo" src={team.logoUrl} alt={`${formatShortTeamLabel(team)} logo`} />
        ) : null}
        <strong>{formatShortTeamLabel(team)}</strong>
      </div>
      <button
        type="button"
        className="phase1-team-drag-handle"
        aria-label={`Drag ${formatShortTeamLabel(team)}`}
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        Drag
      </button>
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

const normalizePools = (pools) =>
  sortPhase1Pools(pools).map((pool) => ({
    ...pool,
    teamIds: Array.isArray(pool.teamIds)
      ? pool.teamIds.map((team) => ({
          _id: String(team._id),
          name: team.name || '',
          shortName: team.shortName || '',
          orderIndex: Number.isFinite(Number(team.orderIndex)) ? Number(team.orderIndex) : null,
          seed: team.seed ?? null,
          logoUrl: team.logoUrl ?? null,
        }))
      : [],
  }));

const formatPointDiff = (value) => {
  const parsed = Number(value) || 0;
  return parsed > 0 ? `+${parsed}` : `${parsed}`;
};
const formatLiveSummary = (summary) =>
  `Live: Sets ${summary.sets?.a ?? 0}-${summary.sets?.b ?? 0} • Pts ${summary.points?.a ?? 0}-${summary.points?.b ?? 0}`;

function TournamentPhase1Admin() {
  const { id } = useParams();
  const { token, user, initializing } = useAuth();

  const [tournament, setTournament] = useState(null);
  const [pools, setPools] = useState([]);
  const [teams, setTeams] = useState([]);
  const [matches, setMatches] = useState([]);
  const [standings, setStandings] = useState({ pools: [], overall: [] });
  const [autofillLoading, setAutofillLoading] = useState(false);

  const [loading, setLoading] = useState(true);
  const [initLoading, setInitLoading] = useState(false);
  const [savingPools, setSavingPools] = useState(false);
  const [generateLoading, setGenerateLoading] = useState(false);
  const [standingsLoading, setStandingsLoading] = useState(false);
  const [matchActionId, setMatchActionId] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [liveSummariesByMatchId, setLiveSummariesByMatchId] = useState({});

  const dragSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 160, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const fetchJson = useCallback(async (url, options = {}) => {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(payload?.message || 'Request failed');
    }

    return payload;
  }, []);

  const loadPools = useCallback(async () => {
    const poolData = await fetchJson(`${API_URL}/api/tournaments/${id}/phase1/pools`, {
      headers: authHeaders(token),
    });
    return normalizePools(poolData);
  }, [fetchJson, id, token]);

  const loadMatches = useCallback(async () => {
    const matchData = await fetchJson(`${API_URL}/api/tournaments/${id}/matches?phase=phase1`, {
      headers: authHeaders(token),
    });
    return Array.isArray(matchData) ? matchData : [];
  }, [fetchJson, id, token]);

  const loadTeams = useCallback(async () => {
    const teamData = await fetchJson(`${API_URL}/api/tournaments/${id}/teams`, {
      headers: authHeaders(token),
    });

    return Array.isArray(teamData)
      ? teamData.map((team) => ({
          _id: String(team._id),
          name: team.name || '',
          shortName: team.shortName || '',
          logoUrl: team.logoUrl ?? null,
          orderIndex: Number.isFinite(Number(team.orderIndex)) ? Number(team.orderIndex) : null,
        }))
      : [];
  }, [fetchJson, id, token]);

  const loadStandings = useCallback(async () => {
    const standingsPayload = await fetchJson(
      `${API_URL}/api/tournaments/${id}/standings?phase=phase1`,
      {
        headers: authHeaders(token),
      }
    );

    return {
      pools: Array.isArray(standingsPayload?.pools) ? standingsPayload.pools : [],
      overall: Array.isArray(standingsPayload?.overall) ? standingsPayload.overall : [],
    };
  }, [fetchJson, id, token]);

  const loadData = useCallback(async () => {
    if (!token || !id) {
      return;
    }

    setLoading(true);
    setError('');

    try {
      const [tournamentData, poolData, teamData, matchData, standingsData] = await Promise.all([
        fetchJson(`${API_URL}/api/tournaments/${id}`, {
          headers: authHeaders(token),
        }),
        loadPools(),
        loadTeams(),
        loadMatches(),
        loadStandings(),
      ]);

      setTournament(tournamentData);
      setPools(poolData);
      setTeams(teamData);
      setMatches(matchData);
      setStandings(standingsData);
    } catch (loadError) {
      setError(loadError.message || 'Unable to load tournament data');
    } finally {
      setLoading(false);
    }
  }, [fetchJson, id, loadMatches, loadPools, loadStandings, loadTeams, token]);

  const refreshMatchesAndStandings = useCallback(async () => {
    setStandingsLoading(true);

    try {
      const [matchData, standingsData] = await Promise.all([loadMatches(), loadStandings()]);
      setMatches(matchData);
      setStandings(standingsData);
    } finally {
      setStandingsLoading(false);
    }
  }, [loadMatches, loadStandings]);

  useEffect(() => {
    if (initializing) {
      return;
    }

    if (!token) {
      setLoading(false);
      return;
    }

    loadData();
  }, [initializing, loadData, token]);

  useEffect(() => {
    setLiveSummariesByMatchId({});
  }, [id]);

  const handleTournamentRealtimeEvent = useCallback(
    (event) => {
      if (!event || typeof event !== 'object') {
        return;
      }

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

      if (event.type === 'POOLS_UPDATED' && event.data?.phase === 'phase1') {
        Promise.all([loadPools(), loadTeams()])
          .then(([nextPools, nextTeams]) => {
            setPools(nextPools);
            setTeams(nextTeams);
          })
          .catch(() => {});
        return;
      }

      if (
        (event.type === 'MATCHES_GENERATED' ? event.data?.phase === 'phase1' : false) ||
        ['MATCH_STATUS_UPDATED', 'MATCH_FINALIZED', 'MATCH_UNFINALIZED'].includes(event.type)
      ) {
        refreshMatchesAndStandings().catch(() => {});
      }
    },
    [loadPools, loadTeams, refreshMatchesAndStandings]
  );

  useTournamentRealtime({
    tournamentCode: tournament?.publicCode,
    enabled: Boolean(token && tournament?.publicCode),
    onEvent: handleTournamentRealtimeEvent,
  });

  const assignedTeamIdSet = useMemo(() => {
    const ids = new Set();
    pools.forEach((pool) => {
      pool.teamIds.forEach((team) => ids.add(team._id));
    });
    return ids;
  }, [pools]);

  const teamBank = useMemo(
    () => teams.filter((team) => !assignedTeamIdSet.has(team._id)),
    [assignedTeamIdSet, teams]
  );

  const poolIssues = useMemo(
    () =>
      pools
        .filter((pool) => pool.teamIds.length !== 3)
        .map((pool) => {
          if (pool.teamIds.length < 3) {
            const missing = 3 - pool.teamIds.length;
            return `Pool ${pool.name} needs ${missing} more team${missing === 1 ? '' : 's'}`;
          }

          const extra = pool.teamIds.length - 3;
          return `Pool ${pool.name} has ${extra} extra team${extra === 1 ? '' : 's'}`;
        }),
    [pools]
  );

  const scheduleLookup = useMemo(() => buildPhase1ScheduleLookup(matches), [matches]);

  const resolveContainerId = useCallback(
    (idValue) => {
      if (!idValue) {
        return null;
      }

      const normalized = String(idValue);
      if (normalized === TEAM_BANK_CONTAINER_ID) {
        return TEAM_BANK_CONTAINER_ID;
      }

      if (pools.some((pool) => pool._id === normalized)) {
        return normalized;
      }

      if (teamBank.some((team) => team._id === normalized)) {
        return TEAM_BANK_CONTAINER_ID;
      }

      const owningPool = pools.find((pool) => pool.teamIds.some((team) => team._id === normalized));
      return owningPool ? owningPool._id : null;
    },
    [pools, teamBank]
  );

  const moveTeam = useCallback(
    (activeId, overId) => {
      const sourceContainerId = resolveContainerId(activeId);
      const targetContainerId = resolveContainerId(overId);

      if (!sourceContainerId || !targetContainerId) {
        return null;
      }

      if (sourceContainerId === TEAM_BANK_CONTAINER_ID && targetContainerId === TEAM_BANK_CONTAINER_ID) {
        return null;
      }

      const nextPools = pools.map((pool) => ({
        ...pool,
        teamIds: [...pool.teamIds],
      }));

      const sourcePoolIndex = nextPools.findIndex((pool) => pool._id === sourceContainerId);
      const targetPoolIndex = nextPools.findIndex((pool) => pool._id === targetContainerId);
      const sourcePool = sourcePoolIndex >= 0 ? nextPools[sourcePoolIndex] : null;
      const targetPool = targetPoolIndex >= 0 ? nextPools[targetPoolIndex] : null;
      const sourcePoolBefore = pools.find((pool) => pool._id === sourceContainerId) || null;
      const sourceTeamIndex = sourcePool
        ? sourcePool.teamIds.findIndex((team) => team._id === String(activeId))
        : -1;

      const draggedTeam =
        sourceContainerId === TEAM_BANK_CONTAINER_ID
          ? teamBank.find((team) => team._id === String(activeId)) || null
          : sourcePool && sourceTeamIndex >= 0
            ? sourcePool.teamIds[sourceTeamIndex]
            : null;

      if (!draggedTeam) {
        return null;
      }

      if (sourcePool && sourceTeamIndex >= 0) {
        sourcePool.teamIds.splice(sourceTeamIndex, 1);
      }

      if (targetPool) {
        if (sourceContainerId !== targetContainerId && targetPool.teamIds.length >= 3) {
          return { error: 'A pool can include at most 3 teams. Move one out first.' };
        }

        const overIdAsString = String(overId);
        const targetTeamIds = targetPool.teamIds.map((team) => team._id);
        let targetIndex =
          overIdAsString === targetContainerId
            ? targetPool.teamIds.length
            : targetTeamIds.indexOf(overIdAsString);

        if (targetIndex < 0) {
          targetIndex = targetPool.teamIds.length;
        }

        if (
          sourceContainerId === targetContainerId &&
          sourceTeamIndex >= 0 &&
          sourceTeamIndex < targetIndex
        ) {
          targetIndex -= 1;
        }

        targetPool.teamIds.splice(targetIndex, 0, draggedTeam);
      }

      if (sourceContainerId === targetContainerId && sourcePoolBefore) {
        const beforeIds = sourcePoolBefore.teamIds.map((team) => team._id);
        const afterIds = (nextPools.find((pool) => pool._id === sourceContainerId) || sourcePoolBefore).teamIds.map(
          (team) => team._id
        );
        if (beforeIds.join('|') === afterIds.join('|')) {
          return null;
        }
      }

      const poolIdsToPersist = [sourceContainerId, targetContainerId].filter(
        (poolId, index, all) =>
          poolId !== TEAM_BANK_CONTAINER_ID && all.indexOf(poolId) === index
      );

      return {
        nextPools,
        poolIdsToPersist,
      };
    },
    [pools, resolveContainerId, teamBank]
  );

  const persistPoolChanges = useCallback(
    async (nextPools, poolIdsToPersist) => {
      for (const poolId of poolIdsToPersist) {
        const pool = nextPools.find((entry) => entry._id === poolId);
        if (!pool) {
          continue;
        }

        await fetchJson(`${API_URL}/api/pools/${poolId}`, {
          method: 'PATCH',
          headers: jsonHeaders(token),
          body: JSON.stringify({
            teamIds: pool.teamIds.map((team) => team._id),
          }),
        });
      }
    },
    [fetchJson, token]
  );

  const handleTeamDragEnd = useCallback(
    async (event) => {
      const { active, over } = event;

      if (!active?.id || !over?.id || savingPools) {
        return;
      }

      const moveResult = moveTeam(active.id, over.id);
      if (!moveResult) {
        return;
      }

      if (moveResult.error) {
        setError(moveResult.error);
        return;
      }

      const previousPools = pools;
      setPools(moveResult.nextPools);
      setSavingPools(true);
      setError('');
      setMessage('');

      try {
        await persistPoolChanges(moveResult.nextPools, moveResult.poolIdsToPersist);
        const refreshedPools = await loadPools();
        setPools(refreshedPools);
        setMessage('Pool assignments saved.');
      } catch (saveError) {
        setPools(previousPools);
        setError(saveError.message || 'Unable to save pool changes');
      } finally {
        setSavingPools(false);
      }
    },
    [loadPools, moveTeam, persistPoolChanges, pools, savingPools]
  );

  const handleInitializePools = useCallback(async () => {
    if (!token || !id) {
      return;
    }

    setInitLoading(true);
    setError('');
    setMessage('');

    try {
      const poolData = await fetchJson(`${API_URL}/api/tournaments/${id}/phase1/pools/init`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      setPools(normalizePools(poolData));
      setMessage('Pool Play 1 pools created.');
    } catch (initError) {
      setError(initError.message || 'Unable to initialize pools');
    } finally {
      setInitLoading(false);
    }
  }, [fetchJson, id, token]);

  const handleAutofillPools = useCallback(
    async (force = false) => {
      const suffix = force ? '?force=true' : '';
      const response = await fetch(`${API_URL}/api/tournaments/${id}/phase1/pools/autofill${suffix}`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      const payload = await response.json().catch(() => null);

      if (response.status === 409 && !force) {
        return {
          requiresForce: true,
          message: payload?.message || 'Phase 1 pools already contain team assignments.',
        };
      }

      if (!response.ok || !Array.isArray(payload)) {
        throw new Error(payload?.message || 'Unable to auto-fill pools from team order');
      }

      return {
        requiresForce: false,
        pools: normalizePools(payload),
      };
    },
    [id, token]
  );

  const handleAutoFillPoolsClick = useCallback(async () => {
    if (!token || !id || autofillLoading || savingPools || initLoading) {
      return;
    }

    setAutofillLoading(true);
    setError('');
    setMessage('');

    try {
      const firstAttempt = await handleAutofillPools(false);

      if (firstAttempt.requiresForce) {
        const shouldForce = window.confirm(
          `${firstAttempt.message}\n\nThis will overwrite current Pool Play 1 assignments. Continue?`
        );

        if (!shouldForce) {
          setMessage(firstAttempt.message);
          return;
        }

        const forced = await handleAutofillPools(true);
        setPools(forced.pools);
        setMessage('Pools auto-filled from team order.');
        return;
      }

      setPools(firstAttempt.pools);
      setMessage('Pools auto-filled from team order.');
    } catch (autofillError) {
      setError(autofillError.message || 'Unable to auto-fill pools');
    } finally {
      setAutofillLoading(false);
    }
  }, [autofillLoading, handleAutofillPools, id, initLoading, savingPools, token]);

  const generatePhase1 = useCallback(
    async (force = false) => {
      const suffix = force ? '?force=true' : '';
      const response = await fetch(`${API_URL}/api/tournaments/${id}/generate/phase1${suffix}`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      const payload = await response.json().catch(() => null);

      if (response.status === 409 && !force) {
        return {
          requiresForce: true,
          message: payload?.message || 'Pool Play 1 matches already exist.',
        };
      }

      if (!response.ok || !Array.isArray(payload)) {
        throw new Error(payload?.message || 'Unable to generate Pool Play 1 matches');
      }

      return {
        requiresForce: false,
        matches: payload,
      };
    },
    [id, token]
  );

  const handleGenerateMatches = useCallback(async () => {
    if (!token || !id || generateLoading) {
      return;
    }

    setGenerateLoading(true);
    setError('');
    setMessage('');

    try {
      const firstAttempt = await generatePhase1(false);

      if (firstAttempt.requiresForce) {
        const shouldForce = window.confirm(
          `${firstAttempt.message}\n\nThis will delete and regenerate all Pool Play 1 matches and scoreboards. Continue?`
        );

        if (!shouldForce) {
          setMessage(firstAttempt.message);
          return;
        }

        const forcedAttempt = await generatePhase1(true);
        setMatches(forcedAttempt.matches);
        setMessage('Pool Play 1 matches regenerated.');
        return;
      }

      setMatches(firstAttempt.matches);
      setMessage('Pool Play 1 matches generated.');
    } catch (generateError) {
      setError(generateError.message || 'Unable to generate matches');
    } finally {
      setGenerateLoading(false);
    }
  }, [generateLoading, generatePhase1, id, token]);

  const handleFinalizeMatch = useCallback(
    async (matchId) => {
      if (!token || !matchId || matchActionId) {
        return;
      }

      setMatchActionId(matchId);
      setError('');
      setMessage('');

      try {
        await fetchJson(`${API_URL}/api/matches/${matchId}/finalize`, {
          method: 'POST',
          headers: authHeaders(token),
        });
        await refreshMatchesAndStandings();
        setMessage('Match finalized. Standings updated.');
      } catch (finalizeError) {
        setError(finalizeError.message || 'Unable to finalize match');
      } finally {
        setMatchActionId('');
      }
    },
    [fetchJson, matchActionId, refreshMatchesAndStandings, token]
  );

  const handleUnfinalizeMatch = useCallback(
    async (matchId) => {
      if (!token || !matchId || matchActionId) {
        return;
      }

      setMatchActionId(matchId);
      setError('');
      setMessage('');

      try {
        await fetchJson(`${API_URL}/api/matches/${matchId}/unfinalize`, {
          method: 'POST',
          headers: authHeaders(token),
        });
        await refreshMatchesAndStandings();
        setMessage('Match unfinalized. Standings updated.');
      } catch (unfinalizeError) {
        setError(unfinalizeError.message || 'Unable to unfinalize match');
      } finally {
        setMatchActionId('');
      }
    },
    [fetchJson, matchActionId, refreshMatchesAndStandings, token]
  );

  const canGenerate = pools.length === 5 && poolIssues.length === 0 && !savingPools;

  if (initializing || loading) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <p className="subtle">Loading Pool Play 1 setup...</p>
        </section>
      </main>
    );
  }

  if (!user || !token) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <h1 className="title">Pool Play 1 Setup</h1>
          <p className="subtle">Sign in to manage tournament pools and generate Pool Play 1 matches.</p>
          <a className="primary-button" href="/?mode=signin">
            Sign In
          </a>
        </section>
      </main>
    );
  }

  return (
    <main className="container">
      <section className="card phase1-admin-card">
        <div className="phase1-admin-header">
          <div>
            <h1 className="title">Pool Play 1 Setup</h1>
            <p className="subtitle">
              {tournament?.name || 'Tournament'} • Create pools, drag teams from Team Bank, then
              generate the fixed Pool Play 1 schedule.
            </p>
          </div>
          <div className="phase1-admin-actions">
            <a className="secondary-button" href={`/?tab=tournaments&tournamentId=${id}`}>
              Manage Teams
            </a>
            <a className="secondary-button" href={`/tournaments/${id}/phase2`}>
              Open Pool Play 2 Setup
            </a>
            <button
              className="secondary-button"
              type="button"
              onClick={handleInitializePools}
              disabled={initLoading || savingPools || generateLoading || autofillLoading}
            >
              {initLoading ? 'Creating...' : 'Create Pool Play 1 Pools'}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={handleAutoFillPoolsClick}
              disabled={autofillLoading || initLoading || savingPools || generateLoading}
            >
              {autofillLoading ? 'Auto-filling...' : 'Auto-fill pools from team order'}
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={handleGenerateMatches}
              disabled={!canGenerate || generateLoading}
            >
              {generateLoading ? 'Generating...' : 'Generate Pool Play 1 Matches'}
            </button>
          </div>
        </div>

        {savingPools && <p className="subtle">Saving pool changes...</p>}
        {poolIssues.length > 0 && (
          <p className="error">
            Each pool must have exactly 3 teams before generating matches. {poolIssues.join('; ')}.
          </p>
        )}
        {error && <p className="error">{error}</p>}
        {message && <p className="subtle phase1-success">{message}</p>}

        <DndContext
          sensors={dragSensors}
          collisionDetection={closestCenter}
          onDragEnd={handleTeamDragEnd}
        >
          <div className="phase1-pool-board">
            <section className="phase1-pool-column phase1-team-bank-column">
              <header className="phase1-pool-header">
                <h2>Team Bank</h2>
                <p>{teamBank.length} available</p>
              </header>
              <SortableContext
                items={teamBank.map((team) => team._id)}
                strategy={verticalListSortingStrategy}
              >
                <TeamDropContainer
                  containerId={TEAM_BANK_CONTAINER_ID}
                  className="phase1-drop-list phase1-drop-list--bank"
                >
                  {teamBank.map((team) => (
                    <DraggableTeamCard
                      key={team._id}
                      team={team}
                      disabled={savingPools || initLoading || autofillLoading || generateLoading}
                    />
                  ))}
                  {teamBank.length === 0 && <p className="subtle">No teams in bank.</p>}
                </TeamDropContainer>
              </SortableContext>
            </section>

            <div className="phase1-pool-grid">
              {pools.map((pool) => (
                <section
                  key={pool._id}
                  className={`phase1-pool-column ${
                    pool.teamIds.length === 3 ? '' : 'phase1-pool-column--invalid'
                  }`}
                >
                  <header className="phase1-pool-header">
                    <h2>Pool {pool.name}</h2>
                    <p>{pool.homeCourt ? mapCourtLabel(pool.homeCourt) : 'No home court'}</p>
                    <p className="phase1-pool-count">{pool.teamIds.length}/3</p>
                  </header>

                  <SortableContext
                    items={pool.teamIds.map((team) => team._id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <TeamDropContainer containerId={pool._id} className="phase1-drop-list">
                      {pool.teamIds.map((team) => (
                        <DraggableTeamCard
                          key={team._id}
                          team={team}
                          disabled={savingPools || initLoading || autofillLoading || generateLoading}
                        />
                      ))}
                      {pool.teamIds.length === 0 && <p className="subtle">Drop teams here.</p>}
                    </TeamDropContainer>
                  </SortableContext>
                </section>
              ))}
            </div>
          </div>
        </DndContext>

        {matches.length > 0 && (
          <section className="phase1-schedule">
            <h2 className="secondary-title">Pool Play 1 Schedule</h2>
            <div className="phase1-table-wrap">
              <table className="phase1-schedule-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    {PHASE1_COURT_ORDER.map((court) => (
                      <th key={court}>{mapCourtLabel(court)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PHASE1_ROUND_BLOCKS.map((roundBlock) => (
                    <tr key={roundBlock}>
                      <th>{formatRoundBlockStartTime(roundBlock, tournament)}</th>
                      {PHASE1_COURT_ORDER.map((court) => {
                        const match = scheduleLookup[`${roundBlock}-${court}`];
                        const scoreboardKey = match?.scoreboardId || match?.scoreboardCode;
                        const refLabel = formatShortTeamLabel(match?.refTeams?.[0]);
                        const matchStatusMeta = getMatchStatusMeta(match?.status);
                        const controlPanelHref = buildTournamentMatchControlHref({
                          matchId: match?._id,
                          scoreboardKey,
                          status: match?.status,
                        });

                        return (
                          <td key={`${roundBlock}-${court}`}>
                            {match ? (
                              <div className="phase1-match-cell">
                                <p>
                                  <strong>Pool {match.poolName}</strong>
                                  {`: ${formatShortTeamLabel(match.teamA)} vs ${formatShortTeamLabel(match.teamB)}`}
                                </p>
                                <p>Ref: {refLabel}</p>
                                {liveSummariesByMatchId[match._id] && (
                                  <p className="subtle">
                                    {formatLiveSummary(liveSummariesByMatchId[match._id])}
                                  </p>
                                )}
                                {controlPanelHref ? (
                                  <a
                                    href={controlPanelHref}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Open Match Control
                                  </a>
                                ) : (
                                  <span className="subtle">No control link</span>
                                )}
                                <div className="phase1-match-admin-meta">
                                  <span
                                    className={`phase1-status-badge ${
                                      matchStatusMeta.badgeClassName
                                    }`}
                                  >
                                    {matchStatusMeta.label}
                                  </span>
                                  {match.result && (
                                    <span className="phase1-match-result">
                                      Sets {match.result.setsWonA}-{match.result.setsWonB} • Pts{' '}
                                      {match.result.pointsForA}-{match.result.pointsForB}
                                    </span>
                                  )}
                                </div>
                                <div className="phase1-match-actions">
                                  {match.status === 'final' ? (
                                    <button
                                      className="secondary-button phase1-inline-button"
                                      type="button"
                                      onClick={() => handleUnfinalizeMatch(match._id)}
                                      disabled={Boolean(matchActionId)}
                                    >
                                      {matchActionId === match._id ? 'Unfinalizing...' : 'Unfinalize'}
                                    </button>
                                  ) : (
                                    <button
                                      className="primary-button phase1-inline-button"
                                      type="button"
                                      onClick={() => handleFinalizeMatch(match._id)}
                                      disabled={Boolean(matchActionId)}
                                    >
                                      {matchActionId === match._id ? 'Finalizing...' : 'Finalize'}
                                    </button>
                                  )}
                                </div>
                              </div>
                            ) : (
                              <span className="subtle">-</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="phase1-standings">
          <h2 className="secondary-title">Pool Play 1 Standings</h2>
          <p className="subtle">Only finalized matches count toward standings.</p>
          {standingsLoading && <p className="subtle">Refreshing standings...</p>}

          <div className="phase1-standings-grid">
            {standings.pools.map((poolStanding) => (
              <article key={poolStanding.poolName} className="phase1-standings-card">
                <h3>Pool {poolStanding.poolName}</h3>
                <div className="phase1-table-wrap">
                  <table className="phase1-standings-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Team</th>
                        <th>W-L</th>
                        <th>Sets</th>
                        <th>Pt Diff</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(poolStanding.teams || []).map((team) => (
                        <tr key={team.teamId}>
                          <td>{team.rank}</td>
                          <td>{team.shortName || team.name}</td>
                          <td>
                            {team.matchesWon}-{team.matchesLost}
                          </td>
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

          <article className="phase1-standings-card phase1-standings-card--overall">
            <h3>Overall Ranking</h3>
            <div className="phase1-table-wrap">
              <table className="phase1-standings-table">
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Team</th>
                    <th>W-L</th>
                    <th>Sets</th>
                    <th>Pt Diff</th>
                  </tr>
                </thead>
                <tbody>
                  {(standings.overall || []).map((team) => (
                    <tr key={team.teamId}>
                      <td>{team.rank}</td>
                      <td>{team.shortName || team.name}</td>
                      <td>
                        {team.matchesWon}-{team.matchesLost}
                      </td>
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

export default TournamentPhase1Admin;

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  closestCenter,
  useDraggable,
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
import TournamentSchedulingTabs from '../components/TournamentSchedulingTabs.jsx';
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
import { formatElapsedTimer } from '../utils/matchTimer.js';
import {
  formatSetSummaryWithScores,
  resolveCompletedSetScores,
  toSetSummaryFromLiveSummary,
  toSetSummaryFromScoreSummary,
} from '../utils/matchSetSummary.js';
import {
  TEAM_BANK_CONTAINER_ID,
  buildPoolSwapDragId,
  buildPoolSwapTargetId,
  buildTeamBankFromPools,
  buildTwoPassPoolPatchPlan,
  clonePoolsForDnd,
  collectChangedPoolIds,
  computePoolSwapPreview,
  computeTeamDragPreview,
  parsePoolSwapDragPoolId,
  parsePoolSwapTargetPoolId,
} from '../utils/phase1PoolDnd.js';

const jsonHeaders = (token) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
});

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
});

const ODU_15_FORMAT_ID = 'odu_15_5courts_v1';

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
  const label = formatShortTeamLabel(team);

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`phase1-team-card ${isDragging ? 'is-dragging' : ''}`}
    >
      <div className="phase1-team-card-main">
        {team.logoUrl ? (
          <img className="phase1-team-card-logo" src={team.logoUrl} alt={`${label} logo`} />
        ) : null}
        <strong>{label}</strong>
      </div>
      <button
        type="button"
        className="phase1-team-drag-handle"
        aria-label={`Drag ${label}`}
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
  if (!team) {
    return null;
  }

  const label = formatShortTeamLabel(team);

  return (
    <article className="phase1-team-card phase1-team-card--overlay">
      <div className="phase1-team-card-main">
        {team.logoUrl ? (
          <img className="phase1-team-card-logo" src={team.logoUrl} alt={`${label} logo`} />
        ) : null}
        <strong>{label}</strong>
      </div>
      <span className="phase1-team-drag-handle">Drag</span>
    </article>
  );
}

function PoolSwapHandle({ poolId, disabled, teamCount }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useDraggable({
    id: buildPoolSwapDragId(poolId),
    disabled,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`phase1-pool-swap-handle ${isDragging ? 'is-dragging' : ''}`}
      disabled={disabled}
      style={style}
      aria-label={`Swap all ${teamCount} teams with another pool`}
      {...attributes}
      {...listeners}
    >
      Swap {teamCount} Teams
    </button>
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

function PoolHeaderDropTarget({
  poolId,
  activeSwapPoolId,
  children,
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: buildPoolSwapTargetId(poolId),
  });

  const isDropTarget = Boolean(activeSwapPoolId) && isOver;

  return (
    <header
      ref={setNodeRef}
      className={`phase1-pool-header ${isDropTarget ? 'phase1-pool-header--swap-target' : ''}`}
    >
      {children}
    </header>
  );
}

const normalizePools = (pools) =>
  sortPhase1Pools(pools).map((pool) => ({
    ...pool,
    teamIds: Array.isArray(pool.teamIds)
      ? pool.teamIds
          .map((team) => {
            const teamId =
              typeof team === 'string' ? team : team?._id ? String(team._id) : '';
            if (!teamId) {
              return null;
            }

            return {
              _id: String(teamId),
              name: typeof team === 'object' && team ? team.name || '' : '',
              shortName: typeof team === 'object' && team ? team.shortName || '' : '',
              orderIndex:
                typeof team === 'object' && team && Number.isFinite(Number(team.orderIndex))
                  ? Number(team.orderIndex)
                  : null,
              seed: typeof team === 'object' && team ? team.seed ?? null : null,
              logoUrl: typeof team === 'object' && team ? team.logoUrl ?? null : null,
            };
          })
          .filter(Boolean)
      : [],
  }));

const formatPointDiff = (value) => {
  const parsed = Number(value) || 0;
  return parsed > 0 ? `+${parsed}` : `${parsed}`;
};

const getPoolRequiredTeamCount = (pool, fallback = 3) => {
  const parsed = Number(pool?.requiredTeamCount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
};

const formatLiveSummary = (summary) =>
  `Live: ${formatSetSummaryWithScores(
    toSetSummaryFromLiveSummary(summary),
    summary?.completedSetScores
  )}`;
const formatMatchSetSummary = (match) => {
  const fallbackScoreSummary = {
    setsA: Number(match?.result?.setsWonA) || 0,
    setsB: Number(match?.result?.setsWonB) || 0,
  };

  return formatSetSummaryWithScores(
    toSetSummaryFromScoreSummary(match?.scoreSummary || fallbackScoreSummary),
    resolveCompletedSetScores(match)
  );
};

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
  const savingCourtAssignments = false;
  const [generateLoading, setGenerateLoading] = useState(false);
  const [standingsLoading, setStandingsLoading] = useState(false);
  const [matchActionId, setMatchActionId] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [liveSummariesByMatchId, setLiveSummariesByMatchId] = useState({});
  const [elapsedNowMs, setElapsedNowMs] = useState(() => Date.now());
  const [dragPreviewPools, setDragPreviewPools] = useState(null);
  const [activeDrag, setActiveDrag] = useState(null);
  const dragOriginPoolsRef = useRef(null);
  const dragPreviewSignatureRef = useRef('');
  const lastValidTeamOverIdRef = useRef('');
  const suppressRealtimePoolUpdatesRef = useRef(false);

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

  const hasLiveTimers = useMemo(
    () =>
      matches.some(
        (match) => match?.status === 'live' && typeof match?.startedAt === 'string' && match.startedAt
      ),
    [matches]
  );

  useEffect(() => {
    if (!hasLiveTimers) {
      return undefined;
    }

    const timerId = window.setInterval(() => {
      setElapsedNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(timerId);
  }, [hasLiveTimers]);

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
        if (suppressRealtimePoolUpdatesRef.current) {
          return;
        }

        Promise.all([loadPools(), loadTeams()])
          .then(([nextPools, nextTeams]) => {
            setPools(nextPools);
            setTeams(nextTeams);
            refreshMatchesAndStandings().catch(() => {});
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

  const displayedPools = dragPreviewPools || pools;

  const teamBank = useMemo(
    () => buildTeamBankFromPools(teams, displayedPools),
    [displayedPools, teams]
  );

  const poolIssues = useMemo(
    () =>
      pools
        .filter((pool) => pool.teamIds.length !== getPoolRequiredTeamCount(pool))
        .map((pool) => {
          const requiredTeamCount = getPoolRequiredTeamCount(pool);
          if (pool.teamIds.length < requiredTeamCount) {
            const missing = requiredTeamCount - pool.teamIds.length;
            return `Pool ${pool.name} needs ${missing} more team${missing === 1 ? '' : 's'}`;
          }

          const extra = pool.teamIds.length - requiredTeamCount;
          return `Pool ${pool.name} has ${extra} extra team${extra === 1 ? '' : 's'}`;
        }),
    [pools]
  );

  const courtIssues = useMemo(() => {
    const issues = [];
    const missingCourts = pools
      .filter((pool) => !pool.homeCourt)
      .map((pool) => `Pool ${pool.name} needs a court`);

    if (missingCourts.length > 0) {
      issues.push(...missingCourts);
    }

    const poolsByCourt = new Map();

    pools.forEach((pool) => {
      if (!pool.homeCourt) {
        return;
      }

      if (!poolsByCourt.has(pool.homeCourt)) {
        poolsByCourt.set(pool.homeCourt, [pool.name]);
        return;
      }

      poolsByCourt.get(pool.homeCourt).push(pool.name);
    });

    poolsByCourt.forEach((poolNames, courtCode) => {
      if (poolNames.length > 1) {
        issues.push(`${mapCourtLabel(courtCode)} is assigned to pools ${poolNames.join(', ')}`);
      }
    });

    return issues;
  }, [pools]);

  const activeSwapPoolId = activeDrag?.type === 'pool-swap' ? activeDrag.poolId : null;
  const scheduleLookup = useMemo(() => buildPhase1ScheduleLookup(matches), [matches]);

  const findTeamById = useCallback(
    (teamId, poolsToSearch = pools) => {
      const normalizedTeamId = teamId ? String(teamId) : '';
      if (!normalizedTeamId) {
        return null;
      }

      for (const pool of poolsToSearch) {
        const found = (Array.isArray(pool?.teamIds) ? pool.teamIds : []).find(
          (team) =>
            String(
              typeof team === 'string' ? team : team?._id ? team._id : ''
            ) === normalizedTeamId
        );
        if (found) {
          if (typeof found === 'object') {
            return found;
          }
          return teams.find((team) => String(team?._id) === normalizedTeamId) || null;
        }
      }

      return teams.find((team) => String(team?._id) === normalizedTeamId) || null;
    },
    [pools, teams]
  );

  const buildPoolsSignature = useCallback((poolsToSign) => {
    if (!Array.isArray(poolsToSign)) {
      return '';
    }

    return poolsToSign
      .map((pool) => {
        const poolId = pool?._id ? String(pool._id) : '';
        const teamIds = (Array.isArray(pool?.teamIds) ? pool.teamIds : [])
          .map((team) =>
            String(typeof team === 'string' ? team : team?._id ? team._id : '')
          )
          .filter(Boolean)
          .join(',');

        return `${poolId}:${teamIds}`;
      })
      .join('|');
  }, []);

  const setDragPreviewPoolsIfChanged = useCallback(
    (nextPools) => {
      const nextSignature = buildPoolsSignature(nextPools);
      if (nextSignature === dragPreviewSignatureRef.current) {
        return;
      }

      dragPreviewSignatureRef.current = nextSignature;
      setDragPreviewPools(nextPools);
    },
    [buildPoolsSignature]
  );

  const resetDragState = useCallback(() => {
    setActiveDrag(null);
    setDragPreviewPools(null);
    dragOriginPoolsRef.current = null;
    dragPreviewSignatureRef.current = '';
    lastValidTeamOverIdRef.current = '';
  }, []);

  const resolveSwapTargetPoolId = useCallback((overId) => {
    const byTarget = parsePoolSwapTargetPoolId(overId);
    if (byTarget) {
      return byTarget;
    }
    return parsePoolSwapDragPoolId(overId);
  }, []);

  const persistPoolChanges = useCallback(
    async ({ previousPools, nextPools, poolIdsToPersist }) => {
      const plan = buildTwoPassPoolPatchPlan({
        previousPools,
        nextPools,
        poolIdsToPersist,
      });

      const runPass = async (updates) => {
        for (const update of updates) {
          await fetchJson(`${API_URL}/api/pools/${update.poolId}`, {
            method: 'PATCH',
            headers: jsonHeaders(token),
            body: JSON.stringify({
              teamIds: update.teamIds,
            }),
          });
        }
      };

      if (plan.passOne.length > 0) {
        await runPass(plan.passOne);
      }

      if (plan.passTwo.length > 0) {
        await runPass(plan.passTwo);
      }
    },
    [fetchJson, token]
  );

  const handleDragStart = useCallback(
    (event) => {
      if (
        !event?.active?.id ||
        savingPools ||
        savingCourtAssignments ||
        initLoading ||
        autofillLoading ||
        generateLoading
      ) {
        return;
      }

      const activeId = String(event.active.id);
      const originPools = clonePoolsForDnd(pools);
      dragOriginPoolsRef.current = originPools;
      dragPreviewSignatureRef.current = buildPoolsSignature(originPools);
      lastValidTeamOverIdRef.current = '';
      setError('');

      const sourcePoolId = parsePoolSwapDragPoolId(activeId);
      if (sourcePoolId) {
        const sourcePool = originPools.find((pool) => String(pool._id) === sourcePoolId);
        setActiveDrag({
          type: 'pool-swap',
          id: activeId,
          poolId: sourcePoolId,
          poolName: sourcePool?.name || '',
          teamCount: getPoolRequiredTeamCount(sourcePool),
        });
        setDragPreviewPools(originPools);
        return;
      }

      const activeTeam = findTeamById(activeId, originPools);
      if (!activeTeam) {
        resetDragState();
        return;
      }

      setActiveDrag({
        type: 'team',
        id: activeId,
        team: activeTeam,
      });
      setDragPreviewPools(originPools);
    },
    [
      autofillLoading,
      buildPoolsSignature,
      findTeamById,
      generateLoading,
      initLoading,
      pools,
      resetDragState,
      savingCourtAssignments,
      savingPools,
    ]
  );

  const handleDragOver = useCallback(
    (event) => {
      if (!activeDrag) {
        return;
      }

      const originPools = dragOriginPoolsRef.current || clonePoolsForDnd(pools);
      if (!event?.over?.id) {
        setDragPreviewPoolsIfChanged(originPools);
        return;
      }

      const rawOverId = String(event.over.id);

      if (activeDrag.type === 'team') {
        const effectiveOverId =
          rawOverId === activeDrag.id && lastValidTeamOverIdRef.current
            ? lastValidTeamOverIdRef.current
            : rawOverId;

        const preview = computeTeamDragPreview({
          pools: originPools,
          teams,
          activeTeamId: activeDrag.id,
          overId: effectiveOverId,
        });
        if (preview?.nextPools) {
          if (effectiveOverId !== activeDrag.id) {
            lastValidTeamOverIdRef.current = effectiveOverId;
          }
          setDragPreviewPoolsIfChanged(preview.nextPools);
        }
        return;
      }

      const targetPoolId = resolveSwapTargetPoolId(rawOverId);
      if (!targetPoolId) {
        setDragPreviewPoolsIfChanged(originPools);
        return;
      }

      if (targetPoolId === activeDrag.poolId) {
        setDragPreviewPoolsIfChanged(originPools);
        return;
      }

      const preview = computePoolSwapPreview({
        pools: originPools,
        sourcePoolId: activeDrag.poolId,
        targetPoolId,
        requireFull: true,
      });
      if (preview?.nextPools) {
        setDragPreviewPoolsIfChanged(preview.nextPools);
      }
    },
    [activeDrag, pools, resolveSwapTargetPoolId, setDragPreviewPoolsIfChanged, teams]
  );

  const handleDragCancel = useCallback(() => {
    resetDragState();
  }, [resetDragState]);

  const handleDragEnd = useCallback(
    async (event) => {
      if (!event?.active?.id || savingPools || savingCourtAssignments) {
        resetDragState();
        return;
      }

      const activeId = String(event.active.id);
      const rawOverId = event?.over?.id ? String(event.over.id) : '';
      const originPools = dragOriginPoolsRef.current || clonePoolsForDnd(pools);
      let moveResult = null;
      let overId = rawOverId;

      if (activeDrag?.type === 'team') {
        if (!overId || overId === activeId) {
          overId = lastValidTeamOverIdRef.current || overId;
        }
      }

      if (overId) {
        if (activeDrag?.type === 'pool-swap') {
          const targetPoolId = resolveSwapTargetPoolId(overId);
          if (targetPoolId) {
            moveResult = computePoolSwapPreview({
              pools: originPools,
              sourcePoolId: activeDrag.poolId,
              targetPoolId,
              requireFull: true,
            });
          }
        } else {
          moveResult = computeTeamDragPreview({
            pools: originPools,
            teams,
            activeTeamId: activeId,
            overId,
          });
        }
      }

      resetDragState();

      if (!overId) {
        return;
      }

      if (!moveResult) {
        return;
      }

      if (moveResult.error) {
        setError(moveResult.error);
        return;
      }

      const changedPoolIds = collectChangedPoolIds(originPools, moveResult.nextPools);
      const poolIdsToPersist = (moveResult.poolIdsToPersist || []).filter((poolId) =>
        changedPoolIds.includes(poolId)
      );

      if (poolIdsToPersist.length === 0) {
        return;
      }

      const previousPools = clonePoolsForDnd(pools);
      const nextPools = moveResult.nextPools;
      setPools(nextPools);
      setSavingPools(true);
      suppressRealtimePoolUpdatesRef.current = true;
      setError('');
      setMessage('');

      try {
        await persistPoolChanges({
          previousPools: originPools,
          nextPools,
          poolIdsToPersist,
        });
        const refreshedPools = await loadPools();
        setPools(refreshedPools);
        await refreshMatchesAndStandings();
        setMessage('Pool assignments saved.');
      } catch (saveError) {
        setPools(previousPools);
        setError(saveError.message || 'Unable to save pool changes');
        loadPools()
          .then((latestPools) => {
            setPools(latestPools);
          })
          .catch(() => {});
      } finally {
        suppressRealtimePoolUpdatesRef.current = false;
        setSavingPools(false);
      }
    },
    [
      activeDrag,
      loadPools,
      persistPoolChanges,
      pools,
      refreshMatchesAndStandings,
      resetDragState,
      resolveSwapTargetPoolId,
      savingCourtAssignments,
      savingPools,
      teams,
    ]
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
    if (!token || !id || autofillLoading || savingPools || savingCourtAssignments || initLoading) {
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
  }, [autofillLoading, handleAutofillPools, id, initLoading, savingCourtAssignments, savingPools, token]);

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
    if (!token || !id || generateLoading || savingCourtAssignments) {
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
  }, [generateLoading, generatePhase1, id, savingCourtAssignments, token]);

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

  const canGenerate =
    pools.length === 5 &&
    poolIssues.length === 0 &&
    courtIssues.length === 0 &&
    !savingPools &&
    !savingCourtAssignments &&
    !activeDrag;

  const getPoolTeams = (pool) =>
    (Array.isArray(pool?.teamIds) ? pool.teamIds : []).filter(
      (team) => team && typeof team === 'object' && team._id
    );

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
            <TournamentSchedulingTabs
              tournamentId={id}
              activeTab="phase1"
              showPhase2={
                !tournament?.settings?.format?.formatId ||
                tournament?.settings?.format?.formatId === 'odu_15_5courts_v1'
              }
            />
          </div>
          <div className="phase1-admin-actions">
            <a className="secondary-button" href={`/tournaments/${id}/teams`}>
              Manage Teams
            </a>
            <button
              className="secondary-button"
              type="button"
              onClick={handleInitializePools}
              disabled={
                initLoading ||
                savingPools ||
                savingCourtAssignments ||
                generateLoading ||
                autofillLoading
              }
            >
              {initLoading ? 'Creating...' : 'Create Pool Play 1 Pools'}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={handleAutoFillPoolsClick}
              disabled={
                autofillLoading ||
                initLoading ||
                savingPools ||
                savingCourtAssignments ||
                generateLoading
              }
            >
              {autofillLoading ? 'Auto-filling...' : 'Auto-fill pools from team order'}
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={handleGenerateMatches}
              disabled={!canGenerate || generateLoading || savingCourtAssignments}
            >
              {generateLoading ? 'Generating...' : 'Generate Pool Play 1 Matches'}
            </button>
          </div>
        </div>

        {(savingPools || savingCourtAssignments) && (
          <p className="subtle">
            {savingCourtAssignments ? 'Saving court assignments...' : 'Saving pool changes...'}
          </p>
        )}
        {poolIssues.length > 0 && (
          <p className="error">
            Each pool must have its required team count before generating matches. {poolIssues.join('; ')}.
          </p>
        )}
        {courtIssues.length > 0 && (
          <p className="error">
            Court assignments need attention. {courtIssues.join('; ')}.
          </p>
        )}
        {error && <p className="error">{error}</p>}
        {message && <p className="subtle phase1-success">{message}</p>}

        <DndContext
          sensors={dragSensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragCancel={handleDragCancel}
          onDragEnd={handleDragEnd}
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
                      disabled={
                        savingPools ||
                        savingCourtAssignments ||
                        initLoading ||
                        autofillLoading ||
                        generateLoading ||
                        activeDrag?.type === 'pool-swap'
                      }
                    />
                  ))}
                  {teamBank.length === 0 && <p className="subtle">No teams in bank.</p>}
                </TeamDropContainer>
              </SortableContext>
            </section>

            <div className="phase1-pool-grid">
              {displayedPools.map((pool) => {
                const poolTeams = getPoolTeams(pool);
                const requiredTeamCount = getPoolRequiredTeamCount(pool);

                return (
                  <section
                    key={pool._id}
                    className={`phase1-pool-column ${
                      poolTeams.length === requiredTeamCount ? '' : 'phase1-pool-column--invalid'
                    }`}
                  >
                    <PoolHeaderDropTarget poolId={pool._id} activeSwapPoolId={activeSwapPoolId}>
                      <div className="phase1-pool-header-top">
                        <h2>Pool {pool.name}</h2>
                        <PoolSwapHandle
                          poolId={pool._id}
                          teamCount={requiredTeamCount}
                          disabled={
                            savingPools ||
                            savingCourtAssignments ||
                            initLoading ||
                            autofillLoading ||
                            generateLoading
                          }
                        />
                      </div>
                      <p>{pool.homeCourt ? mapCourtLabel(pool.homeCourt) : 'No home court'}</p>
                      <p className="phase1-pool-count">{poolTeams.length}/{requiredTeamCount}</p>
                    </PoolHeaderDropTarget>

                    <SortableContext
                      items={poolTeams.map((team) => team._id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <TeamDropContainer containerId={pool._id} className="phase1-drop-list">
                        {poolTeams.map((team) => (
                          <DraggableTeamCard
                            key={team._id}
                            team={team}
                            disabled={
                              savingPools ||
                              savingCourtAssignments ||
                              initLoading ||
                              autofillLoading ||
                              generateLoading ||
                              activeDrag?.type === 'pool-swap'
                            }
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
          <DragOverlay>
            {activeDrag?.type === 'team' ? <TeamCardPreview team={activeDrag.team} /> : null}
            {activeDrag?.type === 'pool-swap' ? (
              <article className="phase1-pool-swap-overlay">
                <strong>Pool {activeDrag.poolName || '?'}</strong>
                <span>Swap {activeDrag.teamCount || 3} Teams</span>
              </article>
            ) : null}
          </DragOverlay>
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
                        const liveSummary = match ? liveSummariesByMatchId[match._id] : null;
                        const setSummaryLine = liveSummary
                          ? formatLiveSummary(liveSummary)
                          : formatMatchSetSummary(match);
                        const liveTimerLabel =
                          match?.status === 'live' && match?.startedAt
                            ? formatElapsedTimer(match.startedAt, elapsedNowMs)
                            : '';
                        const controlPanelHref = buildTournamentMatchControlHref({
                          matchId: match?._id,
                          scoreboardKey,
                          status: match?.status,
                          startedAt: match?.startedAt,
                          endedAt: match?.endedAt,
                        });

                        return (
                          <td key={`${roundBlock}-${court}`}>
                            {match ? (
                              <div className="phase1-match-cell">
                                <p>
                                  <strong>Pool {match.poolName}</strong>
                                  {`: ${formatShortTeamLabel(match.teamA)} vs ${formatShortTeamLabel(
                                    match.teamB
                                  )}`}
                                </p>
                                <p>Ref: {refLabel}</p>
                                <p className="subtle">{setSummaryLine}</p>
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
                                  {liveTimerLabel ? (
                                    <span className="phase1-match-result">LIVE {liveTimerLabel}</span>
                                  ) : null}
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
import TournamentAdminNav from '../components/TournamentAdminNav.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useTournamentRealtime } from '../hooks/useTournamentRealtime.js';
import {
  formatRoundBlockStartTime,
  formatSetRecord,
  PHASE2_COURT_ORDER,
  PHASE2_ROUND_BLOCKS,
  buildPhase2ScheduleLookup,
  formatTeamLabel,
  mapCourtLabel,
  sortPhase2Pools,
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
  buildPoolSwapDragId,
  buildPoolSwapTargetId,
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

const normalizePools = (pools) =>
  sortPhase2Pools(pools).map((pool) => ({
    ...pool,
    teamIds: Array.isArray(pool.teamIds)
      ? pool.teamIds.map((team) => ({
          _id: String(team._id),
          name: team.name || '',
          shortName: team.shortName || '',
          seed: team.seed ?? null,
          logoUrl: team.logoUrl ?? null,
        }))
      : [],
    rematchWarnings: Array.isArray(pool.rematchWarnings)
      ? pool.rematchWarnings
          .map((warning) => ({
            teamIdA: warning?.teamIdA ? String(warning.teamIdA) : null,
            teamIdB: warning?.teamIdB ? String(warning.teamIdB) : null,
          }))
          .filter((warning) => warning.teamIdA && warning.teamIdB)
      : [],
  }));

const formatPointDiff = (value) => {
  const parsed = Number(value) || 0;
  return parsed > 0 ? `+${parsed}` : `${parsed}`;
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

const normalizeStandingsPayload = (payload) => ({
  pools: Array.isArray(payload?.pools) ? payload.pools : [],
  overall: Array.isArray(payload?.overall) ? payload.overall : [],
});

function buildRematchWarningLabels(pool) {
  const teamsById = new Map(
    (Array.isArray(pool?.teamIds) ? pool.teamIds : []).map((team) => [
      String(team._id),
      team.shortName || team.name || 'Unknown',
    ])
  );

  return (Array.isArray(pool?.rematchWarnings) ? pool.rematchWarnings : []).map((warning) => {
    const teamAName = teamsById.get(String(warning.teamIdA)) || 'Unknown';
    const teamBName = teamsById.get(String(warning.teamIdB)) || 'Unknown';
    return `${teamAName} vs ${teamBName}`;
  });
}

const formatPoolTeamLabel = (team) => team?.shortName || team?.name || 'TBD';

const formatSeedLabel = (team) => {
  const parsedSeed = Number(team?.seed);
  return Number.isFinite(parsedSeed) && parsedSeed > 0 ? `Seed #${parsedSeed}` : 'Seed N/A';
};

const buildPhase1SeedLookup = (standingsPayload) => {
  const lookup = {};
  const overall = Array.isArray(standingsPayload?.overall) ? standingsPayload.overall : [];

  overall.forEach((team, index) => {
    const teamId = team?.teamId ? String(team.teamId) : '';
    if (!teamId) {
      return;
    }

    const rankedSeed = Number(team?.rank);
    lookup[teamId] = Number.isFinite(rankedSeed) && rankedSeed > 0 ? rankedSeed : index + 1;
  });

  return lookup;
};

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
  const teamLabel = formatPoolTeamLabel(team);

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`phase1-team-card ${isDragging ? 'is-dragging' : ''}`}
    >
      <div className="phase2-team-card-main">
        {team.logoUrl ? (
          <img className="phase1-team-card-logo" src={team.logoUrl} alt={`${teamLabel} logo`} />
        ) : null}
        <div className="phase2-team-card-text">
          <strong>{teamLabel}</strong>
          <p className="phase2-team-seed">{formatSeedLabel(team)}</p>
        </div>
      </div>
      <button
        type="button"
        className="phase1-team-drag-handle"
        aria-label={`Drag ${teamLabel}`}
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

  const teamLabel = formatPoolTeamLabel(team);

  return (
    <article className="phase1-team-card phase1-team-card--overlay">
      <div className="phase2-team-card-main">
        {team.logoUrl ? (
          <img className="phase1-team-card-logo" src={team.logoUrl} alt={`${teamLabel} logo`} />
        ) : null}
        <div className="phase2-team-card-text">
          <strong>{teamLabel}</strong>
          <p className="phase2-team-seed">{formatSeedLabel(team)}</p>
        </div>
      </div>
      <span className="phase1-team-drag-handle">Drag</span>
    </article>
  );
}

function PoolSwapHandle({ poolId, disabled }) {
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
      aria-label="Swap all 3 teams with another pool"
      {...attributes}
      {...listeners}
    >
      Swap 3 Teams
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

function PoolHeaderDropTarget({ poolId, activeSwapPoolId, children }) {
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

function TournamentPhase2Admin() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { token, user, initializing } = useAuth();

  const [tournament, setTournament] = useState(null);
  const [pools, setPools] = useState([]);
  const [matches, setMatches] = useState([]);
  const [standingsByPhase, setStandingsByPhase] = useState({
    phase2: { pools: [], overall: [] },
    cumulative: { pools: [], overall: [] },
  });
  const [phase1SeedByTeamId, setPhase1SeedByTeamId] = useState({});
  const [activeStandingsTab, setActiveStandingsTab] = useState('phase2');
  const [dragPreviewPools, setDragPreviewPools] = useState(null);
  const [activeDrag, setActiveDrag] = useState(null);
  const dragOriginPoolsRef = useRef(null);
  const dragPreviewSignatureRef = useRef('');
  const lastValidTeamOverIdRef = useRef('');
  const suppressRealtimePoolUpdatesRef = useRef(false);

  const [loading, setLoading] = useState(true);
  const [savingPools, setSavingPools] = useState(false);
  const [poolsGenerateLoading, setPoolsGenerateLoading] = useState(false);
  const [generateLoading, setGenerateLoading] = useState(false);
  const [resettingTournament, setResettingTournament] = useState(false);
  const [standingsLoading, setStandingsLoading] = useState(false);
  const [matchActionId, setMatchActionId] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [routeGuard, setRouteGuard] = useState('');
  const [liveSummariesByMatchId, setLiveSummariesByMatchId] = useState({});
  const [elapsedNowMs, setElapsedNowMs] = useState(() => Date.now());

  const applyPhase1SeedsToPools = useCallback((poolsToSeed, seedLookup) => {
    if (!Array.isArray(poolsToSeed)) {
      return [];
    }

    return poolsToSeed.map((pool) => ({
      ...pool,
      teamIds: (Array.isArray(pool?.teamIds) ? pool.teamIds : []).map((team) => {
        const teamId = team?._id ? String(team._id) : '';
        const derivedSeed = Number(teamId ? seedLookup?.[teamId] : NaN);
        const fallbackSeed = Number(team?.seed);

        return {
          ...team,
          seed: Number.isFinite(derivedSeed) && derivedSeed > 0
            ? derivedSeed
            : Number.isFinite(fallbackSeed) && fallbackSeed > 0
              ? fallbackSeed
              : null,
        };
      }),
    }));
  }, []);

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
    const poolData = await fetchJson(`${API_URL}/api/tournaments/${id}/phase2/pools`, {
      headers: authHeaders(token),
    });
    return normalizePools(poolData);
  }, [fetchJson, id, token]);

  const loadMatches = useCallback(async () => {
    const matchData = await fetchJson(`${API_URL}/api/tournaments/${id}/matches?phase=phase2`, {
      headers: authHeaders(token),
    });
    return Array.isArray(matchData) ? matchData : [];
  }, [fetchJson, id, token]);

  const loadStandings = useCallback(
    async (phase) => {
      const standingsPayload = await fetchJson(
        `${API_URL}/api/tournaments/${id}/standings?phase=${phase}`,
        {
          headers: authHeaders(token),
        }
      );

      return normalizeStandingsPayload(standingsPayload);
    },
    [fetchJson, id, token]
  );

  const loadData = useCallback(async () => {
    if (!token || !id) {
      return;
    }

    setLoading(true);
    setError('');

    try {
      const [
        tournamentData,
        poolData,
        matchData,
        phase1Standings,
        phase2Standings,
        cumulativeStandings,
      ] = await Promise.all([
        fetchJson(`${API_URL}/api/tournaments/${id}`, {
          headers: authHeaders(token),
        }),
        loadPools(),
        loadMatches(),
        loadStandings('phase1'),
        loadStandings('phase2'),
        loadStandings('cumulative'),
      ]);

      const formatId =
        typeof tournamentData?.settings?.format?.formatId === 'string'
          ? tournamentData.settings.format.formatId.trim()
          : '';

      if (!formatId) {
        setTournament(tournamentData);
        setPools([]);
        setMatches([]);
        setStandingsByPhase({
          phase2: { pools: [], overall: [] },
          cumulative: { pools: [], overall: [] },
        });
        setRouteGuard('apply-format');
        return;
      }

      if (formatId !== ODU_15_FORMAT_ID) {
        setTournament(tournamentData);
        setPools([]);
        setMatches([]);
        setStandingsByPhase({
          phase2: { pools: [], overall: [] },
          cumulative: { pools: [], overall: [] },
        });
        setRouteGuard('wrong-format');
        return;
      }

      const phase1SeedLookup = buildPhase1SeedLookup(phase1Standings);

      setRouteGuard('');
      setTournament(tournamentData);
      setPhase1SeedByTeamId(phase1SeedLookup);
      setPools(applyPhase1SeedsToPools(poolData, phase1SeedLookup));
      setMatches(matchData);
      setStandingsByPhase({
        phase2: phase2Standings,
        cumulative: cumulativeStandings,
      });
    } catch (loadError) {
      setError(loadError.message || 'Unable to load Pool Play 2 data');
    } finally {
      setLoading(false);
    }
  }, [applyPhase1SeedsToPools, fetchJson, id, loadMatches, loadPools, loadStandings, token]);

  const refreshMatchesAndStandings = useCallback(async () => {
    setStandingsLoading(true);

    try {
      const [matchData, phase1Standings, phase2Standings, cumulativeStandings] = await Promise.all([
        loadMatches(),
        loadStandings('phase1'),
        loadStandings('phase2'),
        loadStandings('cumulative'),
      ]);
      const phase1SeedLookup = buildPhase1SeedLookup(phase1Standings);

      setMatches(matchData);
      setPhase1SeedByTeamId(phase1SeedLookup);
      setPools((previousPools) => applyPhase1SeedsToPools(previousPools, phase1SeedLookup));
      setStandingsByPhase({
        phase2: phase2Standings,
        cumulative: cumulativeStandings,
      });
    } finally {
      setStandingsLoading(false);
    }
  }, [applyPhase1SeedsToPools, loadMatches, loadStandings]);

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

      if (event.type === 'POOLS_UPDATED' && event.data?.phase === 'phase2') {
        if (suppressRealtimePoolUpdatesRef.current) {
          return;
        }

        loadPools()
          .then((nextPools) => {
            setPools(applyPhase1SeedsToPools(nextPools, phase1SeedByTeamId));
            refreshMatchesAndStandings().catch(() => {});
          })
          .catch(() => {});
        return;
      }

      if (
        event.type === 'MATCHES_GENERATED'
          ? event.data?.phase === 'phase2'
          : ['MATCH_STATUS_UPDATED', 'MATCH_FINALIZED', 'MATCH_UNFINALIZED'].includes(event.type)
      ) {
        refreshMatchesAndStandings().catch(() => {});
      }
    },
    [applyPhase1SeedsToPools, loadPools, phase1SeedByTeamId, refreshMatchesAndStandings]
  );

  useTournamentRealtime({
    tournamentCode: tournament?.publicCode,
    enabled: Boolean(token && tournament?.publicCode),
    onEvent: handleTournamentRealtimeEvent,
  });

  const displayedPools = dragPreviewPools || pools;

  const phase2Teams = useMemo(() => {
    const teamsById = new Map();

    pools.forEach((pool) => {
      (Array.isArray(pool?.teamIds) ? pool.teamIds : []).forEach((team) => {
        const teamId = team?._id ? String(team._id) : '';
        if (!teamId || teamsById.has(teamId)) {
          return;
        }
        teamsById.set(teamId, team);
      });
    });

    return Array.from(teamsById.values());
  }, [pools]);

  const invalidPools = useMemo(
    () => pools.filter((pool) => pool.teamIds.length !== 3),
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
  const scheduleLookup = useMemo(() => buildPhase2ScheduleLookup(matches), [matches]);

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
          return phase2Teams.find((team) => String(team?._id) === normalizedTeamId) || null;
        }
      }

      return phase2Teams.find((team) => String(team?._id) === normalizedTeamId) || null;
    },
    [phase2Teams, pools]
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
      if (!event?.active?.id || savingPools || poolsGenerateLoading || generateLoading) {
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
      buildPoolsSignature,
      findTeamById,
      generateLoading,
      pools,
      poolsGenerateLoading,
      resetDragState,
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
          teams: phase2Teams,
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
    [
      activeDrag,
      phase2Teams,
      pools,
      resolveSwapTargetPoolId,
      setDragPreviewPoolsIfChanged,
    ]
  );

  const handleDragCancel = useCallback(() => {
    resetDragState();
  }, [resetDragState]);

  const handleDragEnd = useCallback(
    async (event) => {
      if (!event?.active?.id || savingPools) {
        resetDragState();
        return;
      }

      const activeId = String(event.active.id);
      const rawOverId = event?.over?.id ? String(event.over.id) : '';
      const originPools = dragOriginPoolsRef.current || clonePoolsForDnd(pools);
      let moveResult = null;
      let overId = rawOverId;

      if (activeDrag?.type === 'team' && (!overId || overId === activeId)) {
        overId = lastValidTeamOverIdRef.current || overId;
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
            teams: phase2Teams,
            activeTeamId: activeId,
            overId,
          });
        }
      }

      resetDragState();

      if (!overId || !moveResult) {
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
        setPools(applyPhase1SeedsToPools(refreshedPools, phase1SeedByTeamId));
        await refreshMatchesAndStandings();
        setMessage('Pool Play 2 pool assignments saved.');
      } catch (saveError) {
        setPools(previousPools);
        setError(saveError.message || 'Unable to save pool changes');
        loadPools()
          .then((latestPools) => {
            setPools(applyPhase1SeedsToPools(latestPools, phase1SeedByTeamId));
          })
          .catch(() => {});
      } finally {
        suppressRealtimePoolUpdatesRef.current = false;
        setSavingPools(false);
      }
    },
    [
      activeDrag,
      applyPhase1SeedsToPools,
      loadPools,
      phase1SeedByTeamId,
      persistPoolChanges,
      phase2Teams,
      pools,
      refreshMatchesAndStandings,
      resetDragState,
      resolveSwapTargetPoolId,
      savingPools,
    ]
  );

  const generatePhase2Pools = useCallback(
    async (force = false) => {
      const suffix = force ? '?force=true' : '';
      const response = await fetch(
        `${API_URL}/api/tournaments/${id}/phase2/pools/generate${suffix}`,
        {
          method: 'POST',
          headers: authHeaders(token),
        }
      );
      const payload = await response.json().catch(() => null);

      if (response.status === 409 && !force) {
        return {
          requiresForce: true,
          message: payload?.message || 'Pool Play 2 pools already exist.',
        };
      }

      if (!response.ok || !payload) {
        const details =
          Array.isArray(payload?.missing) && payload.missing.length > 0
            ? `\n${payload.missing.join('\n')}`
            : '';
        throw new Error(`${payload?.message || 'Unable to generate Pool Play 2 pools'}${details}`);
      }

      const generatedPools = Array.isArray(payload?.pools) ? payload.pools : payload;

      return {
        requiresForce: false,
        pools: normalizePools(generatedPools),
      };
    },
    [id, token]
  );

  const handleGeneratePhase2Pools = useCallback(async () => {
    if (!token || !id || poolsGenerateLoading) {
      return;
    }

    setPoolsGenerateLoading(true);
    setError('');
    setMessage('');

    try {
      const firstAttempt = await generatePhase2Pools(false);

      if (firstAttempt.requiresForce) {
        const shouldForce = window.confirm(
          `${firstAttempt.message}\n\nThis can overwrite existing Pool Play 2 pools. Continue?`
        );

        if (!shouldForce) {
          setMessage(firstAttempt.message);
          return;
        }

        const forcedAttempt = await generatePhase2Pools(true);
        setPools(applyPhase1SeedsToPools(forcedAttempt.pools, phase1SeedByTeamId));
        setMessage('Pool Play 2 pools regenerated from Pool Play 1 results.');
        return;
      }

      setPools(applyPhase1SeedsToPools(firstAttempt.pools, phase1SeedByTeamId));
      setMessage('Pool Play 2 pools generated from Pool Play 1 results.');
    } catch (generateError) {
      setError(generateError.message || 'Unable to generate Pool Play 2 pools');
    } finally {
      setPoolsGenerateLoading(false);
    }
  }, [applyPhase1SeedsToPools, generatePhase2Pools, id, phase1SeedByTeamId, poolsGenerateLoading, token]);

  const generatePhase2Matches = useCallback(
    async (force = false) => {
      const suffix = force ? '?force=true' : '';
      const response = await fetch(`${API_URL}/api/tournaments/${id}/generate/phase2${suffix}`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      const payload = await response.json().catch(() => null);

      if (response.status === 409 && !force) {
        return {
          requiresForce: true,
          message: payload?.message || 'Pool Play 2 matches already exist.',
        };
      }

      if (!response.ok || !Array.isArray(payload)) {
        throw new Error(payload?.message || 'Unable to generate Pool Play 2 matches');
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
      const firstAttempt = await generatePhase2Matches(false);

      if (firstAttempt.requiresForce) {
        const shouldForce = window.confirm(
          `${firstAttempt.message}\n\nThis will delete and regenerate all Pool Play 2 matches and scoreboards. Continue?`
        );

        if (!shouldForce) {
          setMessage(firstAttempt.message);
          return;
        }

        const forcedAttempt = await generatePhase2Matches(true);
        setMatches(forcedAttempt.matches);
        setMessage('Pool Play 2 matches regenerated.');
        await refreshMatchesAndStandings();
        return;
      }

      setMatches(firstAttempt.matches);
      setMessage('Pool Play 2 matches generated.');
      await refreshMatchesAndStandings();
    } catch (generateError) {
      setError(generateError.message || 'Unable to generate Pool Play 2 matches');
    } finally {
      setGenerateLoading(false);
    }
  }, [generateLoading, generatePhase2Matches, id, refreshMatchesAndStandings, token]);

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

  const handleResetTournament = useCallback(async () => {
    if (!token || !id || resettingTournament || !tournament?.isOwner) {
      return;
    }

    const confirmed = window.confirm(
      'Reset this tournament?\n\nThis deletes all pools, matches, and linked scoreboards, clears standings overrides, and sets status back to setup. Teams, details, and format settings stay.'
    );

    if (!confirmed) {
      return;
    }

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

  const getPoolTeams = (pool) =>
    (Array.isArray(pool?.teamIds) ? pool.teamIds : []).filter(
      (team) => team && typeof team === 'object' && team._id
    );

  const canGenerateMatches =
    pools.length === 5 &&
    invalidPools.length === 0 &&
    courtIssues.length === 0 &&
    !savingPools &&
    !activeDrag;

  const activeStandings =
    activeStandingsTab === 'cumulative'
      ? standingsByPhase.cumulative
      : standingsByPhase.phase2;

  if (initializing || loading) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <p className="subtle">Loading Pool Play 2 setup...</p>
        </section>
      </main>
    );
  }

  if (!user || !token) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <h1 className="title">Pool Play 2 Setup</h1>
          <p className="subtle">Sign in to manage Pool Play 2 pools and schedule.</p>
          <a className="primary-button" href="/?mode=signin">
            Sign In
          </a>
        </section>
      </main>
    );
  }

  if (routeGuard === 'apply-format') {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <div className="phase1-admin-header">
            <div>
              <h1 className="title">Pool Play 2 Setup</h1>
              <p className="subtitle">
                {tournament?.name || 'Tournament'} • Apply a format before opening this page.
              </p>
              <TournamentAdminNav
                tournamentId={id}
                publicCode={tournament?.publicCode || ''}
                activeMainTab="scheduling"
                scheduling={{
                  activeSubTab: 'phase2',
                  showPhase2: true,
                  phase1Label: 'Pool Play 1',
                  phase1Href: `/tournaments/${id}/phase1`,
                  phase2Label: 'Pool Play 2',
                  phase2Href: `/tournaments/${id}/phase2`,
                  playoffsHref: `/tournaments/${id}/playoffs`,
                }}
              />
            </div>
          </div>
          <div className="tournaments-route-error">
            <p className="error">Apply format first.</p>
            <a className="secondary-button" href={`/tournaments/${id}/format`}>
              Open Format Page
            </a>
          </div>
        </section>
      </main>
    );
  }

  if (routeGuard === 'wrong-format') {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <div className="phase1-admin-header">
            <div>
              <h1 className="title">Pool Play 2 Setup</h1>
              <p className="subtitle">
                {tournament?.name || 'Tournament'} • This page is only for the legacy ODU 15 format.
              </p>
              <TournamentAdminNav
                tournamentId={id}
                publicCode={tournament?.publicCode || ''}
                activeMainTab="scheduling"
                scheduling={{
                  activeSubTab: 'phase2',
                  showPhase2: false,
                  phase1Label: 'Pool Play',
                  phase1Href: `/tournaments/${id}/pool-play`,
                  playoffsHref: `/tournaments/${id}/playoffs`,
                }}
              />
            </div>
          </div>
          <div className="tournaments-route-error">
            <p className="error">
              Wrong page for current format. Use the Pool Play page for this tournament.
            </p>
            <a className="secondary-button" href={`/tournaments/${id}/pool-play`}>
              Open Pool Play
            </a>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="container">
      <section className="card phase1-admin-card">
        <div className="phase1-admin-header">
          <div>
            <h1 className="title">Pool Play 2 Setup</h1>
            <p className="subtitle">
              {tournament?.name || 'Tournament'} • Build pools F-J from Pool Play 1 placements, then
              generate fixed rounds 4-6.
            </p>
            <TournamentAdminNav
              tournamentId={id}
              publicCode={tournament?.publicCode || ''}
              activeMainTab="scheduling"
              scheduling={{
                activeSubTab: 'phase2',
                showPhase2: true,
                phase1Label: 'Pool Play 1',
                phase1Href: `/tournaments/${id}/phase1`,
                phase2Label: 'Pool Play 2',
                phase2Href: `/tournaments/${id}/phase2`,
                playoffsHref: `/tournaments/${id}/playoffs`,
              }}
            />
          </div>
          <div className="phase1-admin-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={handleGeneratePhase2Pools}
              disabled={poolsGenerateLoading || savingPools || generateLoading || Boolean(activeDrag)}
            >
              {poolsGenerateLoading
                ? 'Generating Pools...'
                : 'Generate Pool Play 2 Pools from Pool Play 1 Results'}
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={handleGenerateMatches}
              disabled={!canGenerateMatches || generateLoading}
            >
              {generateLoading ? 'Generating Matches...' : 'Generate Pool Play 2 Matches'}
            </button>
            {tournament?.isOwner && (
              <button
                className="secondary-button danger-button"
                type="button"
                onClick={handleResetTournament}
                disabled={resettingTournament}
              >
                {resettingTournament ? 'Resetting...' : 'Reset Tournament'}
              </button>
            )}
          </div>
        </div>

        {savingPools && <p className="subtle">Saving pool changes...</p>}
        {invalidPools.length > 0 && (
          <p className="error">
            Each pool must have exactly 3 teams before generating matches. Invalid pools:{' '}
            {invalidPools.map((pool) => pool.name).join(', ')}.
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
          <div className="phase1-pool-grid">
            {displayedPools.map((pool) => {
              const poolTeams = getPoolTeams(pool);
              const rematchLabels = buildRematchWarningLabels(pool);

              return (
                <section
                  key={pool._id}
                  className={`phase1-pool-column ${
                    poolTeams.length === 3 ? '' : 'phase1-pool-column--invalid'
                  }`}
                >
                  <PoolHeaderDropTarget poolId={pool._id} activeSwapPoolId={activeSwapPoolId}>
                    <div className="phase1-pool-header-top">
                      <h2>Pool {pool.name}</h2>
                      <PoolSwapHandle
                        poolId={pool._id}
                        disabled={savingPools || poolsGenerateLoading || generateLoading}
                      />
                    </div>
                    <p>{pool.homeCourt ? mapCourtLabel(pool.homeCourt) : 'No home court'}</p>
                    <p className="phase1-pool-count">{poolTeams.length}/3</p>
                  </PoolHeaderDropTarget>

                  {rematchLabels.length > 0 && (
                    <div className="phase2-rematch-warnings">
                      {rematchLabels.map((label) => (
                        <p key={`${pool._id}-${label}`} className="error">
                          Warning: rematch {label}
                        </p>
                      ))}
                    </div>
                  )}

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
                            poolsGenerateLoading ||
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
          <DragOverlay>
            {activeDrag?.type === 'team' ? <TeamCardPreview team={activeDrag.team} /> : null}
            {activeDrag?.type === 'pool-swap' ? (
              <article className="phase1-pool-swap-overlay">
                <strong>Pool {activeDrag.poolName || '?'}</strong>
                <span>Swap 3 Teams</span>
              </article>
            ) : null}
          </DragOverlay>
        </DndContext>

        {matches.length > 0 && (
          <section className="phase1-schedule">
            <h2 className="secondary-title">Pool Play 2 Schedule</h2>
            <div className="phase1-table-wrap">
              <table className="phase1-schedule-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    {PHASE2_COURT_ORDER.map((court) => (
                      <th key={court}>{mapCourtLabel(court)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PHASE2_ROUND_BLOCKS.map((roundBlock) => (
                    <tr key={roundBlock}>
                      <th>{formatRoundBlockStartTime(roundBlock, tournament)}</th>
                      {PHASE2_COURT_ORDER.map((court) => {
                        const match = scheduleLookup[`${roundBlock}-${court}`];
                        const scoreboardKey = match?.scoreboardId || match?.scoreboardCode;
                        const refLabel = formatTeamLabel(match?.refTeams?.[0]);
                        const matchStatusMeta = getMatchStatusMeta(match?.status);
                        const liveSummary = liveSummariesByMatchId[match._id];
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
                                  {`: ${formatTeamLabel(match.teamA)} vs ${formatTeamLabel(match.teamB)}`}
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
          <h2 className="secondary-title">Standings</h2>
          <p className="subtle">Counts finalized matches only.</p>
          {standingsLoading && <p className="subtle">Refreshing standings...</p>}

          <div className="phase1-admin-actions">
            <button
              className={activeStandingsTab === 'phase2' ? 'primary-button' : 'secondary-button'}
              type="button"
              onClick={() => setActiveStandingsTab('phase2')}
            >
              Pool Play 2
            </button>
            <button
              className={
                activeStandingsTab === 'cumulative' ? 'primary-button' : 'secondary-button'
              }
              type="button"
              onClick={() => setActiveStandingsTab('cumulative')}
            >
              Cumulative
            </button>
          </div>

          {activeStandingsTab === 'phase2' && (
            <div className="phase1-standings-grid">
              {activeStandings.pools.map((poolStanding) => (
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
          )}

          <article className="phase1-standings-card phase1-standings-card--overall">
            <h3>{activeStandingsTab === 'phase2' ? 'Pool Play 2 Overall' : 'Cumulative Overall'}</h3>
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
                  {(activeStandings.overall || []).map((team) => (
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

export default TournamentPhase2Admin;

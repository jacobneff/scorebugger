import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
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
import TournamentSchedulingTabs from '../components/TournamentSchedulingTabs.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { formatRoundBlockStartTime, mapCourtLabel } from '../utils/phase1.js';
import {
  TEAM_BANK_CONTAINER_ID,
  buildTeamBankFromPools,
  buildTwoPassPoolPatchPlan,
  clonePoolsForDnd,
  collectChangedPoolIds,
  computeTeamDragPreview,
} from '../utils/phase1PoolDnd.js';

const ODU_15_FORMAT_ID = 'odu_15_5courts_v1';
const FIRST_STAGE_KEY = 'poolPlay1';
const EMPTY_STANDINGS = Object.freeze({
  pools: [],
  overall: [],
});
const EMPTY_PLAYOFF_PAYLOAD = Object.freeze({
  matches: [],
  brackets: {},
  opsSchedule: [],
  bracketOrder: [],
});

const normalizeCourtCode = (courtCode) =>
  typeof courtCode === 'string' ? courtCode.trim().toUpperCase() : '';

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
});

const jsonHeaders = (token) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
});

const flattenFacilityCourts = (facilities) => {
  const source = facilities && typeof facilities === 'object' ? facilities : {};
  const src = Array.isArray(source.SRC) ? source.SRC : ['SRC-1', 'SRC-2', 'SRC-3'];
  const vc = Array.isArray(source.VC) ? source.VC : ['VC-1', 'VC-2'];
  const seen = new Set();

  return [...src, ...vc]
    .map((court) => (typeof court === 'string' ? court.trim().toUpperCase() : ''))
    .filter((court) => {
      if (!court || seen.has(court)) {
        return false;
      }
      seen.add(court);
      return true;
    });
};

const normalizeTeam = (team) => ({
  _id: String(team?._id || ''),
  name: team?.name || '',
  shortName: team?.shortName || '',
  logoUrl: team?.logoUrl ?? null,
  orderIndex: Number.isFinite(Number(team?.orderIndex)) ? Number(team.orderIndex) : null,
  seed: Number.isFinite(Number(team?.seed)) ? Number(team.seed) : null,
});

const normalizePool = (pool) => ({
  ...pool,
  _id: String(pool?._id || ''),
  stageKey: pool?.stageKey || FIRST_STAGE_KEY,
  requiredTeamCount:
    Number.isFinite(Number(pool?.requiredTeamCount)) && Number(pool.requiredTeamCount) > 0
      ? Number(pool.requiredTeamCount)
      : 3,
  teamIds: Array.isArray(pool?.teamIds)
    ? pool.teamIds.map((team) => normalizeTeam(team))
    : [],
});

const normalizeMatch = (match) => ({
  ...match,
  _id: String(match?._id || ''),
  teamA: match?.teamA ? normalizeTeam(match.teamA) : null,
  teamB: match?.teamB ? normalizeTeam(match.teamB) : null,
  roundBlock: Number.isFinite(Number(match?.roundBlock)) ? Number(match.roundBlock) : null,
});

const normalizePlayoffPayload = (payload) => ({
  matches: Array.isArray(payload?.matches) ? payload.matches.map((match) => normalizeMatch(match)) : [],
  brackets: payload?.brackets && typeof payload.brackets === 'object' ? payload.brackets : {},
  opsSchedule: Array.isArray(payload?.opsSchedule) ? payload.opsSchedule : [],
  bracketOrder: Array.isArray(payload?.bracketOrder) ? payload.bracketOrder : [],
});

const toIdString = (value) => {
  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && value._id) {
    return String(value._id);
  }

  return String(value);
};

const toTitleCase = (value) =>
  String(value || '')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(' ');

const parseRoundRank = (roundKey) => {
  const normalized = String(roundKey || '').trim().toUpperCase();
  const matched = /^R(\d+)$/.exec(normalized);
  if (!matched) {
    return Number.MAX_SAFE_INTEGER;
  }

  return Number(matched[1]);
};

const sortMatchesByRoundCourt = (matches) =>
  [...(Array.isArray(matches) ? matches : [])].sort((left, right) => {
    const leftRound = Number.isFinite(Number(left?.roundBlock)) ? Number(left.roundBlock) : Number.MAX_SAFE_INTEGER;
    const rightRound = Number.isFinite(Number(right?.roundBlock)) ? Number(right.roundBlock) : Number.MAX_SAFE_INTEGER;

    if (leftRound !== rightRound) {
      return leftRound - rightRound;
    }

    const byCourt = String(left?.court || '').localeCompare(String(right?.court || ''));
    if (byCourt !== 0) {
      return byCourt;
    }

    return String(left?._id || '').localeCompare(String(right?._id || ''));
  });

const getPoolStages = (formatDef) =>
  Array.isArray(formatDef?.stages)
    ? formatDef.stages.filter((stage) => stage?.type === 'poolPlay')
    : [];

const getStageByType = (formatDef, stageType) =>
  Array.isArray(formatDef?.stages)
    ? formatDef.stages.find((stage) => stage?.type === stageType) || null
    : null;

const formatTeamLabel = (team) => team?.shortName || team?.name || 'TBD';

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
  if (!team) {
    return null;
  }

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

function TournamentFormatAdmin() {
  const { id } = useParams();
  const { token, user, initializing } = useAuth();
  const [tournament, setTournament] = useState(null);
  const [teams, setTeams] = useState([]);
  const [pools, setPools] = useState([]);
  const [firstStageMatches, setFirstStageMatches] = useState([]);
  const [crossoverMatches, setCrossoverMatches] = useState([]);
  const [phase1Standings, setPhase1Standings] = useState(EMPTY_STANDINGS);
  const [playoffsPayload, setPlayoffsPayload] = useState(EMPTY_PLAYOFF_PAYLOAD);
  const [suggestedFormats, setSuggestedFormats] = useState([]);
  const [appliedFormatDef, setAppliedFormatDef] = useState(null);
  const [selectedFormatId, setSelectedFormatId] = useState('');
  const [activeCourts, setActiveCourts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [savingPools, setSavingPools] = useState(false);
  const [updatingPoolCourtId, setUpdatingPoolCourtId] = useState('');
  const [initializingPools, setInitializingPools] = useState(false);
  const [generatingMatches, setGeneratingMatches] = useState(false);
  const [generatingCrossoverMatches, setGeneratingCrossoverMatches] = useState(false);
  const [generatingPlayoffs, setGeneratingPlayoffs] = useState(false);
  const [activeDragTeamId, setActiveDragTeamId] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const dragSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
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

  const loadSuggestions = useCallback(
    async (teamCount, courtCount) => {
      if (!Number.isFinite(teamCount) || teamCount <= 0 || !Number.isFinite(courtCount) || courtCount <= 0) {
        setSuggestedFormats([]);
        return;
      }

      const response = await fetchJson(
        `${API_URL}/api/tournament-formats/suggest?teamCount=${teamCount}&courtCount=${courtCount}`
      );
      setSuggestedFormats(Array.isArray(response) ? response : []);
    },
    [fetchJson]
  );

  const loadFormatDef = useCallback(
    async (formatId) => {
      const normalizedFormatId = typeof formatId === 'string' ? formatId.trim() : '';
      if (!normalizedFormatId) {
        setAppliedFormatDef(null);
        return null;
      }

      const payload = await fetchJson(`${API_URL}/api/tournament-formats/${normalizedFormatId}`);
      setAppliedFormatDef(payload);
      return payload;
    },
    [fetchJson]
  );

  const loadPools = useCallback(
    async (stageKey = FIRST_STAGE_KEY) => {
      const normalizedStageKey = typeof stageKey === 'string' ? stageKey.trim() : '';
      if (!normalizedStageKey) {
        setPools([]);
        return [];
      }

      const poolPayload = await fetchJson(
        `${API_URL}/api/tournaments/${id}/stages/${normalizedStageKey}/pools`,
        {
          headers: authHeaders(token),
        }
      );
      const nextPools = Array.isArray(poolPayload) ? poolPayload.map(normalizePool) : [];
      setPools(nextPools);
      return nextPools;
    },
    [fetchJson, id, token]
  );

  const loadStageMatches = useCallback(
    async (stageKey) => {
      const normalizedStageKey = typeof stageKey === 'string' ? stageKey.trim() : '';
      if (!normalizedStageKey) {
        return [];
      }

      const payload = await fetchJson(
        `${API_URL}/api/tournaments/${id}/stages/${normalizedStageKey}/matches`,
        {
          headers: authHeaders(token),
        }
      );

      return sortMatchesByRoundCourt(
        Array.isArray(payload) ? payload.map((match) => normalizeMatch(match)) : []
      );
    },
    [fetchJson, id, token]
  );

  const loadPhase1Standings = useCallback(async () => {
    const payload = await fetchJson(`${API_URL}/api/tournaments/${id}/standings?phase=phase1`, {
      headers: authHeaders(token),
    });

    return {
      pools: Array.isArray(payload?.pools) ? payload.pools : [],
      overall: Array.isArray(payload?.overall) ? payload.overall : [],
    };
  }, [fetchJson, id, token]);

  const loadPlayoffs = useCallback(async () => {
    const payload = await fetchJson(`${API_URL}/api/tournaments/${id}/playoffs`, {
      headers: authHeaders(token),
    });

    return normalizePlayoffPayload(payload);
  }, [fetchJson, id, token]);

  const loadData = useCallback(async () => {
    if (!token || !id) {
      return;
    }

    setLoading(true);
    setError('');

    try {
      const [tournamentPayload, teamsPayload] = await Promise.all([
        fetchJson(`${API_URL}/api/tournaments/${id}`, {
          headers: authHeaders(token),
        }),
        fetchJson(`${API_URL}/api/tournaments/${id}/teams`, {
          headers: authHeaders(token),
        }),
      ]);

      const normalizedTeams = Array.isArray(teamsPayload)
        ? teamsPayload.map((team) => normalizeTeam(team))
        : [];
      const availableCourts = flattenFacilityCourts(tournamentPayload?.facilities);
      const configuredCourts = Array.isArray(tournamentPayload?.settings?.format?.activeCourts)
        ? tournamentPayload.settings.format.activeCourts
            .map((court) => (typeof court === 'string' ? court.trim().toUpperCase() : ''))
            .filter((court) => availableCourts.includes(court))
        : [];
      const nextActiveCourts = configuredCourts.length > 0 ? configuredCourts : availableCourts;
      const tournamentFormatId =
        typeof tournamentPayload?.settings?.format?.formatId === 'string'
          ? tournamentPayload.settings.format.formatId.trim()
          : '';

      setTournament(tournamentPayload);
      setTeams(normalizedTeams);
      setActiveCourts(nextActiveCourts);
      setSelectedFormatId(tournamentFormatId || '');

      await loadSuggestions(normalizedTeams.length, nextActiveCourts.length);

      if (!tournamentFormatId) {
        setAppliedFormatDef(null);
        setPools([]);
        setFirstStageMatches([]);
        setCrossoverMatches([]);
        setPhase1Standings(EMPTY_STANDINGS);
        setPlayoffsPayload(EMPTY_PLAYOFF_PAYLOAD);
        return;
      }

      const formatDef = await loadFormatDef(tournamentFormatId);
      const poolStages = getPoolStages(formatDef);
      const firstPoolStage = poolStages[0] || null;
      const crossoverStage = getStageByType(formatDef, 'crossover');
      const playoffStage = getStageByType(formatDef, 'playoffs');

      const [nextPools, nextFirstStageMatches, nextCrossoverMatches, nextStandings, nextPlayoffs] =
        await Promise.all([
          firstPoolStage ? loadPools(firstPoolStage.key) : Promise.resolve([]),
          firstPoolStage
            ? loadStageMatches(firstPoolStage.key).catch(() => [])
            : Promise.resolve([]),
          crossoverStage
            ? loadStageMatches(crossoverStage.key).catch(() => [])
            : Promise.resolve([]),
          firstPoolStage
            ? loadPhase1Standings().catch(() => EMPTY_STANDINGS)
            : Promise.resolve(EMPTY_STANDINGS),
          playoffStage
            ? loadPlayoffs().catch(() => EMPTY_PLAYOFF_PAYLOAD)
            : Promise.resolve(EMPTY_PLAYOFF_PAYLOAD),
        ]);

      setPools(nextPools);
      setFirstStageMatches(nextFirstStageMatches);
      setCrossoverMatches(nextCrossoverMatches);
      setPhase1Standings(nextStandings);
      setPlayoffsPayload(nextPlayoffs);
    } catch (loadError) {
      setError(loadError.message || 'Unable to load format setup');
    } finally {
      setLoading(false);
    }
  }, [
    fetchJson,
    id,
    loadFormatDef,
    loadPhase1Standings,
    loadPlayoffs,
    loadPools,
    loadStageMatches,
    loadSuggestions,
    token,
  ]);

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
    if (suggestedFormats.length === 0) {
      return;
    }

    if (selectedFormatId && suggestedFormats.some((entry) => entry.id === selectedFormatId)) {
      return;
    }

    setSelectedFormatId(suggestedFormats[0].id);
  }, [selectedFormatId, suggestedFormats]);

  const poolStages = useMemo(() => getPoolStages(appliedFormatDef), [appliedFormatDef]);
  const firstPoolStage = poolStages[0] || null;
  const secondPoolStage = poolStages[1] || null;
  const crossoverStage = useMemo(
    () => getStageByType(appliedFormatDef, 'crossover'),
    [appliedFormatDef]
  );
  const playoffStage = useMemo(
    () => getStageByType(appliedFormatDef, 'playoffs'),
    [appliedFormatDef]
  );
  const teamBank = useMemo(() => buildTeamBankFromPools(teams, pools), [pools, teams]);
  const teamsById = useMemo(
    () => new Map(teams.map((team) => [toIdString(team._id), team])),
    [teams]
  );
  const availableCourts = useMemo(() => flattenFacilityCourts(tournament?.facilities), [tournament?.facilities]);
  const selectablePoolCourts = useMemo(() => {
    const preferredCourts = activeCourts.length > 0 ? activeCourts : availableCourts;
    const seen = new Set();

    return preferredCourts
      .map((courtCode) => normalizeCourtCode(courtCode))
      .filter((courtCode) => {
        if (!courtCode || seen.has(courtCode)) {
          return false;
        }

        seen.add(courtCode);
        return true;
      });
  }, [activeCourts, availableCourts]);
  const poolIssues = useMemo(
    () =>
      pools
        .filter((pool) => (Array.isArray(pool.teamIds) ? pool.teamIds.length : 0) !== pool.requiredTeamCount)
        .map((pool) => {
          const currentCount = Array.isArray(pool.teamIds) ? pool.teamIds.length : 0;
          if (currentCount < pool.requiredTeamCount) {
            const missing = pool.requiredTeamCount - currentCount;
            return `Pool ${pool.name} needs ${missing} more team${missing === 1 ? '' : 's'}`;
          }

          return `Pool ${pool.name} has too many teams`;
        }),
    [pools]
  );

  const selectedFormat =
    suggestedFormats.find((entry) => entry.id === selectedFormatId) ||
    (appliedFormatDef && selectedFormatId === appliedFormatDef.id
      ? {
          id: appliedFormatDef.id,
          name: appliedFormatDef.name,
          description: appliedFormatDef.description,
          supportedTeamCounts: appliedFormatDef.supportedTeamCounts,
          minCourts: appliedFormatDef.minCourts,
        }
      : null);
  const activeFormatId = (appliedFormatDef?.id || selectedFormatId || '').trim();
  const showLegacyPhase2 = activeFormatId === ODU_15_FORMAT_ID && Boolean(secondPoolStage);
  const activeDragTeam = useMemo(() => {
    if (!activeDragTeamId) {
      return null;
    }

    const pooledTeam = pools
      .flatMap((pool) => (Array.isArray(pool.teamIds) ? pool.teamIds : []))
      .find((team) => toIdString(team?._id) === activeDragTeamId);
    if (pooledTeam) {
      return pooledTeam;
    }

    const bankTeam = teamBank.find((team) => toIdString(team?._id) === activeDragTeamId);
    if (bankTeam) {
      return bankTeam;
    }

    return teamsById.get(activeDragTeamId) || null;
  }, [activeDragTeamId, pools, teamBank, teamsById]);

  const crossoverPreviewRows = useMemo(() => {
    if (
      !crossoverStage ||
      !Array.isArray(crossoverStage.fromPools) ||
      crossoverStage.fromPools.length !== 2
    ) {
      return [];
    }

    const standingsByPool = new Map(
      (Array.isArray(phase1Standings?.pools) ? phase1Standings.pools : []).map((pool) => [
        String(pool?.poolName || ''),
        pool,
      ])
    );
    const leftPoolName = String(crossoverStage.fromPools[0] || '');
    const rightPoolName = String(crossoverStage.fromPools[1] || '');
    const leftTeams = Array.isArray(standingsByPool.get(leftPoolName)?.teams)
      ? standingsByPool.get(leftPoolName).teams
      : [];
    const rightTeams = Array.isArray(standingsByPool.get(rightPoolName)?.teams)
      ? standingsByPool.get(rightPoolName).teams
      : [];
    const pairingCount = Math.min(leftTeams.length, rightTeams.length);

    return Array.from({ length: pairingCount }, (_, index) => {
      const left = leftTeams[index];
      const right = rightTeams[index];
      const rank = index + 1;
      const leftTeam = teamsById.get(toIdString(left?.teamId));
      const rightTeam = teamsById.get(toIdString(right?.teamId));

      return {
        id: `${leftPoolName}-${rightPoolName}-${rank}`,
        label: `${leftPoolName}${rank} vs ${rightPoolName}${rank}`,
        leftTeamLabel: left?.shortName || left?.name || formatTeamLabel(leftTeam),
        rightTeamLabel: right?.shortName || right?.name || formatTeamLabel(rightTeam),
      };
    });
  }, [crossoverStage, phase1Standings?.pools, teamsById]);

  const playoffBracketOrder = useMemo(() => {
    const explicitOrder = Array.isArray(playoffsPayload?.bracketOrder)
      ? playoffsPayload.bracketOrder
      : [];

    if (explicitOrder.length > 0) {
      return explicitOrder;
    }

    return Object.keys(playoffsPayload?.brackets || {});
  }, [playoffsPayload?.bracketOrder, playoffsPayload?.brackets]);

  const persistPoolChanges = useCallback(
    async ({ previousPools, nextPools, poolIdsToPersist }) => {
      const plan = buildTwoPassPoolPatchPlan({
        previousPools,
        nextPools,
        poolIdsToPersist,
      });
      const updatedByPoolId = new Map();

      const runPass = async (updates) => {
        for (const update of updates) {
          const payload = await fetchJson(`${API_URL}/api/pools/${update.poolId}`, {
            method: 'PATCH',
            headers: jsonHeaders(token),
            body: JSON.stringify({
              teamIds: update.teamIds,
            }),
          });
          updatedByPoolId.set(String(update.poolId), normalizePool(payload));
        }
      };

      if (plan.passOne.length > 0) {
        await runPass(plan.passOne);
      }

      if (plan.passTwo.length > 0) {
        await runPass(plan.passTwo);
      }

      return updatedByPoolId;
    },
    [fetchJson, token]
  );

  const handleDragStart = useCallback((event) => {
    setActiveDragTeamId(String(event?.active?.id || ''));
  }, []);

  const handleDragCancel = useCallback(() => {
    setActiveDragTeamId('');
  }, []);

  const handleDragEnd = useCallback(
    async (event) => {
      setActiveDragTeamId('');

      if (!event?.active?.id || !event?.over?.id || savingPools) {
        return;
      }

      const activeTeamId = String(event.active.id);
      const overId = String(event.over.id);
      const previousPools = clonePoolsForDnd(pools);
      const preview = computeTeamDragPreview({
        pools: previousPools,
        teams,
        activeTeamId,
        overId,
      });

      if (!preview) {
        return;
      }

      if (preview.error) {
        setError(preview.error);
        return;
      }

      const changedPoolIds = collectChangedPoolIds(previousPools, preview.nextPools);
      const poolIdsToPersist = changedPoolIds.filter((poolId) => preview.poolIdsToPersist.includes(poolId));

      if (poolIdsToPersist.length === 0) {
        return;
      }

      const optimisticNextPools = clonePoolsForDnd(preview.nextPools);
      setPools(optimisticNextPools);
      setSavingPools(true);
      setError('');
      setMessage('');

      try {
        const updatedByPoolId = await persistPoolChanges({
          previousPools,
          nextPools: optimisticNextPools,
          poolIdsToPersist,
        });
        setPools((currentPools) =>
          currentPools.map((pool) => updatedByPoolId.get(String(pool._id)) || pool)
        );
      } catch (persistError) {
        setPools(previousPools);
        setError(persistError.message || 'Unable to save pools');
      } finally {
        setSavingPools(false);
      }
    },
    [persistPoolChanges, pools, savingPools, teams]
  );

  const toggleCourt = useCallback(
    async (courtCode) => {
      const normalized = typeof courtCode === 'string' ? courtCode.trim().toUpperCase() : '';
      if (!normalized) {
        return;
      }

      setActiveCourts((previous) => {
        const exists = previous.includes(normalized);
        if (exists) {
          if (previous.length <= 1) {
            return previous;
          }
          return previous.filter((entry) => entry !== normalized);
        }
        return [...previous, normalized];
      });
    },
    []
  );

  useEffect(() => {
    loadSuggestions(teams.length, activeCourts.length).catch(() => {});
  }, [activeCourts.length, loadSuggestions, teams.length]);

  const handleApplyFormat = useCallback(async () => {
    if (!selectedFormatId || applying) {
      return;
    }

    setApplying(true);
    setError('');
    setMessage('');

    const runApply = async (force) => {
      const suffix = force ? '?force=true' : '';
      const response = await fetch(`${API_URL}/api/tournaments/${id}/apply-format${suffix}`, {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          formatId: selectedFormatId,
          activeCourts,
        }),
      });
      const payload = await response.json().catch(() => null);

      if (response.status === 409 && !force) {
        return {
          requiresForce: true,
          message: payload?.message || 'Format already has generated data.',
        };
      }

      if (!response.ok) {
        throw new Error(payload?.message || 'Unable to apply format');
      }

      return {
        requiresForce: false,
        payload,
      };
    };

    try {
      const firstAttempt = await runApply(false);

      if (firstAttempt.requiresForce) {
        const shouldForce = window.confirm(
          `${firstAttempt.message}\n\nThis will remove existing pools, matches, and scoreboards for this tournament. Continue?`
        );

        if (!shouldForce) {
          setMessage(firstAttempt.message);
          return;
        }

        const forcedAttempt = await runApply(true);
        setPools(
          Array.isArray(forcedAttempt.payload?.pools)
            ? forcedAttempt.payload.pools.map((pool) => normalizePool(pool))
            : []
        );
        setMessage('Format applied and existing scheduling data replaced.');
        await loadData();
        return;
      }

      setPools(
        Array.isArray(firstAttempt.payload?.pools)
          ? firstAttempt.payload.pools.map((pool) => normalizePool(pool))
          : []
      );
      setMessage('Format applied. Assign teams to pools and generate stage matches.');
      await loadData();
    } catch (applyError) {
      setError(applyError.message || 'Unable to apply format');
    } finally {
      setApplying(false);
    }
  }, [activeCourts, applying, id, loadData, selectedFormatId, token]);

  const handleInitializePools = useCallback(async () => {
    if (!firstPoolStage || initializingPools) {
      return;
    }

    setInitializingPools(true);
    setError('');
    setMessage('');

    try {
      const payload = await fetchJson(
        `${API_URL}/api/tournaments/${id}/stages/${firstPoolStage.key}/pools/init`,
        {
          method: 'POST',
          headers: authHeaders(token),
        }
      );
      setPools(Array.isArray(payload) ? payload.map((pool) => normalizePool(pool)) : []);
      setFirstStageMatches([]);
      setPhase1Standings(EMPTY_STANDINGS);
      setMessage(`${firstPoolStage.displayName || 'Pool Play'} pools initialized.`);
    } catch (initError) {
      setError(initError.message || 'Unable to initialize pools');
    } finally {
      setInitializingPools(false);
    }
  }, [fetchJson, firstPoolStage, id, initializingPools, token]);

  const handleGenerateMatches = useCallback(async () => {
    if (!firstPoolStage || generatingMatches) {
      return;
    }

    setGeneratingMatches(true);
    setError('');
    setMessage('');

    const runGenerate = async (force) => {
      const suffix = force ? '?force=true' : '';
      const response = await fetch(
        `${API_URL}/api/tournaments/${id}/stages/${firstPoolStage.key}/matches/generate${suffix}`,
        {
          method: 'POST',
          headers: authHeaders(token),
        }
      );
      const payload = await response.json().catch(() => null);

      if (response.status === 409 && !force) {
        return {
          requiresForce: true,
          message: payload?.message || 'Stage matches already exist.',
        };
      }

      if (!response.ok || !Array.isArray(payload)) {
        throw new Error(payload?.message || 'Unable to generate matches');
      }

      return {
        requiresForce: false,
        payload,
      };
    };

    try {
      const firstAttempt = await runGenerate(false);

      if (firstAttempt.requiresForce) {
        const shouldForce = window.confirm(
          `${firstAttempt.message}\n\nThis will delete and regenerate matches + scoreboards for this stage. Continue?`
        );

        if (!shouldForce) {
          setMessage(firstAttempt.message);
          return;
        }

        const forcedAttempt = await runGenerate(true);
        setFirstStageMatches(sortMatchesByRoundCourt(forcedAttempt.payload.map((match) => normalizeMatch(match))));
        const standings = await loadPhase1Standings().catch(() => EMPTY_STANDINGS);
        setPhase1Standings(standings);
        setMessage(`Generated ${forcedAttempt.payload.length} ${firstPoolStage.displayName || 'Pool Play'} matches.`);
        return;
      }

      setFirstStageMatches(sortMatchesByRoundCourt(firstAttempt.payload.map((match) => normalizeMatch(match))));
      const standings = await loadPhase1Standings().catch(() => EMPTY_STANDINGS);
      setPhase1Standings(standings);
      setMessage(`Generated ${firstAttempt.payload.length} ${firstPoolStage.displayName || 'Pool Play'} matches.`);
    } catch (generateError) {
      setError(generateError.message || 'Unable to generate matches');
    } finally {
      setGeneratingMatches(false);
    }
  }, [firstPoolStage, generatingMatches, id, loadPhase1Standings, token]);

  const handleGenerateCrossoverMatches = useCallback(async () => {
    if (!crossoverStage || generatingCrossoverMatches) {
      return;
    }

    setGeneratingCrossoverMatches(true);
    setError('');
    setMessage('');

    const runGenerate = async (force) => {
      const suffix = force ? '?force=true' : '';
      const response = await fetch(
        `${API_URL}/api/tournaments/${id}/stages/${crossoverStage.key}/matches/generate${suffix}`,
        {
          method: 'POST',
          headers: authHeaders(token),
        }
      );
      const payload = await response.json().catch(() => null);

      if (response.status === 409 && !force) {
        return {
          requiresForce: true,
          message: payload?.message || 'Crossover matches already exist.',
        };
      }

      if (!response.ok || !Array.isArray(payload)) {
        throw new Error(payload?.message || 'Unable to generate crossover matches');
      }

      return {
        requiresForce: false,
        payload,
      };
    };

    try {
      const firstAttempt = await runGenerate(false);

      if (firstAttempt.requiresForce) {
        const shouldForce = window.confirm(
          `${firstAttempt.message}\n\nThis will delete and regenerate matches + scoreboards for crossover. Continue?`
        );

        if (!shouldForce) {
          setMessage(firstAttempt.message);
          return;
        }

        const forcedAttempt = await runGenerate(true);
        setCrossoverMatches(sortMatchesByRoundCourt(forcedAttempt.payload.map((match) => normalizeMatch(match))));
        setMessage(`Generated ${forcedAttempt.payload.length} ${crossoverStage.displayName || 'crossover'} matches.`);
        return;
      }

      setCrossoverMatches(sortMatchesByRoundCourt(firstAttempt.payload.map((match) => normalizeMatch(match))));
      setMessage(`Generated ${firstAttempt.payload.length} ${crossoverStage.displayName || 'crossover'} matches.`);
    } catch (generateError) {
      setError(generateError.message || 'Unable to generate crossover matches');
    } finally {
      setGeneratingCrossoverMatches(false);
    }
  }, [crossoverStage, generatingCrossoverMatches, id, token]);

  const handleGeneratePlayoffs = useCallback(async () => {
    if (!playoffStage || generatingPlayoffs) {
      return;
    }

    setGeneratingPlayoffs(true);
    setError('');
    setMessage('');

    const runGenerate = async (force) => {
      const suffix = force ? '?force=true' : '';
      const response = await fetch(
        `${API_URL}/api/tournaments/${id}/stages/${playoffStage.key}/matches/generate${suffix}`,
        {
          method: 'POST',
          headers: authHeaders(token),
        }
      );
      const payload = await response.json().catch(() => null);

      if (response.status === 409 && !force) {
        return {
          requiresForce: true,
          message: payload?.message || 'Playoff matches already exist.',
        };
      }

      if (!response.ok) {
        throw new Error(payload?.message || 'Unable to generate playoffs');
      }

      return {
        requiresForce: false,
        payload,
      };
    };

    try {
      const firstAttempt = await runGenerate(false);

      if (firstAttempt.requiresForce) {
        const shouldForce = window.confirm(
          `${firstAttempt.message}\n\nThis will delete and regenerate playoff matches + scoreboards. Continue?`
        );

        if (!shouldForce) {
          setMessage(firstAttempt.message);
          return;
        }

        const forcedAttempt = await runGenerate(true);
        if (forcedAttempt.payload?.matches && forcedAttempt.payload?.brackets) {
          setPlayoffsPayload(normalizePlayoffPayload(forcedAttempt.payload));
        } else {
          setPlayoffsPayload(await loadPlayoffs());
        }
        const forcedCount = Array.isArray(forcedAttempt.payload)
          ? forcedAttempt.payload.length
          : Array.isArray(forcedAttempt.payload?.matches)
            ? forcedAttempt.payload.matches.length
            : 0;
        setMessage(`Generated ${forcedCount} ${playoffStage.displayName || 'playoff'} matches.`);
        return;
      }

      if (firstAttempt.payload?.matches && firstAttempt.payload?.brackets) {
        setPlayoffsPayload(normalizePlayoffPayload(firstAttempt.payload));
      } else {
        setPlayoffsPayload(await loadPlayoffs());
      }
      const count = Array.isArray(firstAttempt.payload)
        ? firstAttempt.payload.length
        : Array.isArray(firstAttempt.payload?.matches)
          ? firstAttempt.payload.matches.length
          : 0;
      setMessage(`Generated ${count} ${playoffStage.displayName || 'playoff'} matches.`);
    } catch (generateError) {
      setError(generateError.message || 'Unable to generate playoffs');
    } finally {
      setGeneratingPlayoffs(false);
    }
  }, [generatingPlayoffs, id, loadPlayoffs, playoffStage, token]);

  const handlePoolCourtChange = useCallback(
    async (poolId, nextCourtCode) => {
      if (!poolId || updatingPoolCourtId) {
        return;
      }

      const targetPool = pools.find((pool) => pool._id === poolId);

      if (!targetPool) {
        return;
      }

      const normalizedNextCourt = normalizeCourtCode(nextCourtCode);
      const normalizedCurrentCourt = normalizeCourtCode(targetPool.homeCourt);

      if (!normalizedNextCourt || normalizedCurrentCourt === normalizedNextCourt) {
        return;
      }

      setUpdatingPoolCourtId(poolId);
      setError('');
      setMessage('');

      try {
        const payload = await fetchJson(`${API_URL}/api/pools/${poolId}`, {
          method: 'PATCH',
          headers: jsonHeaders(token),
          body: JSON.stringify({
            homeCourt: normalizedNextCourt,
          }),
        });
        const updatedPool = normalizePool(payload);
        setPools((currentPools) =>
          currentPools.map((pool) => (pool._id === updatedPool._id ? updatedPool : pool))
        );
        setMessage(`Pool ${targetPool.name} home court updated to ${mapCourtLabel(normalizedNextCourt)}.`);
      } catch (courtError) {
        setError(courtError.message || 'Unable to update pool home court');
      } finally {
        setUpdatingPoolCourtId('');
      }
    },
    [fetchJson, pools, token, updatingPoolCourtId]
  );

  if (initializing || loading) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <p className="subtle">Loading format setup...</p>
        </section>
      </main>
    );
  }

  if (!user || !token) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <h1 className="title">Tournament Format</h1>
          <p className="subtle">Sign in to select tournament format and generate schedules.</p>
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
            <h1 className="title">Tournament Format</h1>
            <p className="subtitle">
              {tournament?.name || 'Tournament'} • Select courts, apply a format, assign teams,
              and generate stage matches.
            </p>
            <TournamentSchedulingTabs
              tournamentId={id}
              activeTab="format"
              showPhase2={showLegacyPhase2}
              phase1Label={firstPoolStage?.displayName || (showLegacyPhase2 ? 'Pool Play 1' : 'Pool Play')}
              phase1Href={showLegacyPhase2 ? `/tournaments/${id}/phase1` : `/tournaments/${id}/format`}
              phase2Label={secondPoolStage?.displayName || 'Pool Play 2'}
              phase2Href={showLegacyPhase2 ? `/tournaments/${id}/phase2` : `/tournaments/${id}/format`}
              playoffsHref={`/tournaments/${id}/playoffs`}
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
              disabled={!firstPoolStage || initializingPools || savingPools}
            >
              {initializingPools
                ? 'Initializing...'
                : `Init ${firstPoolStage?.displayName || 'Pool Play'} Pools`}
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={handleGenerateMatches}
              disabled={
                generatingMatches ||
                savingPools ||
                !firstPoolStage ||
                pools.length === 0 ||
                poolIssues.length > 0
              }
            >
              {generatingMatches
                ? 'Generating...'
                : `Generate ${firstPoolStage?.displayName || 'Pool Play'} Matches`}
            </button>
          </div>
        </div>

        <section className="phase1-standings">
          <h2 className="secondary-title">Format Selection</h2>
          <p className="subtle">Team count: {teams.length}</p>
          <div className="phase1-admin-actions">
            {availableCourts.map((courtCode) => (
              <label key={courtCode} className="subtle">
                <input
                  type="checkbox"
                  checked={activeCourts.includes(courtCode)}
                  onChange={() => toggleCourt(courtCode)}
                  disabled={applying}
                />
                {' '}
                {mapCourtLabel(courtCode)}
              </label>
            ))}
          </div>

          {suggestedFormats.length === 0 ? (
            <p className="subtle">No suggested formats for this team count and court selection.</p>
          ) : (
            <div className="phase1-standings-grid">
              {suggestedFormats.map((format) => (
                <article key={format.id} className="phase1-standings-card">
                  <label>
                    <input
                      type="radio"
                      name="format-id"
                      value={format.id}
                      checked={selectedFormatId === format.id}
                      onChange={() => setSelectedFormatId(format.id)}
                      disabled={applying}
                    />
                    {' '}
                    <strong>{format.name}</strong>
                  </label>
                  <p className="subtle">{format.description}</p>
                </article>
              ))}
            </div>
          )}

          <div className="phase1-admin-actions">
            <button
              className="primary-button"
              type="button"
              onClick={handleApplyFormat}
              disabled={!selectedFormatId || applying}
            >
              {applying ? 'Applying...' : 'Apply Format'}
            </button>
            {selectedFormat && (
              <p className="subtle">
                Supports teams: {(selectedFormat.supportedTeamCounts || []).join(', ')} • Min courts:{' '}
                {selectedFormat.minCourts ?? 'N/A'}
              </p>
            )}
          </div>
        </section>

        {poolIssues.length > 0 && (
          <p className="error">{poolIssues.join('; ')}</p>
        )}
        {error && <p className="error">{error}</p>}
        {message && <p className="subtle phase1-success">{message}</p>}

        {pools.length > 0 && (
          <DndContext
            sensors={dragSensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
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
                        disabled={savingPools || generatingMatches}
                      />
                    ))}
                    {teamBank.length === 0 && <p className="subtle">No teams in bank.</p>}
                  </TeamDropContainer>
                </SortableContext>
              </section>

              <div className="phase1-pool-grid">
                {pools.map((pool) => {
                  const poolTeams = Array.isArray(pool?.teamIds) ? pool.teamIds : [];
                  const isValidPool = poolTeams.length === pool.requiredTeamCount;
                  const normalizedPoolCourt = normalizeCourtCode(pool.homeCourt);
                  const poolCourtOptions = normalizedPoolCourt
                    ? [
                        normalizedPoolCourt,
                        ...selectablePoolCourts.filter((courtCode) => courtCode !== normalizedPoolCourt),
                      ]
                    : selectablePoolCourts;

                  return (
                    <section
                      key={pool._id}
                      className={`phase1-pool-column ${isValidPool ? '' : 'phase1-pool-column--invalid'}`}
                    >
                      <header className="phase1-pool-header">
                        <h2>Pool {pool.name}</h2>
                        {poolCourtOptions.length > 0 ? (
                          <label className="phase1-pool-court-control">
                            <span className="phase1-pool-court-label">Court</span>
                            <select
                              className="phase1-pool-court-select"
                              value={normalizedPoolCourt || poolCourtOptions[0]}
                              onChange={(event) => handlePoolCourtChange(pool._id, event.target.value)}
                              disabled={
                                savingPools ||
                                generatingMatches ||
                                applying ||
                                updatingPoolCourtId === pool._id
                              }
                            >
                              {poolCourtOptions.map((courtCode) => (
                                <option key={courtCode} value={courtCode}>
                                  {mapCourtLabel(courtCode)}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : (
                          <p className="subtle">No active courts available</p>
                        )}
                        <p className="phase1-pool-count">
                          {poolTeams.length}/{pool.requiredTeamCount}
                        </p>
                      </header>

                      <SortableContext
                        items={poolTeams.map((team) => team._id)}
                        strategy={verticalListSortingStrategy}
                      >
                        <TeamDropContainer containerId={pool._id} className="phase1-drop-list">
                          {poolTeams.map((team) => (
                            <DraggableTeamCard
                              key={team._id}
                              team={team}
                              disabled={savingPools || generatingMatches}
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
              {activeDragTeam ? <TeamCardPreview team={activeDragTeam} /> : null}
            </DragOverlay>
          </DndContext>
        )}

        {firstStageMatches.length > 0 && (
          <section className="phase1-schedule">
            <h2 className="secondary-title">{firstPoolStage?.displayName || 'Pool Play'} Schedule</h2>
            <div className="phase1-table-wrap">
              <table className="phase1-schedule-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Court</th>
                    <th>Pool</th>
                    <th>Match</th>
                  </tr>
                </thead>
                <tbody>
                  {firstStageMatches.map((match) => (
                    <tr key={match._id}>
                      <td>{formatRoundBlockStartTime(match.roundBlock, tournament) || '-'}</td>
                      <td>{mapCourtLabel(match.court)}</td>
                      <td>{match.poolName ? `Pool ${match.poolName}` : '-'}</td>
                      <td>
                        {formatTeamLabel(match.teamA)} vs {formatTeamLabel(match.teamB)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {crossoverStage && (
          <section className="phase1-standings">
            <div className="phase1-admin-header">
              <div>
                <h2 className="secondary-title">{crossoverStage.displayName || 'Crossover'}</h2>
                <p className="subtle">
                  Rank-to-rank crossover pairing preview.
                </p>
              </div>
              <div className="phase1-admin-actions">
                <button
                  className="primary-button"
                  type="button"
                  onClick={handleGenerateCrossoverMatches}
                  disabled={generatingCrossoverMatches || crossoverPreviewRows.length === 0}
                >
                  {generatingCrossoverMatches ? 'Generating...' : 'Generate Crossover Matches'}
                </button>
              </div>
            </div>

            {crossoverPreviewRows.length === 0 ? (
              <p className="subtle">
                Awaiting standings from {firstPoolStage?.displayName || 'Pool Play'}.
              </p>
            ) : (
              <div className="phase1-table-wrap">
                <table className="phase1-standings-table">
                  <thead>
                    <tr>
                      <th>Pairing</th>
                      <th>Teams</th>
                    </tr>
                  </thead>
                  <tbody>
                    {crossoverPreviewRows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.label}</td>
                        <td>{row.leftTeamLabel} vs {row.rightTeamLabel}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {crossoverMatches.length > 0 && (
              <div className="phase1-table-wrap">
                <table className="phase1-schedule-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Court</th>
                      <th>Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {crossoverMatches.map((match) => (
                      <tr key={match._id}>
                        <td>{formatRoundBlockStartTime(match.roundBlock, tournament) || '-'}</td>
                        <td>{mapCourtLabel(match.court)}</td>
                        <td>{formatTeamLabel(match.teamA)} vs {formatTeamLabel(match.teamB)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {playoffStage && (
          <section className="phase1-standings">
            <div className="phase1-admin-header">
              <div>
                <h2 className="secondary-title">{playoffStage.displayName || 'Playoffs'}</h2>
                <p className="subtle">Playoff generation follows the selected format.</p>
              </div>
              <div className="phase1-admin-actions">
                <button
                  className="primary-button"
                  type="button"
                  onClick={handleGeneratePlayoffs}
                  disabled={generatingPlayoffs}
                >
                  {generatingPlayoffs ? 'Generating...' : 'Generate Playoffs'}
                </button>
                <a className="secondary-button" href={`/tournaments/${id}/playoffs`}>
                  Open Playoffs Page
                </a>
              </div>
            </div>

            {playoffsPayload.opsSchedule.length > 0 && (
              <div className="phase1-table-wrap">
                <table className="phase1-schedule-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Court</th>
                      <th>Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {playoffsPayload.opsSchedule.flatMap((roundBlock) =>
                      (Array.isArray(roundBlock?.slots) ? roundBlock.slots : []).map((slot) => (
                        <tr key={`${roundBlock.roundBlock}-${slot.court}-${slot.matchId || 'slot'}`}>
                          <td>{formatRoundBlockStartTime(roundBlock.roundBlock, tournament) || '-'}</td>
                          <td>{mapCourtLabel(slot.court)}</td>
                          <td>{slot.matchLabel || '-'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {playoffBracketOrder.length > 0 && (
              <div className="playoff-bracket-grid">
                {playoffBracketOrder.map((bracketKey) => {
                  const normalizedBracketKey = String(bracketKey || '').toLowerCase();
                  const bracketData = playoffsPayload.brackets?.[normalizedBracketKey];
                  if (!bracketData) {
                    return null;
                  }

                  const roundOrder = Array.isArray(bracketData.roundOrder) && bracketData.roundOrder.length > 0
                    ? bracketData.roundOrder
                    : Object.keys(bracketData.rounds || {}).sort((left, right) => {
                        const byRank = parseRoundRank(left) - parseRoundRank(right);
                        if (byRank !== 0) {
                          return byRank;
                        }
                        return left.localeCompare(right);
                      });

                  return (
                    <article key={`playoff-bracket-${normalizedBracketKey}`} className="phase1-standings-card playoff-bracket-card">
                      <h3>{bracketData.label || toTitleCase(normalizedBracketKey)}</h3>
                      <div className="playoff-seed-list">
                        {(Array.isArray(bracketData.seeds) ? bracketData.seeds : []).length > 0 ? (
                          (bracketData.seeds || []).map((seedEntry) => (
                            <p key={`${normalizedBracketKey}-seed-${seedEntry.seed || seedEntry.bracketSeed}`}>
                              #
                              {Number.isFinite(Number(seedEntry?.overallSeed))
                                ? Number(seedEntry.overallSeed)
                                : Number(seedEntry?.seed) || Number(seedEntry?.bracketSeed) || '?'}
                              {' '}
                              {formatTeamLabel(seedEntry?.team)}
                            </p>
                          ))
                        ) : (
                          <p className="subtle">Seeds not resolved</p>
                        )}
                      </div>
                      {roundOrder.map((roundKey) => (
                        <div key={`${normalizedBracketKey}-${roundKey}`} className="playoff-round-block">
                          <h4>{roundKey}</h4>
                          {(bracketData.rounds?.[roundKey] || []).map((match) => (
                            <div key={match._id} className="playoff-round-match">
                              <p>{formatTeamLabel(match.teamA)} vs {formatTeamLabel(match.teamB)}</p>
                              <p className="subtle">
                                {mapCourtLabel(match.court)} • {match.status || 'scheduled'}
                              </p>
                            </div>
                          ))}
                        </div>
                      ))}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </section>
    </main>
  );
}

export default TournamentFormatAdmin;

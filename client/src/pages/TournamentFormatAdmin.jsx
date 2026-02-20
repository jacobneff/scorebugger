import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { mapCourtLabel } from '../utils/phase1.js';
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
// RR schedule templates (0-based position indices into ordered pool teams)
// Pool 3: 1v3/ref2 | 2v3/ref1 | 1v2/ref3
// Pool 4: 1v3/ref2/bye4 | 2v4/ref1/bye3 | 1v4/ref3/bye2 | 2v3/ref1/bye4 | 3v4/ref2/bye1 | 1v2/ref4/bye3
const RR_PREVIEW_TEMPLATES = Object.freeze({
  3: [
    { a: 0, b: 2, ref: 1, bye: null },
    { a: 1, b: 2, ref: 0, bye: null },
    { a: 0, b: 1, ref: 2, bye: null },
  ],
  4: [
    { a: 0, b: 2, ref: 1, bye: 3 },
    { a: 1, b: 3, ref: 0, bye: 2 },
    { a: 0, b: 3, ref: 2, bye: 1 },
    { a: 1, b: 2, ref: 0, bye: 3 },
    { a: 2, b: 3, ref: 1, bye: 0 },
    { a: 0, b: 1, ref: 3, bye: 2 },
  ],
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

const getPoolStages = (formatDef) =>
  Array.isArray(formatDef?.stages)
    ? formatDef.stages.filter((stage) => stage?.type === 'poolPlay')
    : [];

const getStageByType = (formatDef, stageType) =>
  Array.isArray(formatDef?.stages)
    ? formatDef.stages.find((stage) => stage?.type === stageType) || null
    : null;

const formatTeamLabel = (team) => team?.shortName || team?.name || 'TBD';

const buildPoolPlayTemplateRows = (poolEntries) => {
  const rows = [];

  (Array.isArray(poolEntries) ? poolEntries : []).forEach((poolEntry, poolIndex) => {
    const poolName = String(poolEntry?.name || '').trim();
    const poolSize = Number(poolEntry?.requiredTeamCount ?? poolEntry?.size);
    const template = RR_PREVIEW_TEMPLATES[poolSize];

    if (!poolName || !template) {
      return;
    }

    template.forEach((entry, index) => {
      rows.push({
        id: `${poolName}-${poolIndex}-match-${index + 1}`,
        poolName,
        roundBlock: index + 1,
        aLabel: `${poolName}${entry.a + 1}`,
        bLabel: `${poolName}${entry.b + 1}`,
        refLabel: `${poolName}${entry.ref + 1}`,
        byeLabel: entry.bye !== null ? `${poolName}${entry.bye + 1}` : null,
      });
    });
  });

  return rows;
};

const buildCrossoverTemplateRows = ({ crossoverStage, poolSizeByName }) => {
  if (
    !crossoverStage ||
    !Array.isArray(crossoverStage.fromPools) ||
    crossoverStage.fromPools.length !== 2
  ) {
    return [];
  }

  const leftName = String(crossoverStage.fromPools[0] || '');
  const rightName = String(crossoverStage.fromPools[1] || '');
  const leftPoolSize = Number(poolSizeByName.get(leftName));
  const rightPoolSize = Number(poolSizeByName.get(rightName));
  const pairingCount =
    Number.isFinite(leftPoolSize) && Number.isFinite(rightPoolSize)
      ? Math.min(leftPoolSize, rightPoolSize)
      : 3;

  const rank = (poolName, rankNumber) => `${poolName} (#${rankNumber})`;
  const getRef = (index) => {
    if (index === 0) return rank(leftName, 2);
    if (index === 1) return rank(rightName, pairingCount);
    if (index === 2) return rank(rightName, 2);
    return null;
  };
  const getRoundBlock = (index) => {
    if (pairingCount >= 2 && index <= 1) return 1;
    if (pairingCount >= 2) return 2;
    return index + 1;
  };
  const getByeLabel = (index) => {
    if (pairingCount === 3) {
      if (index === 0) return rank(leftName, pairingCount);
      if (index === 1) return null;
      if (index === 2) {
        return `${rank(leftName, 1)}, ${rank(leftName, 2)}, ${rank(rightName, 1)}`;
      }
    }
    return null;
  };

  return Array.from({ length: pairingCount }, (_, index) => ({
    id: `${leftName}-${rightName}-${index + 1}`,
    roundBlock: getRoundBlock(index),
    matchLabel: `${rank(leftName, index + 1)} vs ${rank(rightName, index + 1)}`,
    refLabel: getRef(index),
    byeLabel: getByeLabel(index),
  }));
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
  const navigate = useNavigate();
  const { id } = useParams();
  const { token, user, initializing } = useAuth();
  const [tournament, setTournament] = useState(null);
  const [teams, setTeams] = useState([]);
  const [pools, setPools] = useState([]);
  const [suggestedFormats, setSuggestedFormats] = useState([]);
  const [appliedFormatDef, setAppliedFormatDef] = useState(null);
  const [selectedFormatDef, setSelectedFormatDef] = useState(null);
  const [selectedFormatId, setSelectedFormatId] = useState('');
  const [activeCourts, setActiveCourts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [resettingTournament, setResettingTournament] = useState(false);
  const [savingPools, setSavingPools] = useState(false);
  const [updatingPoolCourtId, setUpdatingPoolCourtId] = useState('');
  const [initializingPools, setInitializingPools] = useState(false);
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

  const fetchFormatDef = useCallback(
    async (formatId) => {
      const normalizedFormatId = typeof formatId === 'string' ? formatId.trim() : '';
      if (!normalizedFormatId) {
        return null;
      }

      return fetchJson(`${API_URL}/api/tournament-formats/${normalizedFormatId}`);
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
        return;
      }

      const formatDef = await fetchFormatDef(tournamentFormatId);
      setAppliedFormatDef(formatDef);
      const poolStages = getPoolStages(formatDef);
      const firstPoolStage = poolStages[0] || null;

      const nextPools = await (firstPoolStage ? loadPools(firstPoolStage.key) : Promise.resolve([]));
      setPools(nextPools);
    } catch (loadError) {
      setError(loadError.message || 'Unable to load format setup');
    } finally {
      setLoading(false);
    }
  }, [
    fetchJson,
    fetchFormatDef,
    id,
    loadPools,
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

  useEffect(() => {
    let cancelled = false;

    const loadSelectedFormatDef = async () => {
      const normalizedSelectedId =
        typeof selectedFormatId === 'string' ? selectedFormatId.trim() : '';

      if (!normalizedSelectedId) {
        setSelectedFormatDef(null);
        return;
      }

      if (appliedFormatDef?.id === normalizedSelectedId) {
        setSelectedFormatDef(appliedFormatDef);
        return;
      }

      try {
        const payload = await fetchFormatDef(normalizedSelectedId);
        if (!cancelled) {
          setSelectedFormatDef(payload);
        }
      } catch {
        if (!cancelled) {
          setSelectedFormatDef(null);
        }
      }
    };

    loadSelectedFormatDef();

    return () => {
      cancelled = true;
    };
  }, [appliedFormatDef, fetchFormatDef, selectedFormatId]);

  const appliedPoolStages = useMemo(() => getPoolStages(appliedFormatDef), [appliedFormatDef]);
  const appliedFirstPoolStage = appliedPoolStages[0] || null;
  const appliedSecondPoolStage = appliedPoolStages[1] || null;
  const appliedCrossoverStage = useMemo(
    () => getStageByType(appliedFormatDef, 'crossover'),
    [appliedFormatDef]
  );
  const appliedPlayoffStage = useMemo(
    () => getStageByType(appliedFormatDef, 'playoffs'),
    [appliedFormatDef]
  );
  const selectedPoolStages = useMemo(() => getPoolStages(selectedFormatDef), [selectedFormatDef]);
  const selectedFirstPoolStage = selectedPoolStages[0] || null;
  const selectedSecondPoolStage = selectedPoolStages[1] || null;
  const selectedCrossoverStage = useMemo(
    () => getStageByType(selectedFormatDef, 'crossover'),
    [selectedFormatDef]
  );
  const selectedPlayoffStage = useMemo(
    () => getStageByType(selectedFormatDef, 'playoffs'),
    [selectedFormatDef]
  );
  const firstPoolStage = appliedFirstPoolStage;
  const secondPoolStage = appliedSecondPoolStage;
  const crossoverStage = appliedCrossoverStage;
  const playoffStage = appliedPlayoffStage;
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
    (selectedFormatDef && selectedFormatId === selectedFormatDef.id
      ? {
          id: selectedFormatDef.id,
          name: selectedFormatDef.name,
          description: selectedFormatDef.description,
          supportedTeamCounts: selectedFormatDef.supportedTeamCounts,
          minCourts: selectedFormatDef.minCourts,
        }
      : null);
  const activeFormatId = (appliedFormatDef?.id || selectedFormatDef?.id || selectedFormatId || '').trim();
  const showLegacyPhase2 =
    activeFormatId === ODU_15_FORMAT_ID &&
    Boolean(appliedSecondPoolStage || selectedSecondPoolStage);
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
    const poolSizeByName = new Map(
      pools.map((pool) => [String(pool?.name || ''), Number(pool?.requiredTeamCount)])
    );
    return buildCrossoverTemplateRows({
      crossoverStage,
      poolSizeByName,
    });
  }, [crossoverStage, pools]);

  const courtConflicts = useMemo(() => {
    const counts = new Map();
    pools.forEach((pool) => {
      if (pool.homeCourt) {
        counts.set(pool.homeCourt, (counts.get(pool.homeCourt) || 0) + 1);
      }
    });
    return pools
      .filter((pool) => pool.homeCourt && (counts.get(pool.homeCourt) || 0) > 1)
      .map((pool) => pool.name);
  }, [pools]);

  const poolPlayPreviewRows = useMemo(() => {
    if (!firstPoolStage || pools.length === 0) {
      return [];
    }

    return buildPoolPlayTemplateRows(
      pools.map((pool) => ({
        name: pool?.name,
        requiredTeamCount: pool?.requiredTeamCount,
      }))
    );
  }, [firstPoolStage, pools]);
  const proposedPoolPlayPreviewRows = useMemo(() => {
    if (!selectedFirstPoolStage || !Array.isArray(selectedFirstPoolStage?.pools)) {
      return [];
    }

    return buildPoolPlayTemplateRows(
      selectedFirstPoolStage.pools.map((pool) => ({
        name: pool?.name,
        requiredTeamCount: pool?.size,
      }))
    );
  }, [selectedFirstPoolStage]);
  const proposedCrossoverPreviewRows = useMemo(() => {
    const poolSizeByName = new Map(
      (Array.isArray(selectedFirstPoolStage?.pools) ? selectedFirstPoolStage.pools : []).map(
        (pool) => [String(pool?.name || ''), Number(pool?.size)]
      )
    );
    return buildCrossoverTemplateRows({
      crossoverStage: selectedCrossoverStage,
      poolSizeByName,
    });
  }, [selectedCrossoverStage, selectedFirstPoolStage]);

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
      setMessage('Tournament reset. Rebuild pools and schedules as needed.');
      await loadData();
      navigate(`/tournaments/${id}/format`, { replace: true });
    } catch (resetError) {
      setError(resetError.message || 'Unable to reset tournament');
    } finally {
      setResettingTournament(false);
    }
  }, [fetchJson, id, loadData, navigate, resettingTournament, token, tournament?.isOwner]);

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
      setMessage(`${firstPoolStage.displayName || 'Pool Play'} pools initialized.`);
    } catch (initError) {
      setError(initError.message || 'Unable to initialize pools');
    } finally {
      setInitializingPools(false);
    }
  }, [fetchJson, firstPoolStage, id, initializingPools, token]);

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
            <TournamentAdminNav
              tournamentId={id}
              publicCode={tournament?.publicCode || ''}
              activeMainTab="scheduling"
              scheduling={{
                activeSubTab: 'format',
                showPhase2: showLegacyPhase2,
                phase1Label:
                  firstPoolStage?.displayName || (showLegacyPhase2 ? 'Pool Play 1' : 'Pool Play'),
                phase1Href: `/tournaments/${id}/phase1`,
                phase2Label: secondPoolStage?.displayName || 'Pool Play 2',
                phase2Href: showLegacyPhase2 ? `/tournaments/${id}/phase2` : `/tournaments/${id}/format`,
                playoffsHref: `/tournaments/${id}/playoffs`,
              }}
            />
          </div>
          <div className="phase1-admin-actions">
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

        {courtConflicts.length > 0 && (
          <p className="error">
            Court conflict: Pools {courtConflicts.join(', ')} share the same home court. Assign unique courts before generating matches.
          </p>
        )}
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
                        disabled={savingPools}
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
                              disabled={savingPools}
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

        {selectedFormatDef && (
          <section className="phase1-schedule">
            <h2 className="secondary-title">Proposed Template</h2>
            <p className="subtle">Preview from the selected format before applying changes.</p>

            {proposedPoolPlayPreviewRows.length > 0 ? (
              <div className="phase1-table-wrap">
                <table className="phase1-schedule-table">
                  <thead>
                    <tr>
                      <th>Round</th>
                      <th>Pool</th>
                      <th>Match</th>
                      <th>Ref</th>
                      <th>Bye</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proposedPoolPlayPreviewRows.map((row) => (
                      <tr key={`proposed-${row.id}`}>
                        <td>{row.roundBlock}</td>
                        <td>Pool {row.poolName}</td>
                        <td>{row.aLabel} vs {row.bLabel}</td>
                        <td>{row.refLabel}</td>
                        <td>{row.byeLabel || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="subtle">No pool-play template available for this format.</p>
            )}

            {selectedCrossoverStage ? (
              <>
                <h3>{selectedCrossoverStage.displayName || 'Crossover'}</h3>
                {proposedCrossoverPreviewRows.length === 0 ? (
                  <p className="subtle">No crossover pairings defined in this format.</p>
                ) : (
                  <div className="phase1-table-wrap">
                    <table className="phase1-schedule-table">
                      <thead>
                        <tr>
                          <th>Round</th>
                          <th>Match</th>
                          <th>Ref</th>
                          <th>Bye</th>
                        </tr>
                      </thead>
                      <tbody>
                        {proposedCrossoverPreviewRows.map((row) => (
                          <tr key={`proposed-crossover-${row.id}`}>
                            <td>{row.roundBlock}</td>
                            <td>{row.matchLabel}</td>
                            <td>{row.refLabel || '—'}</td>
                            <td>{row.byeLabel || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            ) : null}

            {selectedPlayoffStage ? (
              <p className="subtle">
                {selectedPlayoffStage.displayName || 'Playoffs'} structure follows the selected format.
              </p>
            ) : null}
          </section>
        )}

        {appliedFormatDef && (
          <section className="phase1-schedule">
            <h2 className="secondary-title">Current Applied Template</h2>
            <p className="subtle">
              Current pool and stage template for the applied format. Generate matches on stage pages.
            </p>

            {poolPlayPreviewRows.length > 0 ? (
              <div className="phase1-table-wrap">
                <table className="phase1-schedule-table">
                  <thead>
                    <tr>
                      <th>Round</th>
                      <th>Pool</th>
                      <th>Match</th>
                      <th>Ref</th>
                      <th>Bye</th>
                    </tr>
                  </thead>
                  <tbody>
                    {poolPlayPreviewRows.map((row) => (
                      <tr key={`applied-${row.id}`}>
                        <td>{row.roundBlock}</td>
                        <td>Pool {row.poolName}</td>
                        <td>{row.aLabel} vs {row.bLabel}</td>
                        <td>{row.refLabel}</td>
                        <td>{row.byeLabel || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="subtle">No applied pool-play template available yet.</p>
            )}

            {crossoverStage ? (
              <>
                <h3>{crossoverStage.displayName || 'Crossover'}</h3>
                {crossoverPreviewRows.length === 0 ? (
                  <p className="subtle">No crossover pairings defined in this format.</p>
                ) : (
                  <div className="phase1-table-wrap">
                    <table className="phase1-schedule-table">
                      <thead>
                        <tr>
                          <th>Round</th>
                          <th>Match</th>
                          <th>Ref</th>
                          <th>Bye</th>
                        </tr>
                      </thead>
                      <tbody>
                        {crossoverPreviewRows.map((row) => (
                          <tr key={`applied-crossover-${row.id}`}>
                            <td>{row.roundBlock}</td>
                            <td>{row.matchLabel}</td>
                            <td>{row.refLabel || '—'}</td>
                            <td>{row.byeLabel || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            ) : null}

            {playoffStage ? (
              <div className="phase1-admin-actions">
                <p className="subtle">
                  {playoffStage.displayName || 'Playoffs'} generation follows the applied format.
                </p>
                <a className="secondary-button" href={`/tournaments/${id}/playoffs`}>
                  Open Playoffs Page
                </a>
              </div>
            ) : null}
          </section>
        )}
      </section>
    </main>
  );
}

export default TournamentFormatAdmin;

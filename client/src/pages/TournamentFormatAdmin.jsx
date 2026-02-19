import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  DndContext,
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
  const [suggestedFormats, setSuggestedFormats] = useState([]);
  const [selectedFormatId, setSelectedFormatId] = useState('');
  const [activeCourts, setActiveCourts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [savingPools, setSavingPools] = useState(false);
  const [updatingPoolCourtId, setUpdatingPoolCourtId] = useState('');
  const [initializingPools, setInitializingPools] = useState(false);
  const [generatingMatches, setGeneratingMatches] = useState(false);
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

  const loadPools = useCallback(async () => {
    const poolPayload = await fetchJson(`${API_URL}/api/tournaments/${id}/phase1/pools`, {
      headers: authHeaders(token),
    });
    const nextPools = Array.isArray(poolPayload) ? poolPayload.map(normalizePool) : [];
    setPools(nextPools);
    return nextPools;
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
          ? tournamentPayload.settings.format.formatId
          : '';

      setTournament(tournamentPayload);
      setTeams(normalizedTeams);
      setActiveCourts(nextActiveCourts);
      setSelectedFormatId(tournamentFormatId || '');

      await Promise.all([
        loadSuggestions(normalizedTeams.length, nextActiveCourts.length),
        loadPools(),
      ]);
    } catch (loadError) {
      setError(loadError.message || 'Unable to load format setup');
    } finally {
      setLoading(false);
    }
  }, [fetchJson, id, loadPools, loadSuggestions, token]);

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

  const teamBank = useMemo(() => buildTeamBankFromPools(teams, pools), [pools, teams]);
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

  const selectedFormat = suggestedFormats.find((entry) => entry.id === selectedFormatId) || null;
  const showLegacyPhase2 = selectedFormatId === ODU_15_FORMAT_ID;

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

  const handleDragEnd = useCallback(
    async (event) => {
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
        await persistPoolChanges({
          previousPools,
          nextPools: optimisticNextPools,
          poolIdsToPersist,
        });
      } catch (persistError) {
        setPools(previousPools);
        setError(persistError.message || 'Unable to save pools');
        return;
      } finally {
        setSavingPools(false);
      }

      loadPools().catch((refreshError) => {
        setError(
          refreshError.message ||
            'Pools were saved but could not be refreshed. Reload to confirm latest order.'
        );
      });
    },
    [loadPools, persistPoolChanges, pools, savingPools, teams]
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
      setMessage('Format applied. Assign teams to pools and generate matches.');
      await loadData();
    } catch (applyError) {
      setError(applyError.message || 'Unable to apply format');
    } finally {
      setApplying(false);
    }
  }, [activeCourts, applying, id, loadData, selectedFormatId, token]);

  const handleInitializePools = useCallback(async () => {
    if (initializingPools) {
      return;
    }

    setInitializingPools(true);
    setError('');
    setMessage('');

    try {
      const payload = await fetchJson(
        `${API_URL}/api/tournaments/${id}/stages/${FIRST_STAGE_KEY}/pools/init`,
        {
          method: 'POST',
          headers: authHeaders(token),
        }
      );
      setPools(Array.isArray(payload) ? payload.map((pool) => normalizePool(pool)) : []);
      setMessage('Pool Play 1 pools initialized.');
    } catch (initError) {
      setError(initError.message || 'Unable to initialize pools');
    } finally {
      setInitializingPools(false);
    }
  }, [fetchJson, id, initializingPools, token]);

  const handleGenerateMatches = useCallback(async () => {
    if (generatingMatches) {
      return;
    }

    setGeneratingMatches(true);
    setError('');
    setMessage('');

    const runGenerate = async (force) => {
      const suffix = force ? '?force=true' : '';
      const response = await fetch(
        `${API_URL}/api/tournaments/${id}/stages/${FIRST_STAGE_KEY}/matches/generate${suffix}`,
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
        setMessage(`Generated ${forcedAttempt.payload.length} Pool Play 1 matches.`);
        return;
      }

      setMessage(`Generated ${firstAttempt.payload.length} Pool Play 1 matches.`);
    } catch (generateError) {
      setError(generateError.message || 'Unable to generate matches');
    } finally {
      setGeneratingMatches(false);
    }
  }, [generatingMatches, id, token]);

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
        await fetchJson(`${API_URL}/api/pools/${poolId}`, {
          method: 'PATCH',
          headers: jsonHeaders(token),
          body: JSON.stringify({
            homeCourt: normalizedNextCourt,
          }),
        });

        await loadPools();
        setMessage(`Pool ${targetPool.name} home court updated to ${mapCourtLabel(normalizedNextCourt)}.`);
      } catch (courtError) {
        setError(courtError.message || 'Unable to update pool home court');
      } finally {
        setUpdatingPoolCourtId('');
      }
    },
    [fetchJson, loadPools, pools, token, updatingPoolCourtId]
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
              then generate Pool Play 1 matches.
            </p>
            <TournamentSchedulingTabs
              tournamentId={id}
              activeTab="format"
              showPhase2={showLegacyPhase2}
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
              disabled={initializingPools || savingPools}
            >
              {initializingPools ? 'Initializing...' : 'Init Pool Play 1 Pools'}
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={handleGenerateMatches}
              disabled={
                generatingMatches ||
                savingPools ||
                pools.length === 0 ||
                poolIssues.length > 0
              }
            >
              {generatingMatches ? 'Generating...' : 'Generate Pool Play 1 Matches'}
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
          </DndContext>
        )}

        {showLegacyPhase2 && (
          <div className="phase1-admin-actions">
            <a className="secondary-button" href={`/tournaments/${id}/phase1`}>
              Legacy Pool Play 1
            </a>
            <a className="secondary-button" href={`/tournaments/${id}/phase2`}>
              Pool Play 2
            </a>
            <a className="secondary-button" href={`/tournaments/${id}/playoffs`}>
              Playoffs
            </a>
          </div>
        )}
      </section>
    </main>
  );
}

export default TournamentFormatAdmin;

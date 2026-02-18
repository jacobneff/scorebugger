import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import { API_URL } from '../config/env.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useTournamentRealtime } from '../hooks/useTournamentRealtime.js';
import {
  PHASE2_COURT_ORDER,
  PHASE2_ROUND_BLOCKS,
  buildPhase2ScheduleLookup,
  formatTeamLabel,
  sortPhase2Pools,
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

const formatSetPct = (value) => `${(Math.max(0, Number(value) || 0) * 100).toFixed(1)}%`;

const formatPointDiff = (value) => {
  const parsed = Number(value) || 0;
  return parsed > 0 ? `+${parsed}` : `${parsed}`;
};
const formatLiveSummary = (summary) =>
  `Live: Sets ${summary.sets?.a ?? 0}-${summary.sets?.b ?? 0} • Pts ${summary.points?.a ?? 0}-${summary.points?.b ?? 0}`;

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

function TournamentPhase2Admin() {
  const { id } = useParams();
  const { token, user, initializing } = useAuth();

  const [tournament, setTournament] = useState(null);
  const [pools, setPools] = useState([]);
  const [matches, setMatches] = useState([]);
  const [standingsByPhase, setStandingsByPhase] = useState({
    phase2: { pools: [], overall: [] },
    cumulative: { pools: [], overall: [] },
  });
  const [activeStandingsTab, setActiveStandingsTab] = useState('phase2');
  const [dragState, setDragState] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  const [loading, setLoading] = useState(true);
  const [savingPools, setSavingPools] = useState(false);
  const [poolsGenerateLoading, setPoolsGenerateLoading] = useState(false);
  const [generateLoading, setGenerateLoading] = useState(false);
  const [standingsLoading, setStandingsLoading] = useState(false);
  const [matchActionId, setMatchActionId] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [liveSummariesByMatchId, setLiveSummariesByMatchId] = useState({});

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
      const [tournamentData, poolData, matchData, phase2Standings, cumulativeStandings] =
        await Promise.all([
          fetchJson(`${API_URL}/api/tournaments/${id}`, {
            headers: authHeaders(token),
          }),
          loadPools(),
          loadMatches(),
          loadStandings('phase2'),
          loadStandings('cumulative'),
        ]);

      setTournament(tournamentData);
      setPools(poolData);
      setMatches(matchData);
      setStandingsByPhase({
        phase2: phase2Standings,
        cumulative: cumulativeStandings,
      });
    } catch (loadError) {
      setError(loadError.message || 'Unable to load Phase 2 data');
    } finally {
      setLoading(false);
    }
  }, [fetchJson, id, loadMatches, loadPools, loadStandings, token]);

  const refreshMatchesAndStandings = useCallback(async () => {
    setStandingsLoading(true);

    try {
      const [matchData, phase2Standings, cumulativeStandings] = await Promise.all([
        loadMatches(),
        loadStandings('phase2'),
        loadStandings('cumulative'),
      ]);
      setMatches(matchData);
      setStandingsByPhase({
        phase2: phase2Standings,
        cumulative: cumulativeStandings,
      });
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

      if (event.type === 'POOLS_UPDATED' && event.data?.phase === 'phase2') {
        loadPools()
          .then((nextPools) => {
            setPools(nextPools);
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
    [loadPools, refreshMatchesAndStandings]
  );

  useTournamentRealtime({
    tournamentCode: tournament?.publicCode,
    enabled: Boolean(token && tournament?.publicCode),
    onEvent: handleTournamentRealtimeEvent,
  });

  const invalidPools = useMemo(
    () => pools.filter((pool) => pool.teamIds.length !== 3),
    [pools]
  );

  const scheduleLookup = useMemo(() => buildPhase2ScheduleLookup(matches), [matches]);

  const moveTeam = useCallback(
    (sourcePoolId, teamId, targetPoolId, targetIndex) => {
      const sourcePoolIndex = pools.findIndex((pool) => pool._id === sourcePoolId);
      const targetPoolIndex = pools.findIndex((pool) => pool._id === targetPoolId);

      if (sourcePoolIndex === -1 || targetPoolIndex === -1) {
        return null;
      }

      const sourcePool = pools[sourcePoolIndex];
      const targetPool = pools[targetPoolIndex];
      const sourceTeamIndex = sourcePool.teamIds.findIndex((team) => team._id === teamId);

      if (sourceTeamIndex === -1) {
        return null;
      }

      if (sourcePoolId !== targetPoolId && targetPool.teamIds.length >= 3) {
        setError('A pool can include at most 3 teams. Move one out first.');
        return null;
      }

      const nextPools = pools.map((pool) => ({
        ...pool,
        teamIds: [...pool.teamIds],
      }));

      const [draggedTeam] = nextPools[sourcePoolIndex].teamIds.splice(sourceTeamIndex, 1);
      let boundedTargetIndex = Math.max(
        0,
        Math.min(targetIndex, nextPools[targetPoolIndex].teamIds.length)
      );

      if (sourcePoolIndex === targetPoolIndex && sourceTeamIndex < boundedTargetIndex) {
        boundedTargetIndex -= 1;
      }

      nextPools[targetPoolIndex].teamIds.splice(boundedTargetIndex, 0, draggedTeam);

      if (sourcePoolIndex === targetPoolIndex && sourceTeamIndex === boundedTargetIndex) {
        return null;
      }

      return nextPools;
    },
    [pools]
  );

  const persistPoolChanges = useCallback(
    async (nextPools, sourcePoolId, targetPoolId) => {
      const patchPool = async (poolId) => {
        const pool = nextPools.find((entry) => entry._id === poolId);
        if (!pool) {
          return;
        }

        await fetchJson(`${API_URL}/api/pools/${poolId}`, {
          method: 'PATCH',
          headers: jsonHeaders(token),
          body: JSON.stringify({
            teamIds: pool.teamIds.map((team) => team._id),
          }),
        });
      };

      await patchPool(sourcePoolId);
      if (targetPoolId !== sourcePoolId) {
        await patchPool(targetPoolId);
      }
    },
    [fetchJson, token]
  );

  const handleDrop = useCallback(
    async (targetPoolId, targetIndex) => {
      if (!dragState || savingPools) {
        return;
      }

      const nextPools = moveTeam(
        dragState.poolId,
        dragState.teamId,
        targetPoolId,
        targetIndex
      );

      setDropTarget(null);
      setDragState(null);

      if (!nextPools) {
        return;
      }

      const previousPools = pools;
      setPools(nextPools);
      setSavingPools(true);
      setError('');
      setMessage('');

      try {
        await persistPoolChanges(nextPools, dragState.poolId, targetPoolId);
        const refreshedPools = await loadPools();
        setPools(refreshedPools);
        setMessage('Phase 2 pool assignments saved.');
      } catch (saveError) {
        setPools(previousPools);
        setError(saveError.message || 'Unable to save pool changes');
      } finally {
        setSavingPools(false);
      }
    },
    [dragState, loadPools, moveTeam, persistPoolChanges, pools, savingPools]
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
          message: payload?.message || 'Phase 2 pools already exist.',
        };
      }

      if (!response.ok || !payload) {
        const details =
          Array.isArray(payload?.missing) && payload.missing.length > 0
            ? `\n${payload.missing.join('\n')}`
            : '';
        throw new Error(`${payload?.message || 'Unable to generate Phase 2 pools'}${details}`);
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
          `${firstAttempt.message}\n\nThis can overwrite existing Phase 2 pools. Continue?`
        );

        if (!shouldForce) {
          setMessage(firstAttempt.message);
          return;
        }

        const forcedAttempt = await generatePhase2Pools(true);
        setPools(forcedAttempt.pools);
        setMessage('Phase 2 pools regenerated from Phase 1 results.');
        return;
      }

      setPools(firstAttempt.pools);
      setMessage('Phase 2 pools generated from Phase 1 results.');
    } catch (generateError) {
      setError(generateError.message || 'Unable to generate Phase 2 pools');
    } finally {
      setPoolsGenerateLoading(false);
    }
  }, [generatePhase2Pools, id, poolsGenerateLoading, token]);

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
          message: payload?.message || 'Phase 2 matches already exist.',
        };
      }

      if (!response.ok || !Array.isArray(payload)) {
        throw new Error(payload?.message || 'Unable to generate Phase 2 matches');
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
          `${firstAttempt.message}\n\nThis will delete and regenerate all Phase 2 matches and scoreboards. Continue?`
        );

        if (!shouldForce) {
          setMessage(firstAttempt.message);
          return;
        }

        const forcedAttempt = await generatePhase2Matches(true);
        setMatches(forcedAttempt.matches);
        setMessage('Phase 2 matches regenerated.');
        await refreshMatchesAndStandings();
        return;
      }

      setMatches(firstAttempt.matches);
      setMessage('Phase 2 matches generated.');
      await refreshMatchesAndStandings();
    } catch (generateError) {
      setError(generateError.message || 'Unable to generate Phase 2 matches');
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

  const canGenerateMatches =
    pools.length === 5 && invalidPools.length === 0 && !savingPools;

  const activeStandings =
    activeStandingsTab === 'cumulative'
      ? standingsByPhase.cumulative
      : standingsByPhase.phase2;

  if (initializing || loading) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <p className="subtle">Loading Phase 2 setup...</p>
        </section>
      </main>
    );
  }

  if (!user || !token) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <h1 className="title">Phase 2 Setup</h1>
          <p className="subtle">Sign in to manage Phase 2 pools and schedule.</p>
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
            <h1 className="title">Phase 2 Setup</h1>
            <p className="subtitle">
              {tournament?.name || 'Tournament'} • Build pools F-J from Phase 1 placements, then
              generate fixed rounds 4-6.
            </p>
          </div>
          <div className="phase1-admin-actions">
            <a className="secondary-button" href={`/tournaments/${id}/playoffs`}>
              Open Playoffs
            </a>
            <button
              className="secondary-button"
              type="button"
              onClick={handleGeneratePhase2Pools}
              disabled={poolsGenerateLoading || savingPools || generateLoading}
            >
              {poolsGenerateLoading
                ? 'Generating Pools...'
                : 'Generate Phase 2 Pools from Phase 1 Results'}
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={handleGenerateMatches}
              disabled={!canGenerateMatches || generateLoading}
            >
              {generateLoading ? 'Generating Matches...' : 'Generate Phase 2 Matches'}
            </button>
          </div>
        </div>

        {savingPools && <p className="subtle">Saving pool changes...</p>}
        {invalidPools.length > 0 && (
          <p className="error">
            Each pool must have exactly 3 teams before generating matches. Invalid pools:{' '}
            {invalidPools.map((pool) => pool.name).join(', ')}.
          </p>
        )}
        {error && <p className="error">{error}</p>}
        {message && <p className="subtle phase1-success">{message}</p>}

        <div className="phase1-pool-grid">
          {pools.map((pool) => {
            const rematchLabels = buildRematchWarningLabels(pool);

            return (
              <section
                key={pool._id}
                className={`phase1-pool-column ${
                  pool.teamIds.length === 3 ? '' : 'phase1-pool-column--invalid'
                }`}
              >
                <header className="phase1-pool-header">
                  <h2>Pool {pool.name}</h2>
                  <p>{pool.homeCourt || 'No home court'}</p>
                </header>

                {rematchLabels.length > 0 && (
                  <div className="phase2-rematch-warnings">
                    {rematchLabels.map((label) => (
                      <p key={`${pool._id}-${label}`} className="error">
                        Warning: rematch {label}
                      </p>
                    ))}
                  </div>
                )}

                <div className="phase1-drop-list">
                  {Array.from({ length: pool.teamIds.length + 1 }).map((_, slotIndex) => (
                    <div key={`${pool._id}-slot-${slotIndex}`} className="phase1-drop-block">
                      <div
                        className={`phase1-drop-slot ${
                          dropTarget === `${pool._id}:${slotIndex}` ? 'is-active' : ''
                        }`}
                        onDragOver={(event) => {
                          event.preventDefault();
                          setDropTarget(`${pool._id}:${slotIndex}`);
                        }}
                        onDragLeave={() => {
                          if (dropTarget === `${pool._id}:${slotIndex}`) {
                            setDropTarget(null);
                          }
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          handleDrop(pool._id, slotIndex);
                        }}
                      />
                      {slotIndex < pool.teamIds.length && (
                        <article
                          className={`phase1-team-card ${
                            dragState?.teamId === pool.teamIds[slotIndex]._id ? 'is-dragging' : ''
                          }`}
                          draggable
                          onDragStart={() =>
                            setDragState({
                              poolId: pool._id,
                              teamId: pool.teamIds[slotIndex]._id,
                            })
                          }
                          onDragEnd={() => {
                            setDragState(null);
                            setDropTarget(null);
                          }}
                        >
                          <strong>{pool.teamIds[slotIndex].name}</strong>
                          <span>Seed #{pool.teamIds[slotIndex].seed ?? 'N/A'}</span>
                        </article>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>

        {matches.length > 0 && (
          <section className="phase1-schedule">
            <h2 className="secondary-title">Phase 2 Schedule</h2>
            <div className="phase1-table-wrap">
              <table className="phase1-schedule-table">
                <thead>
                  <tr>
                    <th>Round</th>
                    {PHASE2_COURT_ORDER.map((court) => (
                      <th key={court}>{court}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PHASE2_ROUND_BLOCKS.map((roundBlock) => (
                    <tr key={roundBlock}>
                      <th>Round {roundBlock}</th>
                      {PHASE2_COURT_ORDER.map((court) => {
                        const match = scheduleLookup[`${roundBlock}-${court}`];
                        const scoreboardKey = match?.scoreboardId || match?.scoreboardCode;
                        const refLabel = formatTeamLabel(match?.refTeams?.[0]);
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
                                  {`: ${formatTeamLabel(match.teamA)} vs ${formatTeamLabel(match.teamB)}`}
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
          <h2 className="secondary-title">Standings</h2>
          <p className="subtle">Counts finalized matches only.</p>
          {standingsLoading && <p className="subtle">Refreshing standings...</p>}

          <div className="phase1-admin-actions">
            <button
              className={activeStandingsTab === 'phase2' ? 'primary-button' : 'secondary-button'}
              type="button"
              onClick={() => setActiveStandingsTab('phase2')}
            >
              Phase 2
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
                          <th>Set %</th>
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
                            <td>{formatSetPct(team.setPct)}</td>
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
            <h3>{activeStandingsTab === 'phase2' ? 'Phase 2 Overall' : 'Cumulative Overall'}</h3>
            <div className="phase1-table-wrap">
              <table className="phase1-standings-table">
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Team</th>
                    <th>W-L</th>
                    <th>Set %</th>
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
                      <td>{formatSetPct(team.setPct)}</td>
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

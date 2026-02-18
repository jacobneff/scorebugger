import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import { API_URL } from '../config/env.js';
import { useAuth } from '../context/AuthContext.jsx';
import {
  PHASE1_COURT_ORDER,
  PHASE1_ROUND_BLOCKS,
  buildPhase1ScheduleLookup,
  formatTeamLabel,
  sortPhase1Pools,
} from '../utils/phase1.js';

const jsonHeaders = (token) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
});

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
});

const normalizePools = (pools) =>
  sortPhase1Pools(pools).map((pool) => ({
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
  }));

const formatSetPct = (value) => `${(Math.max(0, Number(value) || 0) * 100).toFixed(1)}%`;

const formatPointDiff = (value) => {
  const parsed = Number(value) || 0;
  return parsed > 0 ? `+${parsed}` : `${parsed}`;
};

function TournamentPhase1Admin() {
  const { id } = useParams();
  const { token, user, initializing } = useAuth();

  const [tournament, setTournament] = useState(null);
  const [pools, setPools] = useState([]);
  const [matches, setMatches] = useState([]);
  const [standings, setStandings] = useState({ pools: [], overall: [] });
  const [dragState, setDragState] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  const [loading, setLoading] = useState(true);
  const [initLoading, setInitLoading] = useState(false);
  const [savingPools, setSavingPools] = useState(false);
  const [generateLoading, setGenerateLoading] = useState(false);
  const [standingsLoading, setStandingsLoading] = useState(false);
  const [matchActionId, setMatchActionId] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

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
      const [tournamentData, poolData, matchData, standingsData] = await Promise.all([
        fetchJson(`${API_URL}/api/tournaments/${id}`, {
          headers: authHeaders(token),
        }),
        loadPools(),
        loadMatches(),
        loadStandings(),
      ]);

      setTournament(tournamentData);
      setPools(poolData);
      setMatches(matchData);
      setStandings(standingsData);
    } catch (loadError) {
      setError(loadError.message || 'Unable to load tournament data');
    } finally {
      setLoading(false);
    }
  }, [fetchJson, id, loadMatches, loadPools, loadStandings, token]);

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

  const invalidPools = useMemo(
    () => pools.filter((pool) => pool.teamIds.length !== 3),
    [pools]
  );

  const scheduleLookup = useMemo(() => buildPhase1ScheduleLookup(matches), [matches]);

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

      if (
        sourcePoolIndex === targetPoolIndex &&
        sourceTeamIndex === boundedTargetIndex
      ) {
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
        setMessage('Pool assignments saved.');
      } catch (saveError) {
        setPools(previousPools);
        setError(saveError.message || 'Unable to save pool changes');
      } finally {
        setSavingPools(false);
      }
    },
    [dragState, loadPools, moveTeam, persistPoolChanges, pools, savingPools]
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
      setMessage('Phase 1 pools initialized.');
    } catch (initError) {
      setError(initError.message || 'Unable to initialize pools');
    } finally {
      setInitLoading(false);
    }
  }, [fetchJson, id, token]);

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
          message: payload?.message || 'Phase 1 matches already exist.',
        };
      }

      if (!response.ok || !Array.isArray(payload)) {
        throw new Error(payload?.message || 'Unable to generate Phase 1 matches');
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
          `${firstAttempt.message}\n\nThis will delete and regenerate all Phase 1 matches and scoreboards. Continue?`
        );

        if (!shouldForce) {
          setMessage(firstAttempt.message);
          return;
        }

        const forcedAttempt = await generatePhase1(true);
        setMatches(forcedAttempt.matches);
        setMessage('Phase 1 matches regenerated.');
        return;
      }

      setMatches(firstAttempt.matches);
      setMessage('Phase 1 matches generated.');
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

  const canGenerate = pools.length === 5 && invalidPools.length === 0 && !savingPools;

  if (initializing || loading) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <p className="subtle">Loading Phase 1 setup...</p>
        </section>
      </main>
    );
  }

  if (!user || !token) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <h1 className="title">Phase 1 Setup</h1>
          <p className="subtle">Sign in to manage tournament pools and generate Phase 1 matches.</p>
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
            <h1 className="title">Phase 1 Setup</h1>
            <p className="subtitle">
              {tournament?.name || 'Tournament'} • Drag teams to adjust pools, then generate the
              fixed Phase 1 schedule.
            </p>
          </div>
          <div className="phase1-admin-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={handleInitializePools}
              disabled={initLoading || savingPools || generateLoading}
            >
              {initLoading ? 'Initializing...' : 'Initialize Phase 1 Pools'}
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={handleGenerateMatches}
              disabled={!canGenerate || generateLoading}
            >
              {generateLoading ? 'Generating...' : 'Generate Phase 1 Matches'}
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
          {pools.map((pool) => (
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
          ))}
        </div>

        {matches.length > 0 && (
          <section className="phase1-schedule">
            <h2 className="secondary-title">Phase 1 Schedule</h2>
            <div className="phase1-table-wrap">
              <table className="phase1-schedule-table">
                <thead>
                  <tr>
                    <th>Round</th>
                    {PHASE1_COURT_ORDER.map((court) => (
                      <th key={court}>{court}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PHASE1_ROUND_BLOCKS.map((roundBlock) => (
                    <tr key={roundBlock}>
                      <th>Round {roundBlock}</th>
                      {PHASE1_COURT_ORDER.map((court) => {
                        const match = scheduleLookup[`${roundBlock}-${court}`];
                        const scoreboardKey = match?.scoreboardId || match?.scoreboardCode;
                        const refLabel = formatTeamLabel(match?.refTeams?.[0]);

                        return (
                          <td key={`${roundBlock}-${court}`}>
                            {match ? (
                              <div className="phase1-match-cell">
                                <p>
                                  <strong>Pool {match.poolName}</strong>
                                  {`: ${formatTeamLabel(match.teamA)} vs ${formatTeamLabel(match.teamB)}`}
                                </p>
                                <p>Ref: {refLabel}</p>
                                {scoreboardKey ? (
                                  <a
                                    href={`/board/${scoreboardKey}/control`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Open Control Panel
                                  </a>
                                ) : (
                                  <span className="subtle">No control link</span>
                                )}
                                <div className="phase1-match-admin-meta">
                                  <span
                                    className={`phase1-status-badge ${
                                      match.status === 'final'
                                        ? 'phase1-status-badge--final'
                                        : 'phase1-status-badge--scheduled'
                                    }`}
                                  >
                                    {match.status === 'final' ? 'Finalized' : 'Not Finalized'}
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
          <h2 className="secondary-title">Phase 1 Standings</h2>
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

          <article className="phase1-standings-card phase1-standings-card--overall">
            <h3>Overall Seeds</h3>
            <div className="phase1-table-wrap">
              <table className="phase1-standings-table">
                <thead>
                  <tr>
                    <th>Seed</th>
                    <th>Team</th>
                    <th>W-L</th>
                    <th>Set %</th>
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

export default TournamentPhase1Admin;

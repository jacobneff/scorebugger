import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import { API_URL } from '../config/env.js';
import {
  PHASE1_COURT_ORDER,
  PHASE1_ROUND_BLOCKS,
  buildPhase1ScheduleLookup,
  formatTeamLabel,
  sortPhase1Pools,
} from '../utils/phase1.js';

const normalizePools = (pools) =>
  sortPhase1Pools(pools).map((pool) => ({
    ...pool,
    teamIds: Array.isArray(pool.teamIds)
      ? pool.teamIds.map((team) => ({
          _id: String(team._id),
          name: team.name || '',
          shortName: team.shortName || '',
          seed: team.seed ?? null,
        }))
      : [],
  }));

const formatSetPct = (value) => `${(Math.max(0, Number(value) || 0) * 100).toFixed(1)}%`;

const formatPointDiff = (value) => {
  const parsed = Number(value) || 0;
  return parsed > 0 ? `+${parsed}` : `${parsed}`;
};

function TournamentPublicView() {
  const { publicCode } = useParams();
  const [tournament, setTournament] = useState(null);
  const [pools, setPools] = useState([]);
  const [matches, setMatches] = useState([]);
  const [standings, setStandings] = useState({ pools: [], overall: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadPublicData() {
      setLoading(true);
      setError('');

      try {
        const [tournamentResponse, poolResponse, matchResponse, standingsResponse] = await Promise.all([
          fetch(`${API_URL}/api/tournaments/code/${publicCode}`),
          fetch(`${API_URL}/api/tournaments/code/${publicCode}/phase1/pools`),
          fetch(`${API_URL}/api/tournaments/code/${publicCode}/matches?phase=phase1`),
          fetch(`${API_URL}/api/tournaments/code/${publicCode}/standings?phase=phase1`),
        ]);

        const [tournamentPayload, poolPayload, matchPayload, standingsPayload] = await Promise.all([
          tournamentResponse.json().catch(() => null),
          poolResponse.json().catch(() => null),
          matchResponse.json().catch(() => null),
          standingsResponse.json().catch(() => null),
        ]);

        if (!tournamentResponse.ok) {
          throw new Error(tournamentPayload?.message || 'Unable to load tournament');
        }
        if (!poolResponse.ok) {
          throw new Error(poolPayload?.message || 'Unable to load pools');
        }
        if (!matchResponse.ok) {
          throw new Error(matchPayload?.message || 'Unable to load matches');
        }
        if (!standingsResponse.ok) {
          throw new Error(standingsPayload?.message || 'Unable to load standings');
        }

        if (cancelled) {
          return;
        }

        setTournament(tournamentPayload.tournament);
        setPools(normalizePools(poolPayload));
        setMatches(Array.isArray(matchPayload) ? matchPayload : []);
        setStandings({
          pools: Array.isArray(standingsPayload?.pools) ? standingsPayload.pools : [],
          overall: Array.isArray(standingsPayload?.overall) ? standingsPayload.overall : [],
        });
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError.message || 'Unable to load public tournament view');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    if (publicCode) {
      loadPublicData();
    } else {
      setLoading(false);
      setError('Missing tournament code');
    }

    return () => {
      cancelled = true;
    };
  }, [publicCode]);

  const scheduleLookup = useMemo(() => buildPhase1ScheduleLookup(matches), [matches]);

  if (loading) {
    return (
      <main className="container">
        <section className="card phase1-public-card">
          <p className="subtle">Loading tournament schedule...</p>
        </section>
      </main>
    );
  }

  if (error) {
    return (
      <main className="container">
        <section className="card phase1-public-card">
          <h1 className="title">Tournament View</h1>
          <p className="error">{error}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="container">
      <section className="card phase1-public-card">
        <h1 className="title">{tournament?.name || 'Tournament'}</h1>
        <p className="subtitle">
          Phase 1 Pools and Schedule • Code {tournament?.publicCode || publicCode}
        </p>

        <section>
          <h2 className="secondary-title">Pool Rosters</h2>
          <div className="phase1-pool-grid phase1-pool-grid--readonly">
            {pools.map((pool) => (
              <article key={pool._id} className="phase1-pool-column">
                <header className="phase1-pool-header">
                  <h3>Pool {pool.name}</h3>
                  <p>{pool.homeCourt || 'No home court'}</p>
                </header>
                <ul className="phase1-public-team-list">
                  {pool.teamIds.map((team) => (
                    <li key={team._id}>
                      <span>{team.name}</span>
                      <span>Seed #{team.seed ?? 'N/A'}</span>
                    </li>
                  ))}
                  {pool.teamIds.length === 0 && <li className="subtle">No teams assigned</li>}
                </ul>
              </article>
            ))}
          </div>
        </section>

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

                      return (
                        <td key={`${roundBlock}-${court}`}>
                          {match ? (
                            <div className="phase1-match-cell">
                              <p>
                                <strong>Pool {match.poolName}</strong>
                                {`: ${formatTeamLabel(match.teamA)} vs ${formatTeamLabel(match.teamB)}`}
                              </p>
                              <p>Ref: {formatTeamLabel(match.refTeams?.[0])}</p>
                              {scoreboardKey ? (
                                <a
                                  href={`/board/${scoreboardKey}/display`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Open Live Scoreboard
                                </a>
                              ) : (
                                <span className="subtle">No scoreboard link</span>
                              )}
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

        <section className="phase1-standings">
          <h2 className="secondary-title">Phase 1 Standings</h2>
          <p className="subtle">Standings are based on finalized matches only.</p>
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

export default TournamentPublicView;

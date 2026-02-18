import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import { API_URL } from '../config/env.js';
import { useTournamentRealtime } from '../hooks/useTournamentRealtime.js';
import {
  formatRoundBlockStartTime,
  formatSetRecord,
  PHASE1_COURT_ORDER,
  PHASE1_ROUND_BLOCKS,
  buildPhase1ScheduleLookup,
  formatTeamLabel,
  mapCourtLabel,
  sortPhase1Pools,
} from '../utils/phase1.js';

const PLAYOFF_BRACKET_ORDER = ['gold', 'silver', 'bronze'];
const PLAYOFF_BRACKET_LABELS = {
  gold: 'Gold',
  silver: 'Silver',
  bronze: 'Bronze',
};

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

const normalizePlayoffPayload = (payload) => ({
  matches: Array.isArray(payload?.matches) ? payload.matches : [],
  brackets: payload?.brackets && typeof payload.brackets === 'object' ? payload.brackets : {},
  opsSchedule: Array.isArray(payload?.opsSchedule) ? payload.opsSchedule : [],
});

const formatPointDiff = (value) => {
  const parsed = Number(value) || 0;
  return parsed > 0 ? `+${parsed}` : `${parsed}`;
};

const formatTeamName = (team) => team?.shortName || team?.name || 'TBD';
const formatLiveSummary = (summary) => {
  if (!summary) {
    return '';
  }

  return `Live: Sets ${summary.sets?.a ?? 0}-${summary.sets?.b ?? 0} • Pts ${summary.points?.a ?? 0}-${summary.points?.b ?? 0}`;
};

const getCourtMatchStatusMeta = (status) => {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';

  if (normalized === 'live') {
    return {
      label: 'LIVE',
      className: 'court-schedule-status court-schedule-status--live',
    };
  }

  if (normalized === 'final') {
    return {
      label: 'FINAL',
      className: 'court-schedule-status court-schedule-status--final',
    };
  }

  return {
    label: 'Scheduled',
    className: 'court-schedule-status court-schedule-status--scheduled',
  };
};

const formatCourtScoreSummary = (score) => {
  if (!score) {
    return '';
  }

  return `Sets ${score.setsA ?? 0}-${score.setsB ?? 0} • Pts ${score.pointsA ?? 0}-${score.pointsB ?? 0}`;
};

function TournamentPublicView() {
  const { publicCode } = useParams();
  const [tournament, setTournament] = useState(null);
  const [pools, setPools] = useState([]);
  const [matches, setMatches] = useState([]);
  const [playoffs, setPlayoffs] = useState({
    matches: [],
    brackets: {},
    opsSchedule: [],
  });
  const [courts, setCourts] = useState([]);
  const [selectedCourtCode, setSelectedCourtCode] = useState('');
  const [selectedCourt, setSelectedCourt] = useState(null);
  const [courtScheduleMatches, setCourtScheduleMatches] = useState([]);
  const [standingsByPhase, setStandingsByPhase] = useState({
    phase1: { pools: [], overall: [] },
    phase2: { pools: [], overall: [] },
    cumulative: { pools: [], overall: [] },
  });
  const [activeStandingsTab, setActiveStandingsTab] = useState('phase1');
  const [activeViewTab, setActiveViewTab] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [courtScheduleLoading, setCourtScheduleLoading] = useState(false);
  const [error, setError] = useState('');
  const [liveSummariesByMatchId, setLiveSummariesByMatchId] = useState({});

  const loadPublicData = useCallback(
    async ({ silent = false } = {}) => {
      if (!publicCode) {
        return;
      }

      if (!silent) {
        setLoading(true);
      }
      setError('');

      try {
        const [
          tournamentResponse,
          poolResponse,
          matchResponse,
          courtsResponse,
          phase1StandingsResponse,
          phase2StandingsResponse,
          cumulativeStandingsResponse,
          playoffsResponse,
        ] = await Promise.all([
          fetch(`${API_URL}/api/tournaments/code/${publicCode}`),
          fetch(`${API_URL}/api/tournaments/code/${publicCode}/phase1/pools`),
          fetch(`${API_URL}/api/tournaments/code/${publicCode}/matches?phase=phase1`),
          fetch(`${API_URL}/api/tournaments/code/${publicCode}/courts`),
          fetch(`${API_URL}/api/tournaments/code/${publicCode}/standings?phase=phase1`),
          fetch(`${API_URL}/api/tournaments/code/${publicCode}/standings?phase=phase2`),
          fetch(`${API_URL}/api/tournaments/code/${publicCode}/standings?phase=cumulative`),
          fetch(`${API_URL}/api/tournaments/code/${publicCode}/playoffs`),
        ]);

        const [
          tournamentPayload,
          poolPayload,
          matchPayload,
          courtsPayload,
          phase1StandingsPayload,
          phase2StandingsPayload,
          cumulativeStandingsPayload,
          playoffsPayload,
        ] = await Promise.all([
          tournamentResponse.json().catch(() => null),
          poolResponse.json().catch(() => null),
          matchResponse.json().catch(() => null),
          courtsResponse.json().catch(() => null),
          phase1StandingsResponse.json().catch(() => null),
          phase2StandingsResponse.json().catch(() => null),
          cumulativeStandingsResponse.json().catch(() => null),
          playoffsResponse.json().catch(() => null),
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
        if (!courtsResponse.ok) {
          throw new Error(courtsPayload?.message || 'Unable to load courts');
        }
        if (!phase1StandingsResponse.ok) {
          throw new Error(phase1StandingsPayload?.message || 'Unable to load Pool Play 1 standings');
        }
        if (!phase2StandingsResponse.ok) {
          throw new Error(phase2StandingsPayload?.message || 'Unable to load Pool Play 2 standings');
        }
        if (!cumulativeStandingsResponse.ok) {
          throw new Error(cumulativeStandingsPayload?.message || 'Unable to load cumulative standings');
        }
        if (!playoffsResponse.ok) {
          throw new Error(playoffsPayload?.message || 'Unable to load playoffs');
        }

        setTournament(tournamentPayload.tournament);
        setPools(normalizePools(poolPayload));
        setMatches(Array.isArray(matchPayload) ? matchPayload : []);
        const nextCourts = Array.isArray(courtsPayload?.courts) ? courtsPayload.courts : [];
        setCourts(nextCourts);
        setSelectedCourtCode((currentCode) => {
          if (currentCode && nextCourts.some((court) => court.code === currentCode)) {
            return currentCode;
          }

          return nextCourts[0]?.code || '';
        });
        setPlayoffs(normalizePlayoffPayload(playoffsPayload));
        setStandingsByPhase({
          phase1: {
            pools: Array.isArray(phase1StandingsPayload?.pools) ? phase1StandingsPayload.pools : [],
            overall: Array.isArray(phase1StandingsPayload?.overall) ? phase1StandingsPayload.overall : [],
          },
          phase2: {
            pools: Array.isArray(phase2StandingsPayload?.pools) ? phase2StandingsPayload.pools : [],
            overall: Array.isArray(phase2StandingsPayload?.overall) ? phase2StandingsPayload.overall : [],
          },
          cumulative: {
            pools: Array.isArray(cumulativeStandingsPayload?.pools)
              ? cumulativeStandingsPayload.pools
              : [],
            overall: Array.isArray(cumulativeStandingsPayload?.overall)
              ? cumulativeStandingsPayload.overall
              : [],
          },
        });
      } catch (loadError) {
        setError(loadError.message || 'Unable to load public tournament view');
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [publicCode]
  );

  const loadCourtSchedule = useCallback(
    async ({ silent = false } = {}) => {
      if (!publicCode || !selectedCourtCode) {
        return;
      }

      if (!silent) {
        setCourtScheduleLoading(true);
      }

      try {
        const response = await fetch(
          `${API_URL}/api/tournaments/code/${publicCode}/courts/${selectedCourtCode}/schedule`
        );
        const payload = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(payload?.message || 'Unable to load court schedule');
        }

        setSelectedCourt(payload?.court || null);
        setCourtScheduleMatches(Array.isArray(payload?.matches) ? payload.matches : []);
      } catch {
        setCourtScheduleMatches([]);
        if (!silent) {
          setSelectedCourt(null);
        }
      } finally {
        if (!silent) {
          setCourtScheduleLoading(false);
        }
      }
    },
    [publicCode, selectedCourtCode]
  );

  useEffect(() => {
    if (!publicCode) {
      setLoading(false);
      setError('Missing tournament code');
      return;
    }

    setLiveSummariesByMatchId({});
    loadPublicData();
  }, [loadPublicData, publicCode]);

  useEffect(() => {
    if (!selectedCourtCode) {
      setSelectedCourt(null);
      setCourtScheduleMatches([]);
      return;
    }

    loadCourtSchedule();
  }, [loadCourtSchedule, selectedCourtCode]);

  const handleTournamentEvent = useCallback(
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

      loadPublicData({ silent: true });

      if (activeViewTab === 'courts' && selectedCourtCode) {
        loadCourtSchedule({ silent: true });
      }
    },
    [activeViewTab, loadCourtSchedule, loadPublicData, selectedCourtCode]
  );

  useTournamentRealtime({
    tournamentCode: tournament?.publicCode || publicCode,
    onEvent: handleTournamentEvent,
  });

  const scheduleLookup = useMemo(() => buildPhase1ScheduleLookup(matches), [matches]);
  const activeStandings =
    activeStandingsTab === 'phase2'
      ? standingsByPhase.phase2
      : activeStandingsTab === 'cumulative'
        ? standingsByPhase.cumulative
        : standingsByPhase.phase1;

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
        <p className="subtitle">Code {tournament?.publicCode || publicCode}</p>

        <div className="phase1-admin-actions">
          <button
            className={activeViewTab === 'overview' ? 'primary-button' : 'secondary-button'}
            type="button"
            onClick={() => setActiveViewTab('overview')}
          >
            Pools + Standings
          </button>
          <button
            className={activeViewTab === 'playoffs' ? 'primary-button' : 'secondary-button'}
            type="button"
            onClick={() => setActiveViewTab('playoffs')}
          >
            Playoffs
          </button>
          <button
            className={activeViewTab === 'courts' ? 'primary-button' : 'secondary-button'}
            type="button"
            onClick={() => setActiveViewTab('courts')}
          >
            Courts
          </button>
        </div>

        {activeViewTab === 'overview' ? (
          <>
            <section>
              <h2 className="secondary-title">Pool Rosters</h2>
              <div className="phase1-pool-grid phase1-pool-grid--readonly">
                {pools.map((pool) => (
                  <article key={pool._id} className="phase1-pool-column">
                    <header className="phase1-pool-header">
                      <h3>Pool {pool.name}</h3>
                      <p>{pool.homeCourt ? mapCourtLabel(pool.homeCourt) : 'No home court'}</p>
                    </header>
                    <ul className="phase1-public-team-list">
                      {pool.teamIds.map((team) => (
                        <li key={team._id}>
                          <span>{team.name}</span>
                        </li>
                      ))}
                      {pool.teamIds.length === 0 && <li className="subtle">No teams assigned</li>}
                    </ul>
                  </article>
                ))}
              </div>
            </section>

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
                          const liveSummary = match ? liveSummariesByMatchId[match._id] : null;

                          return (
                            <td key={`${roundBlock}-${court}`}>
                              {match ? (
                                <div className="phase1-match-cell">
                                  <p>
                                    <strong>Pool {match.poolName}</strong>
                                    {`: ${formatTeamLabel(match.teamA)} vs ${formatTeamLabel(match.teamB)}`}
                                  </p>
                                  <p>Ref: {formatTeamLabel(match.refTeams?.[0])}</p>
                                  {liveSummary && <p className="subtle">{formatLiveSummary(liveSummary)}</p>}
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
              <h2 className="secondary-title">Standings</h2>
              <p className="subtle">Standings are based on finalized matches only.</p>
              <div className="phase1-admin-actions">
                <button
                  className={activeStandingsTab === 'phase1' ? 'primary-button' : 'secondary-button'}
                  type="button"
                  onClick={() => setActiveStandingsTab('phase1')}
                >
                  Pool Play 1
                </button>
                <button
                  className={activeStandingsTab === 'phase2' ? 'primary-button' : 'secondary-button'}
                  type="button"
                  onClick={() => setActiveStandingsTab('phase2')}
                >
                  Pool Play 2
                </button>
                <button
                  className={activeStandingsTab === 'cumulative' ? 'primary-button' : 'secondary-button'}
                  type="button"
                  onClick={() => setActiveStandingsTab('cumulative')}
                >
                  Cumulative
                </button>
              </div>

              {activeStandingsTab !== 'cumulative' && (
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
                <h3>
                  {activeStandingsTab === 'phase1'
                    ? 'Pool Play 1 Overall'
                    : activeStandingsTab === 'phase2'
                      ? 'Pool Play 2 Overall'
                      : 'Cumulative Overall'}
                </h3>
                <div className="phase1-table-wrap">
                  <table className="phase1-standings-table">
                    <thead>
                      <tr>
                        <th>Seed</th>
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
          </>
        ) : activeViewTab === 'courts' ? (
          <section className="court-schedule-page">
            <div className="court-schedule-selector">
              {courts.map((court) => (
                <button
                  key={court.code}
                  type="button"
                  className={
                    selectedCourtCode === court.code
                      ? 'primary-button court-schedule-court-button'
                      : 'secondary-button court-schedule-court-button'
                  }
                  onClick={() => setSelectedCourtCode(court.code)}
                >
                  {court.label || mapCourtLabel(court.code)}
                </button>
              ))}
            </div>

            {courtScheduleLoading ? (
              <p className="subtle">Loading court schedule...</p>
            ) : (
              <div className="court-schedule-list">
                {courtScheduleMatches.length === 0 ? (
                  <p className="subtle">No matches scheduled for this court yet.</p>
                ) : (
                  courtScheduleMatches.map((match) => {
                    const liveSummary = liveSummariesByMatchId[match.matchId] || null;
                    const statusMeta = getCourtMatchStatusMeta(match.status);
                    const liveScoreSummary = liveSummary
                      ? `Sets ${liveSummary.sets?.a ?? 0}-${liveSummary.sets?.b ?? 0} • Pts ${
                          liveSummary.points?.a ?? 0
                        }-${liveSummary.points?.b ?? 0}`
                      : '';
                    const scoreSummary = liveScoreSummary || formatCourtScoreSummary(match.score);
                    const timeLabel = formatRoundBlockStartTime(match.roundBlock, tournament) || '-';

                    return (
                      <article key={`${match.matchId || 'match'}-${match.roundBlock || 'na'}`} className="court-schedule-row">
                        <div className="court-schedule-time">{timeLabel}</div>
                        <div className="court-schedule-body">
                          <p className="court-schedule-teams">
                            {match.teamA || 'TBD'} vs {match.teamB || 'TBD'}
                          </p>
                          <div className="court-schedule-meta">
                            <span className={statusMeta.className}>{statusMeta.label}</span>
                            <span>{match.phaseLabel || match.phase || ''}</span>
                            {match.poolName ? <span>Pool {match.poolName}</span> : null}
                          </div>
                          <p className="subtle">
                            Ref: {Array.isArray(match.refs) && match.refs.length > 0 ? match.refs.join(', ') : 'TBD'}
                          </p>
                          <p className="subtle">
                            Location: {selectedCourt?.label || mapCourtLabel(selectedCourtCode)}
                          </p>
                          {scoreSummary ? <p className="subtle">{scoreSummary}</p> : null}
                        </div>
                      </article>
                    );
                  })
                )}
              </div>
            )}
          </section>
        ) : (
          <>
            <section className="phase1-schedule">
              <h2 className="secondary-title">Playoff Ops Schedule</h2>
              {playoffs.opsSchedule.length === 0 ? (
                <p className="subtle">Playoffs have not been generated yet.</p>
              ) : (
                playoffs.opsSchedule.map((roundBlock) => (
                  <article key={roundBlock.roundBlock} className="phase1-standings-card">
                    <h3>{`${formatRoundBlockStartTime(roundBlock.roundBlock, tournament)} - ${roundBlock.label}`}</h3>
                    <div className="phase1-table-wrap">
                      <table className="phase1-schedule-table">
                        <thead>
                          <tr>
                            <th>Facility</th>
                            <th>Court</th>
                            <th>Match</th>
                            <th>Teams</th>
                            <th>Ref</th>
                            <th>Status</th>
                            <th>Live</th>
                          </tr>
                        </thead>
                        <tbody>
                          {roundBlock.slots.map((slot) => {
                            const match = playoffs.matches.find((entry) => entry._id === slot.matchId);
                            const scoreboardKey = match?.scoreboardCode || null;
                            const liveSummary = match ? liveSummariesByMatchId[match._id] : null;
                            return (
                              <tr key={`${roundBlock.roundBlock}-${slot.court}`}>
                                <td>{slot.facility}</td>
                                <td>{mapCourtLabel(slot.court)}</td>
                                <td>{slot.matchLabel}</td>
                                <td>{slot.matchId ? `${slot.teams.a} vs ${slot.teams.b}` : 'Empty'}</td>
                                <td>{slot.refs.length > 0 ? slot.refs.join(', ') : 'TBD'}</td>
                                <td>
                                  {slot.status || 'empty'}
                                  {liveSummary && <p className="subtle">{formatLiveSummary(liveSummary)}</p>}
                                </td>
                                <td>
                                  {scoreboardKey ? (
                                    <a href={`/board/${scoreboardKey}/display`} target="_blank" rel="noreferrer">
                                      Open Live Scoreboard
                                    </a>
                                  ) : (
                                    <span className="subtle">-</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </article>
                ))
              )}
            </section>

            {playoffs.matches.length > 0 && (
              <section className="phase1-standings">
                <h2 className="secondary-title">Playoff Brackets</h2>
                <div className="playoff-bracket-grid">
                  {PLAYOFF_BRACKET_ORDER.map((bracket) => {
                    const bracketData = playoffs.brackets?.[bracket];
                    if (!bracketData) {
                      return null;
                    }

                    return (
                      <article key={bracket} className="phase1-standings-card playoff-bracket-card">
                        <h3>{PLAYOFF_BRACKET_LABELS[bracket]}</h3>
                        <div className="playoff-seed-list">
                          {(bracketData.seeds || []).map((entry) => (
                            <p key={`${bracket}-seed-${entry.seed}`}>
                              #{entry.seed} {formatTeamName(entry.team)}
                            </p>
                          ))}
                        </div>
                        {['R1', 'R2', 'R3'].map((roundKey) => (
                          <div key={`${bracket}-${roundKey}`} className="playoff-round-block">
                            <h4>{roundKey === 'R3' ? 'Final' : roundKey}</h4>
                            {(bracketData.rounds?.[roundKey] || []).map((match) => (
                              <div key={match._id} className="playoff-round-match">
                                <p>
                                  {match.teamA ? formatTeamLabel(match.teamA) : 'TBD'} vs{' '}
                                  {match.teamB ? formatTeamLabel(match.teamB) : 'TBD'}
                                </p>
                                <p className="subtle">
                                  {mapCourtLabel(match.court)} • {match.status === 'final' ? 'Final' : 'Scheduled'}
                                </p>
                                {liveSummariesByMatchId[match._id] && (
                                  <p className="subtle">
                                    {formatLiveSummary(liveSummariesByMatchId[match._id])}
                                  </p>
                                )}
                                {match.result && (
                                  <p className="subtle">
                                    Sets {match.result.setsWonA}-{match.result.setsWonB} • Pts{' '}
                                    {match.result.pointsForA}-{match.result.pointsForB}
                                  </p>
                                )}
                              </div>
                            ))}
                          </div>
                        ))}
                      </article>
                    );
                  })}
                </div>
              </section>
            )}
          </>
        )}
      </section>
    </main>
  );
}

export default TournamentPublicView;

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

import { API_URL } from '../config/env.js';
import { useTournamentRealtime } from '../hooks/useTournamentRealtime.js';

const REFRESH_EVENT_TYPES = new Set([
  'MATCH_FINALIZED',
  'MATCH_UNFINALIZED',
  'MATCH_STATUS_UPDATED',
  'SCOREBOARD_SUMMARY',
  'PLAYOFFS_BRACKET_UPDATED',
]);

const PHASE_SECTION_ORDER = ['phase1', 'phase2', 'playoffs'];
const ODU_15_FORMAT_ID = 'odu_15_5courts_v1';

const getStatusMeta = (status) => {
  if (status === 'live') {
    return {
      label: 'LIVE',
      className: 'court-schedule-status court-schedule-status--live',
    };
  }

  if (status === 'final') {
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

const formatScoreSummary = (scoreSummary) => {
  if (!scoreSummary) {
    return '';
  }

  return `Sets ${scoreSummary.setsA ?? 0}-${scoreSummary.setsB ?? 0} • Pts ${scoreSummary.pointsA ?? 0}-${scoreSummary.pointsB ?? 0}`;
};

const formatOpponentLabel = (match) => match?.opponent?.shortName || 'TBD';

const formatTeamsPlaying = (match) =>
  `${match?.teamA?.shortName || 'TBD'} vs ${match?.teamB?.shortName || 'TBD'}`;

function TournamentTeamPublicView() {
  const { tournamentCode, teamCode } = useParams();
  const refreshTimerRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tournament, setTournament] = useState(null);
  const [team, setTeam] = useState(null);
  const [nextUp, setNextUp] = useState(null);
  const [matches, setMatches] = useState([]);
  const [refs, setRefs] = useState([]);
  const [byes, setByes] = useState([]);

  const loadTeamData = useCallback(
    async ({ silent = false } = {}) => {
      if (!tournamentCode || !teamCode) {
        setError('Missing team link details');
        setLoading(false);
        return;
      }

      if (!silent) {
        setLoading(true);
      }

      setError('');

      try {
        const response = await fetch(
          `${API_URL}/api/tournaments/code/${encodeURIComponent(tournamentCode)}/team/${encodeURIComponent(
            teamCode
          )}`
        );
        const payload = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(payload?.message || 'Unable to load team page');
        }

        setTournament(payload?.tournament || null);
        setTeam(payload?.team || null);
        setNextUp(payload?.nextUp || null);
        setMatches(Array.isArray(payload?.matches) ? payload.matches : []);
        setRefs(Array.isArray(payload?.refs) ? payload.refs : []);
        setByes(Array.isArray(payload?.byes) ? payload.byes : []);
      } catch (loadError) {
        setError(loadError?.message || 'Unable to load team page');
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [teamCode, tournamentCode]
  );

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
    }

    refreshTimerRef.current = setTimeout(() => {
      loadTeamData({ silent: true });
    }, 150);
  }, [loadTeamData]);

  useEffect(() => {
    loadTeamData();
  }, [loadTeamData]);

  useEffect(
    () => () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    },
    []
  );

  const handleTournamentEvent = useCallback(
    (event) => {
      if (!event || typeof event !== 'object') {
        return;
      }

      if (!REFRESH_EVENT_TYPES.has(event.type)) {
        return;
      }

      scheduleRefresh();
    },
    [scheduleRefresh]
  );

  useTournamentRealtime({
    tournamentCode: tournament?.publicCode || tournamentCode,
    onEvent: handleTournamentEvent,
  });

  const matchesByPhase = useMemo(() => {
    const grouped = {
      phase1: [],
      phase2: [],
      playoffs: [],
    };

    (Array.isArray(matches) ? matches : []).forEach((match) => {
      const phase = typeof match?.phase === 'string' ? match.phase : '';
      if (!grouped[phase]) {
        return;
      }
      grouped[phase].push(match);
    });

    return grouped;
  }, [matches]);

  const byesByPhase = useMemo(() => {
    const grouped = {
      phase1: [],
      phase2: [],
      playoffs: [],
    };

    (Array.isArray(byes) ? byes : []).forEach((bye) => {
      const phase = typeof bye?.phase === 'string' ? bye.phase : '';
      if (!grouped[phase]) {
        return;
      }
      grouped[phase].push(bye);
    });

    return grouped;
  }, [byes]);

  const formatId =
    typeof tournament?.settings?.format?.formatId === 'string'
      ? tournament.settings.format.formatId.trim()
      : '';
  const supportsPhase2 = !formatId || formatId === ODU_15_FORMAT_ID;
  const phaseSectionOrder = useMemo(
    () =>
      PHASE_SECTION_ORDER.filter(
        (phase) => phase !== 'phase2' || supportsPhase2 || (matchesByPhase.phase2 || []).length > 0
      ),
    [matchesByPhase.phase2, supportsPhase2]
  );
  const phaseSectionLabels = useMemo(
    () => ({
      phase1: supportsPhase2 ? 'Pool Play 1' : 'Pool Play',
      phase2: 'Pool Play 2',
      playoffs: 'Playoffs',
    }),
    [supportsPhase2]
  );

  const finalResults = useMemo(
    () => (Array.isArray(matches) ? matches.filter((match) => match?.status === 'final') : []),
    [matches]
  );

  const nextRefAssignment = useMemo(
    () => (Array.isArray(refs) ? refs.find((refMatch) => refMatch?.status !== 'final') || null : null),
    [refs]
  );

  const tournamentPublicCode = tournament?.publicCode || String(tournamentCode || '').trim().toUpperCase();
  const courtScheduleHref =
    nextUp?.courtCode && tournamentPublicCode
      ? `/t/${tournamentPublicCode}?view=courts&court=${encodeURIComponent(nextUp.courtCode)}`
      : `/t/${tournamentPublicCode}`;
  const fullTournamentHref = `/t/${tournamentPublicCode}`;

  if (loading) {
    return (
      <main className="container">
        <section className="card team-public-card">
          <p className="subtle">Loading team schedule...</p>
        </section>
      </main>
    );
  }

  if (error) {
    return (
      <main className="container">
        <section className="card team-public-card">
          <h1 className="title">Team Schedule</h1>
          <p className="error">{error}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="container">
      <section className="card team-public-card">
        <header className="team-public-header">
          <h1 className="title">{tournament?.name || 'Tournament'}</h1>
          <p className="subtitle">Team {team?.shortName || 'TBD'}</p>
        </header>

        <section className="team-public-section">
          <h2 className="secondary-title">Next Up</h2>
          {nextUp ? (
            <article className="team-public-match-row">
              <div className="team-public-time">{nextUp.timeLabel || '-'}</div>
              <div className="team-public-body">
                <p className="team-public-opponent">vs {formatOpponentLabel(nextUp)}</p>
                <div className="court-schedule-meta">
                  <span className={getStatusMeta(nextUp.status).className}>
                    {getStatusMeta(nextUp.status).label}
                  </span>
                  <span>{nextUp.phaseLabel || nextUp.phase || ''}</span>
                  <span>{nextUp.courtLabel || '-'}</span>
                  {nextUp.roundLabel ? <span>{nextUp.roundLabel}</span> : null}
                </div>
                <p className="subtle">
                  {nextUp.facilityLabel || ''} {nextUp.courtLabel ? `• ${nextUp.courtLabel}` : ''}
                </p>
                {formatScoreSummary(nextUp.scoreSummary) ? (
                  <p className="subtle">{formatScoreSummary(nextUp.scoreSummary)}</p>
                ) : null}
                {nextRefAssignment ? (
                  <p className="subtle">
                    Next ref: {nextRefAssignment.timeLabel || '-'} • {nextRefAssignment.courtLabel || 'TBD'}
                  </p>
                ) : null}
              </div>
            </article>
          ) : (
            <p className="subtle">No upcoming matches.</p>
          )}
        </section>

        <section className="team-public-section">
          <h2 className="secondary-title">Quick Links</h2>
          <div className="team-public-quick-links">
            <a className="secondary-button" href={courtScheduleHref}>
              View my court schedule
            </a>
            <a className="secondary-button" href={fullTournamentHref}>
              View full tournament
            </a>
          </div>
        </section>

        <section className="team-public-section">
          <h2 className="secondary-title">My Schedule</h2>
          <div className="team-public-phase-groups">
            {phaseSectionOrder.map((phase) => {
              const phaseMatches = matchesByPhase[phase] || [];
              const phaseByes = byesByPhase[phase] || [];
              const hasContent = phaseMatches.length > 0 || phaseByes.length > 0;
              return (
                <article key={phase} className="team-public-phase-card">
                  <h3>{phaseSectionLabels[phase]}</h3>
                  {!hasContent ? (
                    <p className="subtle">No matches yet.</p>
                  ) : (
                    <div className="team-public-list">
                      {phaseMatches.map((match) => (
                        <article key={`${phase}-${match.matchId}`} className="team-public-match-row">
                          <div className="team-public-time">{match.timeLabel || '-'}</div>
                          <div className="team-public-body">
                            <p className="team-public-opponent">vs {formatOpponentLabel(match)}</p>
                            <div className="court-schedule-meta">
                              <span className={getStatusMeta(match.status).className}>
                                {getStatusMeta(match.status).label}
                              </span>
                              <span>{match.courtLabel || '-'}</span>
                              <span>{match.facilityLabel || ''}</span>
                              {match.roundLabel ? <span>{match.roundLabel}</span> : null}
                            </div>
                            {formatScoreSummary(match.scoreSummary) ? (
                              <p className="subtle">{formatScoreSummary(match.scoreSummary)}</p>
                            ) : null}
                            {Array.isArray(match.refBy) && match.refBy.length > 0 ? (
                              <p className="subtle">
                                Ref: {match.refBy.map((refTeam) => refTeam.shortName).join(', ')}
                              </p>
                            ) : null}
                          </div>
                        </article>
                      ))}
                      {phaseByes.map((bye) => (
                        <article key={`${phase}-bye-${bye.matchId}`} className="team-public-match-row team-public-match-row--bye">
                          <div className="team-public-time">{bye.timeLabel || '-'}</div>
                          <div className="team-public-body">
                            <p className="team-public-opponent">
                              BYE{bye.poolName ? ` — Pool ${bye.poolName}` : ''}
                            </p>
                            <div className="court-schedule-meta">
                              <span className="court-schedule-status court-schedule-status--scheduled">BYE</span>
                              <span>{bye.courtLabel || '-'}</span>
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        <section className="team-public-section">
          <h2 className="secondary-title">My Ref Assignments</h2>
          {refs.length === 0 ? (
            <p className="subtle">No ref assignments yet.</p>
          ) : (
            <div className="team-public-list">
              {refs.map((match) => (
                <article key={`ref-${match.matchId}`} className="team-public-match-row">
                  <div className="team-public-time">{match.timeLabel || '-'}</div>
                  <div className="team-public-body">
                    <p className="team-public-opponent">{formatTeamsPlaying(match)}</p>
                    <div className="court-schedule-meta">
                      <span className={getStatusMeta(match.status).className}>
                        {getStatusMeta(match.status).label}
                      </span>
                      <span>{match.phaseLabel || match.phase || ''}</span>
                      <span>{match.courtLabel || '-'}</span>
                    </div>
                    {formatScoreSummary(match.scoreSummary) ? (
                      <p className="subtle">{formatScoreSummary(match.scoreSummary)}</p>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="team-public-section">
          <h2 className="secondary-title">My Results</h2>
          {finalResults.length === 0 ? (
            <p className="subtle">No finalized matches yet.</p>
          ) : (
            <div className="team-public-list">
              {finalResults.map((match) => (
                <article key={`result-${match.matchId}`} className="team-public-match-row">
                  <div className="team-public-time">{match.timeLabel || '-'}</div>
                  <div className="team-public-body">
                    <p className="team-public-opponent">vs {formatOpponentLabel(match)}</p>
                    <div className="court-schedule-meta">
                      <span className={getStatusMeta(match.status).className}>
                        {getStatusMeta(match.status).label}
                      </span>
                      <span>{match.courtLabel || '-'}</span>
                      <span>{match.phaseLabel || match.phase || ''}</span>
                    </div>
                    {formatScoreSummary(match.scoreSummary) ? (
                      <p className="subtle">{formatScoreSummary(match.scoreSummary)}</p>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

export default TournamentTeamPublicView;

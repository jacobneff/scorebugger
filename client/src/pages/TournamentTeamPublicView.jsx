import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { FiCoffee, FiPauseCircle, FiPlayCircle, FiShield } from 'react-icons/fi';

import { API_URL } from '../config/env.js';
import { useTournamentRealtime } from '../hooks/useTournamentRealtime.js';
import {
  formatSetSummaryWithScores,
  resolveCompletedSetScores,
  toSetSummaryFromScoreSummary,
} from '../utils/matchSetSummary.js';
import { buildTournamentMatchControlHref } from '../utils/tournamentMatchControl.js';

const REFRESH_EVENT_TYPES = new Set([
  'MATCH_FINALIZED',
  'MATCH_UNFINALIZED',
  'MATCH_STATUS_UPDATED',
  'SCOREBOARD_SUMMARY',
  'PLAYOFFS_BRACKET_UPDATED',
  'POOLS_UPDATED',
  'MATCHES_GENERATED',
  'SCHEDULE_PLAN_UPDATED',
]);

const AUTH_STORAGE_KEY = 'scorebugger.auth';
const TIMELINE_ROLE_META = Object.freeze({
  PLAY: {
    label: 'PLAY',
    icon: FiPlayCircle,
    className: 'team-timeline-role--play',
  },
  REF: {
    label: 'REF',
    icon: FiShield,
    className: 'team-timeline-role--ref',
  },
  BYE: {
    label: 'BYE',
    icon: FiPauseCircle,
    className: 'team-timeline-role--bye',
  },
  LUNCH: {
    label: 'LUNCH',
    icon: FiCoffee,
    className: 'team-timeline-role--lunch',
  },
});

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

  if (status === 'ended') {
    return {
      label: 'ENDED',
      className: 'court-schedule-status court-schedule-status--ended',
    };
  }

  return {
    label: 'Scheduled',
    className: 'court-schedule-status court-schedule-status--scheduled',
  };
};

const formatScoreSummary = (match) =>
  formatSetSummaryWithScores(
    toSetSummaryFromScoreSummary(match?.scoreSummary),
    resolveCompletedSetScores(match)
  );

const formatOpponentLabel = (match) => match?.opponent?.shortName || 'TBD';

const formatTeamsPlaying = (match) =>
  `${match?.teamA?.shortName || 'TBD'} vs ${match?.teamB?.shortName || 'TBD'}`;

const readStoredAuthToken = () => {
  if (typeof window === 'undefined') {
    return '';
  }

  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) {
      return '';
    }

    const parsed = JSON.parse(raw);
    return typeof parsed?.token === 'string' ? parsed.token.trim() : '';
  } catch {
    return '';
  }
};

const sortTimelineRows = (rows) =>
  [...(Array.isArray(rows) ? rows : [])].sort((left, right) => {
    const leftTime = Number.isFinite(Number(left?.timeIndex))
      ? Number(left.timeIndex)
      : Number.isFinite(Number(left?.roundBlock))
        ? Number(left.roundBlock) * 100
        : Number.MAX_SAFE_INTEGER;
    const rightTime = Number.isFinite(Number(right?.timeIndex))
      ? Number(right.timeIndex)
      : Number.isFinite(Number(right?.roundBlock))
        ? Number(right.roundBlock) * 100
        : Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    const leftRound = Number.isFinite(Number(left?.roundBlock))
      ? Number(left.roundBlock)
      : Number.MAX_SAFE_INTEGER;
    const rightRound = Number.isFinite(Number(right?.roundBlock))
      ? Number(right.roundBlock)
      : Number.MAX_SAFE_INTEGER;
    if (leftRound !== rightRound) {
      return leftRound - rightRound;
    }

    const leftId = String(left?.timelineId || left?.matchId || '');
    const rightId = String(right?.timelineId || right?.matchId || '');
    return leftId.localeCompare(rightId);
  });

const buildLegacyTimeline = ({ matches, refs, byes }) => {
  const playRows = (Array.isArray(matches) ? matches : []).map((match, index) => ({
    timelineId: `legacy-play-${match?.matchId || index}`,
    role: 'PLAY',
    roleLabel: 'PLAY',
    iconKey: 'play',
    summaryLabel: `vs ${formatOpponentLabel(match)}`,
    ...match,
    matchupLabel: `${match?.teamA?.shortName || 'TBD'} vs ${match?.teamB?.shortName || 'TBD'}`,
    setSummary: match?.setSummary || null,
  }));
  const refRows = (Array.isArray(refs) ? refs : []).map((match, index) => ({
    timelineId: `legacy-ref-${match?.matchId || index}`,
    role: 'REF',
    roleLabel: 'REF',
    iconKey: 'ref',
    summaryLabel: formatTeamsPlaying(match),
    ...match,
    matchupLabel: `${match?.teamA?.shortName || 'TBD'} vs ${match?.teamB?.shortName || 'TBD'}`,
    setSummary: match?.setSummary || null,
  }));
  const byeRows = (Array.isArray(byes) ? byes : []).map((bye, index) => ({
    timelineId: `legacy-bye-${bye?.matchId || index}`,
    role: 'BYE',
    roleLabel: 'BYE',
    iconKey: 'bye',
    summaryLabel: bye?.poolName ? `BYE (Pool ${bye.poolName})` : 'BYE',
    ...bye,
  }));

  return sortTimelineRows([...playRows, ...refRows, ...byeRows]);
};

function TournamentTeamPublicView() {
  const { tournamentCode, teamCode } = useParams();
  const refreshTimerRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tournament, setTournament] = useState(null);
  const [team, setTeam] = useState(null);
  const [nextUp, setNextUp] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [canManageMatches, setCanManageMatches] = useState(false);

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
        const nextMatches = Array.isArray(payload?.matches) ? payload.matches : [];
        const nextRefs = Array.isArray(payload?.refs) ? payload.refs : [];
        const nextByes = Array.isArray(payload?.byes) ? payload.byes : [];
        const nextTimeline = Array.isArray(payload?.timeline)
          ? payload.timeline
          : buildLegacyTimeline({
              matches: nextMatches,
              refs: nextRefs,
              byes: nextByes,
            });
        setTimeline(sortTimelineRows(nextTimeline));
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

  useEffect(() => {
    const tournamentId = typeof tournament?.id === 'string' ? tournament.id.trim() : '';
    const token = readStoredAuthToken();

    if (!tournamentId || !token) {
      setCanManageMatches(false);
      return undefined;
    }

    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(`${API_URL}/api/tournaments/${encodeURIComponent(tournamentId)}`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        if (!cancelled) {
          setCanManageMatches(response.ok);
        }
      } catch {
        if (!cancelled) {
          setCanManageMatches(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tournament?.id]);

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

  const timelineRows = useMemo(
    () =>
      sortTimelineRows(timeline).filter((entry) =>
        ['PLAY', 'REF', 'BYE', 'LUNCH'].includes(String(entry?.role || '').toUpperCase())
      ),
    [timeline]
  );

  const nextRefAssignment = useMemo(
    () =>
      timelineRows.find(
        (entry) =>
          String(entry?.role || '').toUpperCase() === 'REF'
          && !['ended', 'final'].includes(String(entry?.status || '').toLowerCase())
      ) || null,
    [timelineRows]
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
                {formatScoreSummary(nextUp) ? (
                  <p className="subtle">{formatScoreSummary(nextUp)}</p>
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
          <h2 className="secondary-title">Timeline</h2>
          {timelineRows.length === 0 ? (
            <p className="subtle">No schedule rows yet.</p>
          ) : (
            <div className="team-public-list team-public-timeline-list">
              {timelineRows.map((entry) => {
                const role = String(entry?.role || '').toUpperCase();
                const roleMeta = TIMELINE_ROLE_META[role] || TIMELINE_ROLE_META.PLAY;
                const RoleIcon = roleMeta.icon;
                const statusMeta = getStatusMeta(String(entry?.status || '').toLowerCase());
                const isLunch = role === 'LUNCH';
                const summaryLabel =
                  entry?.summaryLabel
                  || (role === 'PLAY'
                    ? `vs ${formatOpponentLabel(entry)}`
                    : role === 'REF'
                      ? formatTeamsPlaying(entry)
                      : role === 'BYE'
                        ? 'BYE'
                        : `Lunch Break (${Number(entry?.lunchDurationMinutes) > 0 ? Number(entry.lunchDurationMinutes) : 45} min)`);
                const setSummarySource = entry?.setSummary || entry?.scoreSummary || null;
                const setSummaryScores = Array.isArray(entry?.setSummary?.setScores)
                  ? entry.setSummary.setScores
                  : resolveCompletedSetScores(entry);
                const setSummaryText = setSummarySource
                  ? formatSetSummaryWithScores(
                      toSetSummaryFromScoreSummary(setSummarySource),
                      setSummaryScores
                    )
                  : '';
                const hasMatchupReference =
                  typeof entry?.matchupReferenceLabel === 'string'
                  && entry.matchupReferenceLabel
                  && entry.matchupReferenceLabel !== entry?.matchupLabel;
                const hasRefReference =
                  typeof entry?.refReferenceLabel === 'string'
                  && entry.refReferenceLabel
                  && entry.refReferenceLabel !== entry?.refLabel;
                const matchDetailsHref = entry?.scoreboardCode
                  ? `/board/${encodeURIComponent(entry.scoreboardCode)}/display`
                  : '';
                const matchControlHref = canManageMatches
                  ? buildTournamentMatchControlHref({
                      matchId: entry?.matchId,
                      scoreboardKey: entry?.scoreboardCode,
                      status: entry?.status,
                      startedAt: entry?.startedAt,
                      endedAt: entry?.endedAt,
                    })
                  : '';
                const showRefAction = role === 'REF' && Boolean(entry?.matchId) && Boolean(matchDetailsHref);
                const refActionHref = canManageMatches && matchControlHref
                  ? matchControlHref
                  : matchDetailsHref;
                const refActionLabel = canManageMatches && matchControlHref
                  ? 'Open Match Control'
                  : 'Match details';

                return (
                  <article
                    key={entry?.timelineId || `${role}-${entry?.matchId || entry?.slotId || 'row'}`}
                    className={`team-public-match-row team-timeline-row ${roleMeta.className}`}
                  >
                    <div className="team-public-time">{entry?.timeLabel || '-'}</div>
                    <div className="team-public-body">
                      <div className={`team-timeline-role-badge ${roleMeta.className}`}>
                        <span className="team-timeline-role-icon" aria-hidden>
                          <RoleIcon />
                        </span>
                        <span>{roleMeta.label}</span>
                      </div>
                      <p className="team-public-opponent">{summaryLabel}</p>
                      {hasMatchupReference ? (
                        <p className="team-timeline-reference">{entry.matchupReferenceLabel}</p>
                      ) : null}
                      <div className="court-schedule-meta">
                        {!isLunch ? (
                          <span className={statusMeta.className}>{statusMeta.label}</span>
                        ) : (
                          <span className="court-schedule-status court-schedule-status--scheduled">LUNCH</span>
                        )}
                        {entry?.phaseLabel || entry?.stageLabel ? (
                          <span>{entry.phaseLabel || entry.stageLabel}</span>
                        ) : null}
                        {entry?.courtLabel ? <span>{entry.courtLabel}</span> : null}
                        {entry?.roundLabel ? <span>{entry.roundLabel}</span> : null}
                      </div>
                      {entry?.refLabel && role !== 'REF' && role !== 'LUNCH' ? (
                        <p className="subtle">Ref: {entry.refLabel}</p>
                      ) : null}
                      {hasRefReference ? (
                        <p className="team-timeline-reference">{entry.refReferenceLabel}</p>
                      ) : null}
                      {entry?.facilityLabel || entry?.courtLabel ? (
                        <p className="subtle">
                          {entry?.facilityLabel || ''}
                          {entry?.courtLabel ? ` • ${entry.courtLabel}` : ''}
                        </p>
                      ) : null}
                      {setSummaryText ? <p className="subtle">{setSummaryText}</p> : null}
                      {showRefAction && refActionHref ? (
                        <a className="secondary-button team-timeline-action" href={refActionHref}>
                          {refActionLabel}
                        </a>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

export default TournamentTeamPublicView;

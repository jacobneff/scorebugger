import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import { API_URL } from '../config/env.js';
import TournamentSchedulingTabs from '../components/TournamentSchedulingTabs.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useTournamentRealtime } from '../hooks/useTournamentRealtime.js';
import { formatRoundBlockStartTime, mapCourtLabel } from '../utils/phase1.js';
import {
  buildTournamentMatchControlHref,
  getMatchStatusMeta,
} from '../utils/tournamentMatchControl.js';

const PLAYOFF_BRACKET_LABELS = {
  gold: 'Gold',
  silver: 'Silver',
  bronze: 'Bronze',
};
const ODU_15_FORMAT_ID = 'odu_15_5courts_v1';
const PLAYOFF_REF_REFERENCE_LABELS = Object.freeze({
  'gold:R2:1vW45': 'Loser of Gold 2v3',
  'silver:R2:1vW45': 'Loser of Silver 2v3',
  'bronze:R1:2v3': 'Loser of Gold 4v5',
  'bronze:R2:1vW45': 'Loser of Silver 4v5',
  'gold:R3:final': 'Loser of Gold 1 vs W(4/5)',
  'silver:R3:final': 'Loser of Silver 1 vs W(4/5)',
  'bronze:R3:final': 'Closest loser to university from Bronze 2v3 / Bronze 1 vs W(4/5)',
});
const toTitleCase = (value) =>
  String(value || '')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(' ');

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
});

const normalizePlayoffPayload = (payload) => ({
  matches: Array.isArray(payload?.matches) ? payload.matches : [],
  brackets: payload?.brackets && typeof payload.brackets === 'object' ? payload.brackets : {},
  opsSchedule: Array.isArray(payload?.opsSchedule) ? payload.opsSchedule : [],
  bracketOrder: Array.isArray(payload?.bracketOrder) ? payload.bracketOrder : [],
});

const formatRefTeamLabel = (team) => team?.shortName || team?.name || 'TBD';
const PLAYOFF_OVERALL_SEED_OFFSETS = Object.freeze({
  gold: 0,
  silver: 5,
  bronze: 10,
});
const normalizeBracket = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';
const parseRoundRank = (roundKey) => {
  const normalized = String(roundKey || '').trim().toUpperCase();
  const matched = /^R(\d+)$/.exec(normalized);
  if (!matched) {
    return Number.MAX_SAFE_INTEGER;
  }

  return Number(matched[1]);
};
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
const toOverallSeed = (bracket, bracketSeed) => {
  const offset = PLAYOFF_OVERALL_SEED_OFFSETS[normalizeBracket(bracket)];
  const seed = Number(bracketSeed);

  if (!Number.isFinite(offset) || !Number.isFinite(seed)) {
    return null;
  }

  return offset + seed;
};
const formatBracketTeamLabel = (team, overallSeed) => {
  const hasResolvedTeam =
    team &&
    typeof team === 'object' &&
    (typeof team.shortName === 'string' || typeof team.name === 'string');
  const name = formatRefTeamLabel(team);

  if (!hasResolvedTeam || name === 'TBD') {
    return 'TBD';
  }

  return Number.isFinite(Number(overallSeed)) ? `${name} (#${Number(overallSeed)})` : name;
};
const formatBracketMatchSummary = (match, seedByTeamId) => {
  if (!match) {
    return 'TBD vs TBD';
  }

  const teamAId = toIdString(match.teamA?._id || match.teamAId);
  const teamBId = toIdString(match.teamB?._id || match.teamBId);
  const teamASeed = seedByTeamId.get(teamAId) ?? toOverallSeed(match.bracket, match.seedA);
  const teamBSeed = seedByTeamId.get(teamBId) ?? toOverallSeed(match.bracket, match.seedB);

  return `${formatBracketTeamLabel(match.teamA, teamASeed)} vs ${formatBracketTeamLabel(
    match.teamB,
    teamBSeed
  )}`;
};
const formatLiveSummary = (summary) =>
  `Live: Sets ${summary.sets?.a ?? 0}-${summary.sets?.b ?? 0} • Pts ${summary.points?.a ?? 0}-${summary.points?.b ?? 0}`;
const getPlayoffRefReferenceLabel = (match) =>
  PLAYOFF_REF_REFERENCE_LABELS[match?.bracketMatchKey] || '';

function TournamentPlayoffsAdmin() {
  const { id } = useParams();
  const { token, user, initializing } = useAuth();

  const [tournament, setTournament] = useState(null);
  const [teams, setTeams] = useState([]);
  const [playoffs, setPlayoffs] = useState({
    matches: [],
    brackets: {},
    opsSchedule: [],
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [generateLoading, setGenerateLoading] = useState(false);
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
      const [tournamentPayload, teamsPayload, playoffsPayload] = await Promise.all([
        fetchJson(`${API_URL}/api/tournaments/${id}`, {
          headers: authHeaders(token),
        }),
        fetchJson(`${API_URL}/api/tournaments/${id}/teams`, {
          headers: authHeaders(token),
        }),
        loadPlayoffs(),
      ]);

      setTournament(tournamentPayload);
      setTeams(Array.isArray(teamsPayload) ? teamsPayload : []);
      setPlayoffs(playoffsPayload);
    } catch (loadError) {
      setError(loadError.message || 'Unable to load playoff dashboard');
    } finally {
      setLoading(false);
    }
  }, [fetchJson, id, loadPlayoffs, token]);

  const refreshPlayoffs = useCallback(async () => {
    setRefreshing(true);
    try {
      const payload = await loadPlayoffs();
      setPlayoffs(payload);
    } finally {
      setRefreshing(false);
    }
  }, [loadPlayoffs]);

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

      const shouldRefresh =
        event.type === 'PLAYOFFS_BRACKET_UPDATED' ||
        (event.type === 'MATCHES_GENERATED' && event.data?.phase === 'playoffs') ||
        ['MATCH_STATUS_UPDATED', 'MATCH_FINALIZED', 'MATCH_UNFINALIZED'].includes(event.type);

      if (shouldRefresh) {
        refreshPlayoffs().catch(() => {});
      }
    },
    [refreshPlayoffs]
  );

  useTournamentRealtime({
    tournamentCode: tournament?.publicCode,
    enabled: Boolean(token && tournament?.publicCode),
    onEvent: handleTournamentRealtimeEvent,
  });

  const formatId =
    typeof tournament?.settings?.format?.formatId === 'string'
      ? tournament.settings.format.formatId.trim()
      : '';
  const isLegacyOduFormat = !formatId || formatId === ODU_15_FORMAT_ID;

  const generatePlayoffs = useCallback(
    async (force = false) => {
      const suffix = force ? '?force=true' : '';
      const endpoint = isLegacyOduFormat
        ? `${API_URL}/api/tournaments/${id}/generate/playoffs${suffix}`
        : `${API_URL}/api/tournaments/${id}/stages/playoffs/matches/generate${suffix}`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: authHeaders(token),
      });
      const payload = await response.json().catch(() => null);

      if (response.status === 409 && !force) {
        return {
          requiresForce: true,
          message: payload?.message || 'Playoffs already generated.',
        };
      }

      if (!response.ok || !payload) {
        const details =
          Array.isArray(payload?.missing) && payload.missing.length > 0
            ? `\n${payload.missing.join('\n')}`
            : '';
        throw new Error(`${payload?.message || 'Unable to generate playoffs'}${details}`);
      }

      if (!isLegacyOduFormat) {
        const refreshedPlayoffs = await loadPlayoffs();
        return {
          requiresForce: false,
          playoffs: normalizePlayoffPayload(refreshedPlayoffs),
        };
      }

      return {
        requiresForce: false,
        playoffs: normalizePlayoffPayload(payload),
      };
    },
    [id, isLegacyOduFormat, loadPlayoffs, token]
  );

  const handleGeneratePlayoffs = useCallback(async () => {
    if (!token || !id || generateLoading) {
      return;
    }

    setGenerateLoading(true);
    setError('');
    setMessage('');

    try {
      const firstAttempt = await generatePlayoffs(false);

      if (firstAttempt.requiresForce) {
        const shouldForce = window.confirm(
          `${firstAttempt.message}\n\nThis will delete and regenerate all playoff matches and scoreboards. Continue?`
        );

        if (!shouldForce) {
          setMessage(firstAttempt.message);
          return;
        }

        const forcedAttempt = await generatePlayoffs(true);
        setPlayoffs(forcedAttempt.playoffs);
        setMessage('Playoffs regenerated.');
        return;
      }

      setPlayoffs(firstAttempt.playoffs);
      setMessage('Playoffs generated.');
    } catch (generateError) {
      setError(generateError.message || 'Unable to generate playoffs');
    } finally {
      setGenerateLoading(false);
    }
  }, [generateLoading, generatePlayoffs, id, token]);

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
        await refreshPlayoffs();
        setMessage('Playoff match finalized.');
      } catch (finalizeError) {
        setError(finalizeError.message || 'Unable to finalize playoff match');
      } finally {
        setMatchActionId('');
      }
    },
    [fetchJson, matchActionId, refreshPlayoffs, token]
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
        await refreshPlayoffs();
        setMessage('Playoff match unfinalized.');
      } catch (unfinalizeError) {
        setError(unfinalizeError.message || 'Unable to unfinalize playoff match');
      } finally {
        setMatchActionId('');
      }
    },
    [fetchJson, matchActionId, refreshPlayoffs, token]
  );

  const matchesById = useMemo(
    () => Object.fromEntries(playoffs.matches.map((match) => [match._id, match])),
    [playoffs.matches]
  );

  const teamsById = useMemo(
    () => Object.fromEntries(teams.map((team) => [String(team._id), team])),
    [teams]
  );

  if (initializing || loading) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <p className="subtle">Loading playoffs dashboard...</p>
        </section>
      </main>
    );
  }

  if (!user || !token) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <h1 className="title">Playoffs</h1>
          <p className="subtle">Sign in to manage playoff generation and operations.</p>
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
            <h1 className="title">Playoffs</h1>
            <p className="subtitle">
              {tournament?.name || 'Tournament'} • Generate playoff brackets for the applied format.
            </p>
            <TournamentSchedulingTabs
              tournamentId={id}
              activeTab="playoffs"
              showPhase2={isLegacyOduFormat}
              phase1Label={isLegacyOduFormat ? 'Pool Play 1' : 'Pool Play'}
              phase1Href={isLegacyOduFormat ? `/tournaments/${id}/phase1` : `/tournaments/${id}/format`}
              phase2Href={isLegacyOduFormat ? `/tournaments/${id}/phase2` : `/tournaments/${id}/format`}
            />
          </div>
          <div className="phase1-admin-actions">
            <button
              className="primary-button"
              type="button"
              onClick={handleGeneratePlayoffs}
              disabled={generateLoading}
            >
              {generateLoading ? 'Generating Playoffs...' : 'Generate Playoffs'}
            </button>
          </div>
        </div>

        {refreshing && <p className="subtle">Refreshing playoff data...</p>}
        {error && <p className="error">{error}</p>}
        {message && <p className="subtle phase1-success">{message}</p>}

        {playoffs.opsSchedule.length === 0 ? (
          <p className="subtle">No playoff matches yet. Generate playoffs to build the schedule.</p>
        ) : (
          <section className="phase1-schedule">
            <h2 className="secondary-title">Ops Schedule</h2>
            {playoffs.opsSchedule.map((roundBlock) => (
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
                        <th>Match Control</th>
                        <th>Status</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {roundBlock.slots.map((slot) => {
                        const match = slot.matchId ? matchesById[slot.matchId] : null;
                        const scoreboardKey = match?.scoreboardCode || match?.scoreboardId || null;
                        const controlPanelHref = buildTournamentMatchControlHref({
                          matchId: match?._id,
                          scoreboardKey,
                          status: match?.status,
                        });
                        const matchStatusMeta = getMatchStatusMeta(match?.status);
                        const refReferenceLabel = getPlayoffRefReferenceLabel(match);
                        const canFinalize = Boolean(match?.teamAId && match?.teamBId);
                        const liveSummary = match ? liveSummariesByMatchId[match._id] : null;

                        return (
                          <tr key={`${roundBlock.roundBlock}-${slot.court}`}>
                            <td>{slot.facility}</td>
                            <td>{mapCourtLabel(slot.court)}</td>
                            <td>{slot.matchLabel}</td>
                            <td>
                              {slot.matchId ? `${slot.teams.a} vs ${slot.teams.b}` : <span className="subtle">-</span>}
                            </td>
                            <td>
                              {!slot.matchId ? (
                                <span className="subtle">-</span>
                              ) : refReferenceLabel ? (
                                <div className="playoff-ref-reference">
                                  <p>{refReferenceLabel}</p>
                                  <p className="subtle">
                                    {slot.refs.length > 0
                                      ? `Assigned: ${slot.refs.join(', ')}`
                                      : 'Awaiting prior result'}
                                  </p>
                                </div>
                              ) : slot.refs.length > 0 ? (
                                slot.refs.join(', ')
                              ) : (
                                'TBD'
                              )}
                            </td>
                            <td>
                              {controlPanelHref ? (
                                <a href={controlPanelHref} target="_blank" rel="noreferrer">
                                  Open Match Control
                                </a>
                              ) : (
                                <span className="subtle">No control link</span>
                              )}
                            </td>
                            <td>
                              {!match ? (
                                <span className="subtle">Empty</span>
                              ) : (
                                <>
                                  <span
                                    className={`phase1-status-badge ${
                                      matchStatusMeta.badgeClassName
                                    }`}
                                  >
                                    {matchStatusMeta.label}
                                  </span>
                                  {liveSummary && <p className="subtle">{formatLiveSummary(liveSummary)}</p>}
                                </>
                              )}
                            </td>
                            <td>
                              {!match ? (
                                <span className="subtle">-</span>
                              ) : match.status === 'final' ? (
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
                                  disabled={Boolean(matchActionId) || !canFinalize}
                                >
                                  {!canFinalize
                                    ? 'Awaiting Teams'
                                    : matchActionId === match._id
                                      ? 'Finalizing...'
                                      : 'Finalize'}
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </article>
            ))}
          </section>
        )}

        {playoffs.matches.length > 0 && (
          <section className="phase1-standings">
            <h2 className="secondary-title">Bracket View</h2>
            <div className="playoff-bracket-grid">
              {(Array.isArray(playoffs.bracketOrder) && playoffs.bracketOrder.length > 0
                ? playoffs.bracketOrder
                : Object.keys(playoffs.brackets || [])
              ).map((bracketKey) => {
                const bracket = normalizeBracket(bracketKey);
                const bracketData = playoffs.brackets?.[bracket];
                if (!bracketData) {
                  return null;
                }

                const roundOrder =
                  Array.isArray(bracketData.roundOrder) && bracketData.roundOrder.length > 0
                    ? bracketData.roundOrder
                    : Object.keys(bracketData.rounds || {}).sort((left, right) => {
                        const byRank = parseRoundRank(left) - parseRoundRank(right);
                        if (byRank !== 0) {
                          return byRank;
                        }
                        return left.localeCompare(right);
                      });

                return (
                  <article key={bracket} className="phase1-standings-card playoff-bracket-card">
                    <h3>{bracketData.label || PLAYOFF_BRACKET_LABELS[bracket] || toTitleCase(bracket)}</h3>
                    <div className="playoff-seed-list">
                      {Array.isArray(bracketData.seeds) && bracketData.seeds.length > 0 ? (
                        bracketData.seeds.map((seedEntry) => (
                          <p key={`${bracket}-seed-${seedEntry.seed || seedEntry.bracketSeed}`}>
                            #
                            {Number.isFinite(Number(seedEntry?.overallSeed))
                              ? Number(seedEntry.overallSeed)
                              : seedEntry.seed || seedEntry.bracketSeed}
                            {' '}
                            {formatRefTeamLabel(teamsById[seedEntry.teamId] || seedEntry.team)}
                          </p>
                        ))
                      ) : (
                        <p className="subtle">Seeds not resolved</p>
                      )}
                    </div>
                    {(() => {
                      const seedByTeamId = new Map(
                        (bracketData?.seeds || [])
                          .map((entry) => {
                            const teamId = toIdString(entry?.teamId);
                            if (!teamId) {
                              return null;
                            }
                            return [
                              teamId,
                              Number.isFinite(Number(entry?.overallSeed))
                                ? Number(entry.overallSeed)
                                : Number.isFinite(Number(entry?.seed))
                                  ? Number(entry.seed)
                                  : null,
                            ];
                          })
                          .filter(Boolean)
                      );

                      return roundOrder.map((roundKey) => (
                        <div key={`${bracket}-${roundKey}`} className="playoff-round-block">
                          <h4>{roundKey === 'R3' ? 'Final' : roundKey}</h4>
                          {(bracketData.rounds?.[roundKey] || []).map((match) => {
                            const bracketStatusMeta = getMatchStatusMeta(match?.status);

                            return (
                              <div key={match._id} className="playoff-round-match">
                                <p>{formatBracketMatchSummary(match, seedByTeamId)}</p>
                                <p className="subtle">
                                  {mapCourtLabel(match.court)} • {bracketStatusMeta.label}
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
                            );
                          })}
                        </div>
                      ));
                    })()}
                  </article>
                );
              })}
            </div>
          </section>
        )}
      </section>
    </main>
  );
}

export default TournamentPlayoffsAdmin;

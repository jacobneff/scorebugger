import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

import { API_URL } from '../config/env.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useTournamentRealtime } from '../hooks/useTournamentRealtime.js';
import {
  formatSetScoreLine,
  hasDecisiveWinner,
  normalizeSetScoresInput,
  toSetScoreChips,
} from '../utils/setScoreInput.js';

const PHASE_OPTIONS = [
  { value: 'phase1', label: 'Pool Play 1' },
  { value: 'phase2', label: 'Pool Play 2' },
  { value: 'playoffs', label: 'Playoffs' },
];

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
});

const jsonHeaders = (token) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
});

function normalizeMatches(payload) {
  return Array.isArray(payload?.matches) ? payload.matches : [];
}

function normalizeFilters(payload) {
  return {
    roundBlocks: Array.isArray(payload?.filters?.roundBlocks)
      ? payload.filters.roundBlocks
      : [],
    courts: Array.isArray(payload?.filters?.courts) ? payload.filters.courts : [],
  };
}

function statusLabel(status) {
  if (status === 'final') {
    return 'FINAL';
  }

  if (status === 'live') {
    return 'LIVE';
  }

  return 'SCHEDULED';
}

function statusBadgeClassName(status) {
  if (status === 'final') {
    return 'phase1-status-badge--final';
  }

  if (status === 'live') {
    return 'phase1-status-badge--live';
  }

  return 'phase1-status-badge--scheduled';
}

function formatScoreSummary(summary) {
  if (!summary) {
    return 'Sets 0-0';
  }

  return `Sets ${summary.setsA ?? 0}-${summary.setsB ?? 0} • Pts ${summary.pointsA ?? 0}-${summary.pointsB ?? 0}`;
}

function TournamentQuickScoresAdmin() {
  const { id } = useParams();
  const { token, user, initializing } = useAuth();

  const [tournament, setTournament] = useState(null);
  const [phase, setPhase] = useState('phase1');
  const [roundBlockFilter, setRoundBlockFilter] = useState('');
  const [courtFilter, setCourtFilter] = useState('');
  const [filters, setFilters] = useState({ roundBlocks: [], courts: [] });
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [rowErrors, setRowErrors] = useState({});
  const [rowBusy, setRowBusy] = useState({});
  const [inputByMatchId, setInputByMatchId] = useState({});
  const [parsedByMatchId, setParsedByMatchId] = useState({});
  const [toasts, setToasts] = useState([]);

  const inputRefs = useRef({});
  const toastCounterRef = useRef(0);

  const fetchJson = useCallback(async (url, options = {}) => {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(payload?.message || 'Request failed');
    }

    return payload;
  }, []);

  const showToast = useCallback((type, message) => {
    toastCounterRef.current += 1;
    const toastId = `quick-score-toast-${toastCounterRef.current}`;

    setToasts((previous) => [...previous, { id: toastId, type, message }]);

    window.setTimeout(() => {
      setToasts((previous) => previous.filter((toast) => toast.id !== toastId));
    }, 2500);
  }, []);

  const loadTournament = useCallback(async () => {
    const payload = await fetchJson(`${API_URL}/api/tournaments/${id}`, {
      headers: authHeaders(token),
    });

    setTournament(payload);
  }, [fetchJson, id, token]);

  const loadQuickMatches = useCallback(
    async ({ phaseValue = phase, roundBlockValue = roundBlockFilter, courtValue = courtFilter } = {}) => {
      const query = new URLSearchParams({ phase: phaseValue });

      if (roundBlockValue) {
        query.set('roundBlock', roundBlockValue);
      }

      if (courtValue) {
        query.set('court', courtValue);
      }

      const payload = await fetchJson(
        `${API_URL}/api/admin/tournaments/${id}/matches/quick?${query.toString()}`,
        {
          headers: authHeaders(token),
        }
      );

      setFilters(normalizeFilters(payload));
      setMatches(normalizeMatches(payload));
    },
    [courtFilter, fetchJson, id, phase, roundBlockFilter, token]
  );

  const refreshQuickMatches = useCallback(async () => {
    setRefreshing(true);

    try {
      await loadQuickMatches();
    } finally {
      setRefreshing(false);
    }
  }, [loadQuickMatches]);

  useEffect(() => {
    if (initializing) {
      return;
    }

    if (!token || !id) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    const run = async () => {
      setLoading(true);
      setError('');

      try {
        await Promise.all([loadTournament(), loadQuickMatches({ phaseValue: 'phase1', roundBlockValue: '', courtValue: '' })]);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError?.message || 'Unable to load quick score tools');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [id, initializing, loadQuickMatches, loadTournament, token]);

  useEffect(() => {
    if (!token || !id || loading) {
      return;
    }

    loadQuickMatches().catch((loadError) => {
      setError(loadError?.message || 'Unable to load quick score matches');
    });
  }, [courtFilter, id, loadQuickMatches, loading, phase, roundBlockFilter, token]);

  useEffect(() => {
    const hasRoundBlock = filters.roundBlocks.some(
      (entry) => String(entry?.value ?? '') === String(roundBlockFilter)
    );

    if (roundBlockFilter && !hasRoundBlock) {
      setRoundBlockFilter('');
    }

    const hasCourt = filters.courts.some(
      (entry) => String(entry?.code ?? '') === String(courtFilter)
    );

    if (courtFilter && !hasCourt) {
      setCourtFilter('');
    }
  }, [courtFilter, filters.courts, filters.roundBlocks, roundBlockFilter]);

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

        setMatches((previous) =>
          previous.map((match) => {
            if (match.matchId !== matchId) {
              return match;
            }

            return {
              ...match,
              scoreSummary: {
                setsA: event.data?.sets?.a ?? 0,
                setsB: event.data?.sets?.b ?? 0,
                pointsA: event.data?.points?.a ?? 0,
                pointsB: event.data?.points?.b ?? 0,
              },
            };
          })
        );

        return;
      }

      if (['MATCH_STATUS_UPDATED', 'MATCH_FINALIZED', 'MATCH_UNFINALIZED'].includes(event.type)) {
        refreshQuickMatches().catch(() => {});
      }
    },
    [refreshQuickMatches]
  );

  useTournamentRealtime({
    tournamentCode: tournament?.publicCode,
    enabled: Boolean(token && tournament?.publicCode),
    onEvent: handleTournamentRealtimeEvent,
  });

  const phaseLabel = useMemo(
    () => PHASE_OPTIONS.find((option) => option.value === phase)?.label || 'Pool Play 1',
    [phase]
  );

  const getNextEditableMatchId = useCallback(
    (currentMatchId) => {
      const currentIndex = matches.findIndex((match) => match.matchId === currentMatchId);

      if (currentIndex < 0) {
        return '';
      }

      for (let index = currentIndex + 1; index < matches.length; index += 1) {
        const nextMatch = matches[index];

        if (nextMatch?.status !== 'final' && nextMatch?.matchId) {
          return nextMatch.matchId;
        }
      }

      return '';
    },
    [matches]
  );

  const focusMatchInput = useCallback((matchId) => {
    if (!matchId) {
      return;
    }

    window.requestAnimationFrame(() => {
      const input = inputRefs.current[matchId];
      if (input) {
        input.focus();
        input.select();
      }
    });
  }, []);

  const parseInputValue = useCallback(
    (matchId, rawValue) => {
      const trimmed = typeof rawValue === 'string' ? rawValue.trim() : '';

      if (!trimmed) {
        setParsedByMatchId((previous) => {
          const next = { ...previous };
          delete next[matchId];
          return next;
        });
        setRowErrors((previous) => {
          const next = { ...previous };
          delete next[matchId];
          return next;
        });
        return null;
      }

      try {
        const parsed = normalizeSetScoresInput(trimmed);

        setParsedByMatchId((previous) => ({
          ...previous,
          [matchId]: parsed,
        }));

        setRowErrors((previous) => {
          const next = { ...previous };
          delete next[matchId];
          return next;
        });

        return parsed;
      } catch (parseError) {
        setRowErrors((previous) => ({
          ...previous,
          [matchId]: parseError?.message || 'Invalid set score format',
        }));

        return null;
      }
    },
    []
  );

  const handleSave = useCallback(
    async (match, { finalize }) => {
      const matchId = match?.matchId;

      if (!matchId || rowBusy[matchId]) {
        return;
      }

      const rawValue = inputByMatchId[matchId] || '';
      const parsed = parseInputValue(matchId, rawValue);

      if (!parsed) {
        showToast('error', 'Invalid score format');
        return;
      }

      if (finalize && !hasDecisiveWinner(parsed)) {
        const message = 'Save + Finalize needs a decisive winner (2 sets won).';
        setRowErrors((previous) => ({ ...previous, [matchId]: message }));
        showToast('error', message);
        return;
      }

      const busyKey = finalize ? 'saveFinalize' : 'save';
      const nextFocusableMatchId = getNextEditableMatchId(matchId);

      setRowBusy((previous) => ({
        ...previous,
        [matchId]: busyKey,
      }));
      setError('');

      try {
        await fetchJson(`${API_URL}/api/admin/matches/${matchId}/score`, {
          method: 'POST',
          headers: jsonHeaders(token),
          body: JSON.stringify({
            setScores: parsed,
            applyToScoreboard: true,
            finalize,
          }),
        });

        setInputByMatchId((previous) => ({
          ...previous,
          [matchId]: formatSetScoreLine(parsed),
        }));

        setParsedByMatchId((previous) => ({
          ...previous,
          [matchId]: parsed,
        }));

        setRowErrors((previous) => {
          const next = { ...previous };
          delete next[matchId];
          return next;
        });

        await refreshQuickMatches();
        showToast('success', finalize ? 'Saved + Finalized' : 'Saved');
        focusMatchInput(nextFocusableMatchId);
      } catch (saveError) {
        const message = saveError?.message || 'Unable to save score';
        setRowErrors((previous) => ({
          ...previous,
          [matchId]: message,
        }));
        showToast('error', message);
      } finally {
        setRowBusy((previous) => {
          const next = { ...previous };
          delete next[matchId];
          return next;
        });
      }
    },
    [fetchJson, focusMatchInput, getNextEditableMatchId, inputByMatchId, parseInputValue, refreshQuickMatches, rowBusy, showToast, token]
  );

  const handleUnfinalize = useCallback(
    async (matchId) => {
      if (!matchId || rowBusy[matchId]) {
        return;
      }

      setRowBusy((previous) => ({
        ...previous,
        [matchId]: 'unfinalize',
      }));
      setError('');

      try {
        await fetchJson(`${API_URL}/api/matches/${matchId}/unfinalize`, {
          method: 'POST',
          headers: authHeaders(token),
        });

        await refreshQuickMatches();
        showToast('success', 'Match unfinalized');
        focusMatchInput(matchId);
      } catch (actionError) {
        const message = actionError?.message || 'Unable to unfinalize match';
        setRowErrors((previous) => ({
          ...previous,
          [matchId]: message,
        }));
        showToast('error', message);
      } finally {
        setRowBusy((previous) => {
          const next = { ...previous };
          delete next[matchId];
          return next;
        });
      }
    },
    [fetchJson, focusMatchInput, refreshQuickMatches, rowBusy, showToast, token]
  );

  if (initializing || loading) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <p className="subtle">Loading quick score entry...</p>
        </section>
      </main>
    );
  }

  if (!user || !token) {
    return (
      <main className="container">
        <section className="card phase1-admin-card">
          <h1 className="title">Quick Enter Scores</h1>
          <p className="subtle">Sign in to enter scores quickly.</p>
          <a className="primary-button" href="/?mode=signin">
            Sign In
          </a>
        </section>
      </main>
    );
  }

  return (
    <main className="container">
      {toasts.length > 0 && (
        <div className="toast-stack">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast ${toast.type}`}>
              <div className="toast-icon" aria-hidden>
                {toast.type === 'error' ? '!' : toast.type === 'success' ? '✓' : 'i'}
              </div>
              <span className="toast-text">{toast.message}</span>
            </div>
          ))}
        </div>
      )}

      <section className="card quick-scores-card">
        <div className="phase1-admin-header">
          <div>
            <h1 className="title">Quick Enter Scores</h1>
            <p className="subtitle">
              {tournament?.name || 'Tournament'} • {phaseLabel} • bulk score capture
            </p>
          </div>
          <div className="phase1-admin-actions">
            <a className="secondary-button" href={`/tournaments/${id}/phase1`}>
              Pool Play 1
            </a>
            <a className="secondary-button" href={`/tournaments/${id}/phase2`}>
              Pool Play 2
            </a>
            <a className="secondary-button" href={`/tournaments/${id}/playoffs`}>
              Playoffs
            </a>
          </div>
        </div>

        <section className="quick-scores-filters">
          <label className="quick-scores-filter-field">
            <span className="input-label">Phase</span>
            <select
              value={phase}
              onChange={(event) => {
                setPhase(event.target.value);
                setRoundBlockFilter('');
                setCourtFilter('');
              }}
            >
              {PHASE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="quick-scores-filter-field">
            <span className="input-label">Time</span>
            <select
              value={roundBlockFilter}
              onChange={(event) => setRoundBlockFilter(event.target.value)}
            >
              <option value="">All times</option>
              {filters.roundBlocks.map((entry) => (
                <option key={entry.value} value={String(entry.value)}>
                  {entry.timeLabel || `Round ${entry.value}`}
                </option>
              ))}
            </select>
          </label>

          <label className="quick-scores-filter-field">
            <span className="input-label">Court</span>
            <select
              value={courtFilter}
              onChange={(event) => setCourtFilter(event.target.value)}
            >
              <option value="">All courts</option>
              {filters.courts.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
        </section>

        {refreshing && <p className="subtle">Refreshing matches...</p>}
        {error && <p className="error">{error}</p>}

        {matches.length === 0 ? (
          <p className="subtle">No matches for this filter.</p>
        ) : (
          <section className="quick-scores-list">
            {matches.map((match) => {
              const matchId = match.matchId;
              const busyAction = rowBusy[matchId] || '';
              const isFinal = match.status === 'final';
              const hasManualInput = Object.prototype.hasOwnProperty.call(inputByMatchId, matchId);
              const defaultFinalScoreLine =
                isFinal && Array.isArray(match?.setScores)
                  ? formatSetScoreLine(match.setScores)
                  : '';
              const inputValue = hasManualInput
                ? inputByMatchId[matchId]
                : defaultFinalScoreLine;
              const parsedSets =
                parsedByMatchId[matchId] ||
                (isFinal && Array.isArray(match?.setScores) ? match.setScores : null);
              const chips = toSetScoreChips(parsedSets);

              return (
                <article key={matchId} className="quick-scores-row">
                  <div className="quick-scores-row-head">
                    <div>
                      <p className="quick-scores-row-title">
                        <strong>{match.timeLabel || 'TBD time'}</strong> • {match.courtLabel || match.court || 'TBD court'}
                      </p>
                      <p className="quick-scores-row-subtitle">
                        {(match.teamA?.shortName || 'TBD') + ' vs ' + (match.teamB?.shortName || 'TBD')}
                      </p>
                    </div>
                    <div className="quick-scores-row-meta">
                      <span className={`phase1-status-badge ${statusBadgeClassName(match.status)}`}>
                        {statusLabel(match.status)}
                      </span>
                      <span className="subtle">{formatScoreSummary(match.scoreSummary)}</span>
                    </div>
                  </div>

                  <div className="quick-scores-row-actions">
                    <input
                      ref={(node) => {
                        if (node) {
                          inputRefs.current[matchId] = node;
                        }
                      }}
                      className="quick-scores-input"
                      type="text"
                      placeholder={isFinal ? '' : '25-18, 22-25, 15-11'}
                      value={inputValue}
                      onChange={(event) => {
                        const value = event.target.value;
                        setInputByMatchId((previous) => ({
                          ...previous,
                          [matchId]: value,
                        }));
                      }}
                      onBlur={(event) => {
                        parseInputValue(matchId, event.target.value);
                      }}
                      disabled={isFinal || Boolean(busyAction)}
                    />

                    <button
                      type="button"
                      className="primary-button phase1-inline-button"
                      onClick={() => handleSave(match, { finalize: false })}
                      disabled={isFinal || Boolean(busyAction)}
                    >
                      {busyAction === 'save' ? 'Saving...' : 'Save'}
                    </button>

                    <button
                      type="button"
                      className="secondary-button phase1-inline-button"
                      onClick={() => handleSave(match, { finalize: true })}
                      disabled={isFinal || Boolean(busyAction)}
                    >
                      {busyAction === 'saveFinalize' ? 'Finalizing...' : 'Save + Finalize'}
                    </button>

                    {isFinal && (
                      <button
                        type="button"
                        className="secondary-button phase1-inline-button"
                        onClick={() => handleUnfinalize(matchId)}
                        disabled={Boolean(busyAction)}
                      >
                        {busyAction === 'unfinalize' ? 'Unfinalizing...' : 'Unfinalize'}
                      </button>
                    )}
                  </div>

                  {chips.length > 0 && (
                    <div className="quick-scores-chip-row">
                      {chips.map((chip) => (
                        <span key={chip.id} className="quick-scores-chip">
                          {chip.label}
                        </span>
                      ))}
                    </div>
                  )}

                  {rowErrors[matchId] && <p className="error">{rowErrors[matchId]}</p>}
                </article>
              );
            })}
          </section>
        )}
      </section>
    </main>
  );
}

export default TournamentQuickScoresAdmin;

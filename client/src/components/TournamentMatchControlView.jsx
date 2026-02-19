import { useEffect, useMemo, useState } from 'react';

import { API_URL } from '../config/env.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useScoreboard } from '../hooks/useScoreboard.js';
import { formatElapsedTimer } from '../utils/matchTimer.js';
import {
  MATCH_STATUS,
  getMatchStatusMeta,
  normalizeLifecycleTimestamp,
  normalizeMatchStatus,
} from '../utils/tournamentMatchControl.js';

const FALLBACK_TEAMS = [
  {
    name: 'Home',
    score: 0,
  },
  {
    name: 'Away',
    score: 0,
  },
];

function clampScore(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(0, Math.round(parsed));
}

function normalizeSetEntry(set) {
  if (!Array.isArray(set?.scores) || set.scores.length !== 2) {
    return {
      scores: [0, 0],
      createdAt: new Date().toISOString(),
    };
  }

  return {
    scores: [clampScore(set.scores[0]), clampScore(set.scores[1])],
    createdAt:
      set?.createdAt && !Number.isNaN(Date.parse(set.createdAt))
        ? new Date(set.createdAt).toISOString()
        : new Date().toISOString(),
  };
}

function resolveMaxCompletedSets(scoreboard) {
  const rawTargets = scoreboard?.scoring?.setTargets;
  if (!Array.isArray(rawTargets)) {
    return 3;
  }

  const count = Math.floor(Number(rawTargets.length));
  return count > 0 ? count : 3;
}

function TournamentMatchControlView({
  matchId,
  scoreboardId,
  initialStatus = MATCH_STATUS.SCHEDULED,
  initialStartedAt = '',
  initialEndedAt = '',
  onLifecycleChange = null,
}) {
  const { token } = useAuth();
  const { scoreboard, loading, error, clearError, updateScoreboard } = useScoreboard(scoreboardId);

  const [matchStatus, setMatchStatus] = useState(() => normalizeMatchStatus(initialStatus));
  const [matchStartedAt, setMatchStartedAt] = useState(() =>
    normalizeLifecycleTimestamp(initialStartedAt)
  );
  const [matchEndedAt, setMatchEndedAt] = useState(() =>
    normalizeLifecycleTimestamp(initialEndedAt)
  );
  const [elapsedNowMs, setElapsedNowMs] = useState(() => Date.now());
  const [startBusy, setStartBusy] = useState(false);
  const [endBusy, setEndBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionInfo, setActionInfo] = useState('');
  const [manualHome, setManualHome] = useState('0');
  const [manualAway, setManualAway] = useState('0');

  useEffect(() => {
    setMatchStatus(normalizeMatchStatus(initialStatus));
  }, [initialStatus]);

  useEffect(() => {
    setMatchStartedAt(normalizeLifecycleTimestamp(initialStartedAt));
  }, [initialStartedAt]);

  useEffect(() => {
    setMatchEndedAt(normalizeLifecycleTimestamp(initialEndedAt));
  }, [initialEndedAt]);

  useEffect(() => {
    if (!error) {
      return undefined;
    }

    const timeoutId = setTimeout(() => {
      clearError?.();
    }, 3000);

    return () => clearTimeout(timeoutId);
  }, [clearError, error]);

  const teams = useMemo(() => {
    if (!Array.isArray(scoreboard?.teams) || scoreboard.teams.length !== 2) {
      return FALLBACK_TEAMS;
    }

    return scoreboard.teams.map((team, index) => ({
      name: team?.name?.trim() || FALLBACK_TEAMS[index].name,
      score: clampScore(team?.score),
    }));
  }, [scoreboard?.teams]);

  const completedSets = useMemo(
    () => (Array.isArray(scoreboard?.sets) ? scoreboard.sets.map(normalizeSetEntry) : []),
    [scoreboard?.sets]
  );

  const maxCompletedSets = useMemo(() => resolveMaxCompletedSets(scoreboard), [scoreboard]);
  const statusMeta = useMemo(() => getMatchStatusMeta(matchStatus), [matchStatus]);
  const liveTimer = useMemo(() => formatElapsedTimer(matchStartedAt, elapsedNowMs), [elapsedNowMs, matchStartedAt]);

  const isFinalized = matchStatus === MATCH_STATUS.FINAL;
  const isScoringLocked = matchStatus !== MATCH_STATUS.LIVE;
  const canSaveSet = !isFinalized && completedSets.length < maxCompletedSets;

  useEffect(() => {
    if (matchStatus !== MATCH_STATUS.LIVE || !matchStartedAt) {
      return undefined;
    }

    const timerId = window.setInterval(() => {
      setElapsedNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(timerId);
  }, [matchStartedAt, matchStatus]);

  useEffect(() => {
    setElapsedNowMs(Date.now());
  }, [matchStartedAt, matchStatus]);

  useEffect(() => {
    setManualHome(String(clampScore(teams[0]?.score)));
    setManualAway(String(clampScore(teams[1]?.score)));
  }, [teams]);

  const bumpScore = (teamIndex, delta) => {
    if (isFinalized || isScoringLocked) {
      return;
    }

    updateScoreboard((current) => {
      if (!Array.isArray(current?.teams) || current.teams.length !== 2) {
        return null;
      }

      const nextTeams = current.teams.map((team, index) => {
        if (index !== teamIndex) {
          return team;
        }

        return {
          ...team,
          score: clampScore(clampScore(team?.score) + delta),
        };
      });

      const nextPayload = { teams: nextTeams };

      if (delta > 0) {
        nextPayload.servingTeamIndex = teamIndex;
      }

      return nextPayload;
    });
  };

  const applyManualScores = () => {
    if (isFinalized) {
      return;
    }

    const nextHome = clampScore(manualHome);
    const nextAway = clampScore(manualAway);

    updateScoreboard((current) => {
      if (!Array.isArray(current?.teams) || current.teams.length !== 2) {
        return null;
      }

      return {
        teams: current.teams.map((team, index) => ({
          ...team,
          score: index === 0 ? nextHome : nextAway,
        })),
      };
    });

    setActionError('');
    setActionInfo('Manual score applied.');
  };

  const handleStartMatch = async () => {
    if (isFinalized || matchStatus === MATCH_STATUS.LIVE || startBusy) {
      return;
    }

    if (!matchId) {
      setActionInfo('');
      setActionError('Missing match identifier.');
      return;
    }

    if (!token) {
      setActionInfo('');
      setActionError('You must be signed in to start this match.');
      return;
    }

    setStartBusy(true);
    setActionError('');
    setActionInfo('');

    try {
      const response = await fetch(`${API_URL}/api/matches/${matchId}/start`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(payload?.message || 'Unable to start match.');
      }

      const nextStatus = normalizeMatchStatus(payload?.status, MATCH_STATUS.LIVE);
      const nextStartedAt = normalizeLifecycleTimestamp(payload?.startedAt) || new Date().toISOString();
      const nextEndedAt = normalizeLifecycleTimestamp(payload?.endedAt);

      setMatchStatus(nextStatus);
      setMatchStartedAt(nextStartedAt);
      setMatchEndedAt(nextEndedAt);
      onLifecycleChange?.({
        status: nextStatus,
        startedAt: nextStartedAt,
        endedAt: nextEndedAt,
      });
      setActionError('');
      setActionInfo('Match is now live. Scoring controls unlocked.');
    } catch (startError) {
      setActionInfo('');
      setActionError(startError?.message || 'Unable to start match.');
    } finally {
      setStartBusy(false);
    }
  };

  const handleEndMatch = async () => {
    if (isFinalized || matchStatus !== MATCH_STATUS.LIVE || endBusy) {
      return;
    }

    if (!matchId) {
      setActionInfo('');
      setActionError('Missing match identifier.');
      return;
    }

    if (!token) {
      setActionInfo('');
      setActionError('You must be signed in to end this match.');
      return;
    }

    setEndBusy(true);
    setActionError('');
    setActionInfo('');

    try {
      const response = await fetch(`${API_URL}/api/matches/${matchId}/end`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(payload?.message || 'Unable to end match.');
      }

      const nextStatus = normalizeMatchStatus(payload?.status, MATCH_STATUS.ENDED);
      const nextStartedAt = normalizeLifecycleTimestamp(payload?.startedAt);
      const nextEndedAt = normalizeLifecycleTimestamp(payload?.endedAt) || new Date().toISOString();

      setMatchStatus(nextStatus);
      setMatchStartedAt(nextStartedAt);
      setMatchEndedAt(nextEndedAt);
      onLifecycleChange?.({
        status: nextStatus,
        startedAt: nextStartedAt,
        endedAt: nextEndedAt,
      });
      setActionError('');
      setActionInfo('Match ended. Finalize from schedule when ready.');
    } catch (endError) {
      setActionInfo('');
      setActionError(endError?.message || 'Unable to end match.');
    } finally {
      setEndBusy(false);
    }
  };

  const saveSet = () => {
    if (!canSaveSet || !Array.isArray(scoreboard?.teams) || scoreboard.teams.length !== 2) {
      if (completedSets.length >= maxCompletedSets) {
        setActionInfo('');
        setActionError(`Set limit reached (${maxCompletedSets}).`);
      }
      return;
    }

    const liveScores = [clampScore(scoreboard.teams[0]?.score), clampScore(scoreboard.teams[1]?.score)];
    const nextSets = [...completedSets, { scores: liveScores, createdAt: new Date().toISOString() }];

    updateScoreboard({
      sets: nextSets,
      teams: scoreboard.teams.map((team) => ({ ...team, score: 0 })),
    });

    setManualHome('0');
    setManualAway('0');
    setActionError('');
    setActionInfo(`Set ${nextSets.length} saved.`);
  };

  const undoLastSet = () => {
    if (isFinalized || completedSets.length === 0 || !Array.isArray(scoreboard?.teams) || scoreboard.teams.length !== 2) {
      return;
    }

    const lastSet = completedSets[completedSets.length - 1];
    const nextSets = completedSets.slice(0, -1);

    updateScoreboard({
      sets: nextSets,
      teams: scoreboard.teams.map((team, index) => ({
        ...team,
        score: clampScore(lastSet.scores[index]),
      })),
    });

    setManualHome(String(clampScore(lastSet.scores[0])));
    setManualAway(String(clampScore(lastSet.scores[1])));
    setActionError('');
    setActionInfo(`Set ${completedSets.length} removed and restored to current score.`);
  };

  const resetCurrent = () => {
    if (isFinalized || !Array.isArray(scoreboard?.teams) || scoreboard.teams.length !== 2) {
      return;
    }

    updateScoreboard({
      teams: scoreboard.teams.map((team) => ({
        ...team,
        score: 0,
      })),
    });

    setManualHome('0');
    setManualAway('0');
    setActionError('');
    setActionInfo('Current set scores reset.');
  };

  if (loading) {
    return (
      <section className="card tournament-match-control">
        <p className="subtle">Loading tournament match control...</p>
      </section>
    );
  }

  if (!scoreboard) {
    return (
      <section className="card tournament-match-control">
        <h1 className="title">Tournament Match Control</h1>
        <p className="error">Scoreboard not found.</p>
      </section>
    );
  }

  return (
    <section className="card tournament-match-control">
      <header className="tournament-match-control__header">
        <div>
          <h1 className="title tournament-match-control__title">Tournament Match Control</h1>
          <p className="subtitle tournament-match-control__subtitle">
            Code {scoreboard?.code || scoreboard?._id || 'Unknown'}
          </p>
        </div>
        <span className={`phase1-status-badge ${statusMeta.badgeClassName}`}>
          {statusMeta.label}
        </span>
      </header>

      <section className="tournament-match-control__section">
        <div className="tournament-match-control__start-row">
          <button
            type="button"
            className="primary-button"
            onClick={handleStartMatch}
            disabled={isFinalized || matchStatus === MATCH_STATUS.LIVE || startBusy}
          >
            {startBusy
              ? 'Starting...'
              : matchStatus === MATCH_STATUS.LIVE
                ? 'Match Live'
                : matchStatus === MATCH_STATUS.ENDED
                  ? 'Restart Match'
                  : 'Start Match'}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={handleEndMatch}
            disabled={isFinalized || matchStatus !== MATCH_STATUS.LIVE || endBusy}
          >
            {endBusy ? 'Ending...' : 'End Match'}
          </button>
          {matchStatus === MATCH_STATUS.LIVE && matchStartedAt && (
            <p className="subtle tournament-match-control__timer">LIVE {liveTimer}</p>
          )}
          {matchStatus === MATCH_STATUS.SCHEDULED && (
            <p className="subtle">
              Score buttons are locked until the match is started.
            </p>
          )}
          {matchStatus === MATCH_STATUS.ENDED && (
            <p className="subtle">
              Match ended{matchEndedAt ? ` at ${new Date(matchEndedAt).toLocaleTimeString()}` : ''}. Finalize from admin schedule when confirmed.
            </p>
          )}
          {isFinalized && (
            <p className="subtle">
              This match is finalized. Unfinalize from the admin schedule to continue scoring.
            </p>
          )}
        </div>
      </section>

      <section className="tournament-match-control__section">
        <h2 className="secondary-title">Live Scoring</h2>
        <div className="tournament-score-grid">
          {teams.map((team, index) => (
            <article key={team.name || `team-${index}`} className="tournament-score-card">
              <h3>{team.name}</h3>
              <div className="tournament-score-card__controls">
                <button
                  type="button"
                  className="score-chip"
                  aria-label={`Decrease ${team.name} score`}
                  onClick={() => bumpScore(index, -1)}
                  disabled={isFinalized || isScoringLocked}
                >
                  −
                </button>
                <div className="tournament-score-card__value">{team.score}</div>
                <button
                  type="button"
                  className="score-chip"
                  aria-label={`Increase ${team.name} score`}
                  onClick={() => bumpScore(index, +1)}
                  disabled={isFinalized || isScoringLocked}
                >
                  +
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="tournament-match-control__section">
        <h2 className="secondary-title">Quick Manual Score</h2>
        <div className="tournament-manual-grid">
          <label className="tournament-manual-field">
            <span className="input-label">{teams[0]?.name || 'Home'}</span>
            <input
              type="number"
              min="0"
              step="1"
              value={manualHome}
              onChange={(event) => setManualHome(event.target.value)}
              disabled={isFinalized}
            />
          </label>
          <label className="tournament-manual-field">
            <span className="input-label">{teams[1]?.name || 'Away'}</span>
            <input
              type="number"
              min="0"
              step="1"
              value={manualAway}
              onChange={(event) => setManualAway(event.target.value)}
              disabled={isFinalized}
            />
          </label>
          <button
            type="button"
            className="secondary-button tournament-manual-apply"
            onClick={applyManualScores}
            disabled={isFinalized}
          >
            Apply
          </button>
        </div>
      </section>

      <section className="tournament-match-control__section">
        <h2 className="secondary-title">Set Controls</h2>
        <div className="tournament-set-actions">
          <button type="button" className="secondary-button" onClick={saveSet} disabled={!canSaveSet}>
            Save Set
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={undoLastSet}
            disabled={isFinalized || completedSets.length === 0}
          >
            Undo Last Set
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={resetCurrent}
            disabled={isFinalized}
          >
            Reset Current
          </button>
        </div>
        <p className="subtle">
          Completed sets: {completedSets.length}/{maxCompletedSets}
        </p>
      </section>

      <section className="tournament-match-control__section">
        <h2 className="secondary-title">Completed Sets</h2>
        {completedSets.length === 0 ? (
          <p className="subtle">No completed sets yet.</p>
        ) : (
          <ol className="tournament-set-list">
            {completedSets.map((set, index) => (
              <li key={`${set.createdAt}-${index}`}>
                <span>Set {index + 1}</span>
                <span>
                  {set.scores[0]} - {set.scores[1]}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {actionInfo && <p className="subtle phase1-success">{actionInfo}</p>}
      {actionError && <p className="error">{actionError}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

export default TournamentMatchControlView;

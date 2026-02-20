import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { API_URL } from '../config/env.js';
import TournamentAdminNav from '../components/TournamentAdminNav.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { buildFormatPreview } from '../utils/formatPreview.js';
import { formatRoundBlockStartTime, resolveRoundBlockStartMinutes } from '../utils/phase1.js';

const ODU_15_FORMAT_ID = 'odu_15_5courts_v1';

const DEFAULT_TOTAL_COURTS = 5;
const DEFAULT_SCHEDULE = Object.freeze({
  dayStartTime: '09:00',
  matchDurationMinutes: 60,
  lunchStartTime: '',
  lunchDurationMinutes: 45,
});

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
});

const jsonHeaders = (token) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
});

const toPositiveInteger = (value, fallback = null, min = 1, max = 64) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const normalized = Math.floor(parsed);
  if (normalized < min || normalized > max) {
    return fallback;
  }

  return normalized;
};

const normalizeTimeString = (value, fallback = '') => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) {
    return fallback;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return fallback;
  }

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

const normalizeQuarterHourTime = (value, fallback = '') => {
  const normalized = normalizeTimeString(value, fallback);
  if (!normalized) {
    return fallback;
  }

  const [hoursText, minutesText] = normalized.split(':');
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const totalMinutes = hours * 60 + minutes;
  const rounded = Math.round(totalMinutes / 15) * 15;
  const roundedHours = Math.floor(((rounded % 1440) + 1440) % 1440 / 60);
  const roundedMinutes = ((rounded % 60) + 60) % 60;

  return `${String(roundedHours).padStart(2, '0')}:${String(roundedMinutes).padStart(2, '0')}`;
};

const buildQuarterHourOptions = () =>
  Array.from({ length: 96 }, (_, index) => {
    const minutesTotal = index * 15;
    const hours = Math.floor(minutesTotal / 60);
    const minutes = minutesTotal % 60;
    const value = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    const meridiem = hours >= 12 ? 'PM' : 'AM';
    const hours12 = hours % 12 || 12;
    const label = `${hours12}:${String(minutes).padStart(2, '0')} ${meridiem}`;

    return { value, label };
  });

const QUARTER_HOUR_OPTIONS = buildQuarterHourOptions();

const normalizeSchedule = (schedule) => ({
  dayStartTime: normalizeQuarterHourTime(
    schedule?.dayStartTime ?? schedule?.startTime,
    DEFAULT_SCHEDULE.dayStartTime
  ),
  matchDurationMinutes: toPositiveInteger(
    schedule?.matchDurationMinutes ?? schedule?.matchDuration,
    DEFAULT_SCHEDULE.matchDurationMinutes,
    1,
    240
  ),
  lunchStartTime: normalizeQuarterHourTime(
    schedule?.lunchStartTime ?? schedule?.lunchStart,
    ''
  ),
  lunchDurationMinutes: toPositiveInteger(
    schedule?.lunchDurationMinutes ?? schedule?.lunchDuration,
    DEFAULT_SCHEDULE.lunchDurationMinutes,
    1,
    240
  ),
});

const formatClockMinutes = (minutesSinceMidnight) => {
  const normalized = ((Math.floor(minutesSinceMidnight) % 1440) + 1440) % 1440;
  const hours24 = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  const meridiem = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${String(minutes).padStart(2, '0')} ${meridiem}`;
};

const buildFormatSignature = (formatId, totalCourts, schedule) => {
  const normalizedFormatId = typeof formatId === 'string' ? formatId.trim() : '';
  const normalizedCourts = toPositiveInteger(totalCourts);
  if (!normalizedFormatId || !normalizedCourts) {
    return '';
  }

  const normalizedSchedule = normalizeSchedule(schedule);
  return [
    normalizedFormatId,
    normalizedCourts,
    normalizedSchedule.dayStartTime,
    normalizedSchedule.matchDurationMinutes,
    normalizedSchedule.lunchStartTime || 'none',
    normalizedSchedule.lunchDurationMinutes,
  ].join('::');
};

const getPoolStages = (formatDef) =>
  Array.isArray(formatDef?.stages)
    ? formatDef.stages.filter((stage) => stage?.type === 'poolPlay')
    : [];

function TournamentFormatAdmin() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { token, user, initializing } = useAuth();

  const [tournament, setTournament] = useState(null);
  const [teams, setTeams] = useState([]);
  const [suggestedFormats, setSuggestedFormats] = useState([]);
  const [appliedFormatDef, setAppliedFormatDef] = useState(null);
  const [selectedFormatDef, setSelectedFormatDef] = useState(null);
  const [selectedFormatId, setSelectedFormatId] = useState('');
  const [totalCourts, setTotalCourts] = useState(DEFAULT_TOTAL_COURTS);
  const [schedule, setSchedule] = useState({ ...DEFAULT_SCHEDULE });
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [resettingTournament, setResettingTournament] = useState(false);
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

  const fetchFormatDef = useCallback(
    async (formatId) => {
      const normalizedFormatId = typeof formatId === 'string' ? formatId.trim() : '';
      if (!normalizedFormatId) {
        return null;
      }
      return fetchJson(`${API_URL}/api/tournament-formats/${normalizedFormatId}`);
    },
    [fetchJson]
  );

  const loadSuggestions = useCallback(
    async (teamCount, courtCount) => {
      if (
        !Number.isFinite(Number(teamCount)) ||
        Number(teamCount) <= 0 ||
        !Number.isFinite(Number(courtCount)) ||
        Number(courtCount) <= 0
      ) {
        setSuggestedFormats([]);
        return [];
      }

      const suggestions = await fetchJson(
        `${API_URL}/api/tournament-formats/suggest?teamCount=${Number(
          teamCount
        )}&courtCount=${Number(courtCount)}`
      );
      const normalized = Array.isArray(suggestions) ? suggestions : [];
      setSuggestedFormats(normalized);
      return normalized;
    },
    [fetchJson]
  );

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

      const normalizedTeams = Array.isArray(teamsPayload) ? teamsPayload : [];
      const appliedFormatId =
        typeof tournamentPayload?.settings?.format?.formatId === 'string'
          ? tournamentPayload.settings.format.formatId.trim()
          : '';
      const resolvedTotalCourts =
        toPositiveInteger(tournamentPayload?.settings?.format?.totalCourts)
        || toPositiveInteger(
          Array.isArray(tournamentPayload?.settings?.format?.activeCourts)
            ? tournamentPayload.settings.format.activeCourts.length
            : null
        )
        || DEFAULT_TOTAL_COURTS;
      const nextSchedule = normalizeSchedule(tournamentPayload?.settings?.schedule);

      setTournament(tournamentPayload);
      setTeams(normalizedTeams);
      setTotalCourts(resolvedTotalCourts);
      setSchedule(nextSchedule);
      setSelectedFormatId(appliedFormatId);

      await loadSuggestions(normalizedTeams.length, resolvedTotalCourts);

      if (!appliedFormatId) {
        setAppliedFormatDef(null);
        return;
      }

      const nextAppliedFormatDef = await fetchFormatDef(appliedFormatId);
      setAppliedFormatDef(nextAppliedFormatDef);
    } catch (loadError) {
      setError(loadError.message || 'Unable to load format setup');
    } finally {
      setLoading(false);
    }
  }, [fetchFormatDef, fetchJson, id, loadSuggestions, token]);

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
    loadSuggestions(teams.length, totalCourts).catch(() => {});
  }, [loadSuggestions, teams.length, totalCourts]);

  const appliedFormatId =
    typeof tournament?.settings?.format?.formatId === 'string'
      ? tournament.settings.format.formatId.trim()
      : '';
  const appliedTotalCourts =
    toPositiveInteger(tournament?.settings?.format?.totalCourts)
    || DEFAULT_TOTAL_COURTS;
  const appliedSchedule = normalizeSchedule(tournament?.settings?.schedule);

  useEffect(() => {
    if (suggestedFormats.length === 0) {
      return;
    }

    if (selectedFormatId && suggestedFormats.some((entry) => entry.id === selectedFormatId)) {
      return;
    }

    const appliedSuggestion = appliedFormatId
      ? suggestedFormats.find((entry) => entry.id === appliedFormatId)
      : null;
    const nextSelected = appliedSuggestion?.id || suggestedFormats[0].id;
    if (nextSelected) {
      setSelectedFormatId(nextSelected);
    }
  }, [appliedFormatId, selectedFormatId, suggestedFormats]);

  useEffect(() => {
    let cancelled = false;

    const loadSelectedFormatDef = async () => {
      const normalizedSelectedId =
        typeof selectedFormatId === 'string' ? selectedFormatId.trim() : '';
      if (!normalizedSelectedId) {
        setSelectedFormatDef(null);
        return;
      }

      if (appliedFormatDef?.id === normalizedSelectedId) {
        setSelectedFormatDef(appliedFormatDef);
        return;
      }

      try {
        const payload = await fetchFormatDef(normalizedSelectedId);
        if (!cancelled) {
          setSelectedFormatDef(payload);
        }
      } catch {
        if (!cancelled) {
          setSelectedFormatDef(null);
        }
      }
    };

    loadSelectedFormatDef();

    return () => {
      cancelled = true;
    };
  }, [appliedFormatDef, fetchFormatDef, selectedFormatId]);

  const desiredSignature = useMemo(
    () => buildFormatSignature(selectedFormatId, totalCourts, schedule),
    [schedule, selectedFormatId, totalCourts]
  );
  const appliedSignature = useMemo(
    () => buildFormatSignature(appliedFormatId, appliedTotalCourts, appliedSchedule),
    [appliedFormatId, appliedSchedule, appliedTotalCourts]
  );
  const hasPendingChanges = Boolean(
    desiredSignature && desiredSignature !== appliedSignature
  );

  const handleApplyFormat = useCallback(async () => {
    if (!token || !id || applying) {
      return;
    }

    const normalizedFormatId =
      typeof selectedFormatId === 'string' ? selectedFormatId.trim() : '';
    if (!normalizedFormatId) {
      setError('Select a format before applying.');
      return;
    }

    if (!desiredSignature || desiredSignature === appliedSignature) {
      setMessage('No format changes to apply.');
      return;
    }

    const runApply = async (force) => {
      const suffix = force ? '?force=true' : '';
      const response = await fetch(`${API_URL}/api/tournaments/${id}/apply-format${suffix}`, {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          formatId: normalizedFormatId,
          totalCourts: toPositiveInteger(totalCourts, DEFAULT_TOTAL_COURTS),
          schedule,
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
      };
    };

    setApplying(true);
    setError('');
    setMessage('');

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

        await runApply(true);
        setMessage('Format applied and existing scheduling data replaced.');
        await loadData();
        return;
      }

      setMessage('Format applied.');
      await loadData();
    } catch (applyError) {
      setError(applyError.message || 'Unable to apply format');
    } finally {
      setApplying(false);
    }
  }, [
    appliedSignature,
    applying,
    desiredSignature,
    id,
    loadData,
    schedule,
    selectedFormatId,
    token,
    totalCourts,
  ]);

  const handleResetTournament = useCallback(async () => {
    if (!token || !id || resettingTournament || !tournament?.isOwner) {
      return;
    }

    const confirmed = window.confirm(
      'Reset this tournament?\n\nThis deletes all pools, matches, and linked scoreboards, clears standings overrides, and sets status back to setup. Teams, details, and format settings stay.'
    );
    if (!confirmed) {
      return;
    }

    setResettingTournament(true);
    setError('');
    setMessage('');

    try {
      await fetchJson(`${API_URL}/api/tournaments/${id}/reset`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      setMessage('Tournament reset. Redirecting to format setup.');
      await loadData();
      navigate(`/tournaments/${id}/format`, { replace: true });
    } catch (resetError) {
      setError(resetError.message || 'Unable to reset tournament');
    } finally {
      setResettingTournament(false);
    }
  }, [fetchJson, id, loadData, navigate, resettingTournament, token, tournament?.isOwner]);

  const selectedFormatSummary = useMemo(
    () => suggestedFormats.find((entry) => entry.id === selectedFormatId) || null,
    [selectedFormatId, suggestedFormats]
  );
  const formatPreview = useMemo(
    () => buildFormatPreview({ formatDef: selectedFormatDef, totalCourts }),
    [selectedFormatDef, totalCourts]
  );
  const totalRoundBlocks = useMemo(() => {
    const allRows = [...formatPreview.poolScheduleRows, ...formatPreview.playoffRows];
    const maxRoundBlock = allRows.reduce(
      (maxValue, row) => Math.max(maxValue, Number(row?.roundBlock || 0)),
      0
    );
    return Number.isFinite(maxRoundBlock) ? maxRoundBlock : 0;
  }, [formatPreview.playoffRows, formatPreview.poolScheduleRows]);
  const previewTournament = useMemo(
    () => ({
      ...tournament,
      settings: {
        ...(tournament?.settings || {}),
        schedule,
      },
    }),
    [schedule, tournament]
  );
  const estimatedEndLabel = useMemo(() => {
    if (totalRoundBlocks <= 0) {
      return '';
    }

    const finalStartMinutes = resolveRoundBlockStartMinutes(totalRoundBlocks + 1, previewTournament);
    if (!Number.isFinite(finalStartMinutes)) {
      return '';
    }

    return formatClockMinutes(finalStartMinutes);
  }, [previewTournament, totalRoundBlocks]);

  const appliedPoolStages = useMemo(() => getPoolStages(appliedFormatDef), [appliedFormatDef]);
  const appliedFirstPoolStage = appliedPoolStages[0] || null;
  const appliedSecondPoolStage = appliedPoolStages[1] || null;
  const showLegacyPhase2 =
    appliedFormatId === ODU_15_FORMAT_ID && Boolean(appliedSecondPoolStage);

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
          <p className="subtle">Sign in to manage tournament format.</p>
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
              {tournament?.name || 'Tournament'} • Select format and total courts. Venue and pool
              court assignments are configured on Pool Play.
            </p>
            <TournamentAdminNav
              tournamentId={id}
              publicCode={tournament?.publicCode || ''}
              activeMainTab="scheduling"
              scheduling={{
                activeSubTab: 'format',
                showPhase2: showLegacyPhase2,
                phase1Label:
                  appliedFirstPoolStage?.displayName
                  || (showLegacyPhase2 ? 'Pool Play 1' : 'Pool Play'),
                phase1Href: showLegacyPhase2
                  ? `/tournaments/${id}/phase1`
                  : `/tournaments/${id}/pool-play`,
                phase2Label: appliedSecondPoolStage?.displayName || 'Pool Play 2',
                phase2Href: showLegacyPhase2
                  ? `/tournaments/${id}/phase2`
                  : `/tournaments/${id}/pool-play`,
                playoffsHref: `/tournaments/${id}/playoffs`,
              }}
            />
          </div>
          <div className="phase1-admin-actions">
            <button
              className="primary-button"
              type="button"
              onClick={handleApplyFormat}
              disabled={!hasPendingChanges || applying || resettingTournament}
            >
              {applying ? 'Applying...' : 'Apply Format'}
            </button>
            {tournament?.isOwner && (
              <button
                className="secondary-button danger-button"
                type="button"
                onClick={handleResetTournament}
                disabled={resettingTournament}
              >
                {resettingTournament ? 'Resetting...' : 'Reset Tournament'}
              </button>
            )}
          </div>
        </div>

        <section className="phase1-standings">
          <h2 className="secondary-title">Format Selection</h2>
          <p className="subtle">Team count: {teams.length}</p>

          <div className="format-input-grid">
            <label className="format-input-card" htmlFor="format-total-courts">
              <span className="format-input-label">Courts available</span>
              <input
                className="format-input-control"
                id="format-total-courts"
                type="number"
                min={1}
                max={12}
                value={totalCourts}
                onChange={(event) =>
                  setTotalCourts(
                    toPositiveInteger(event.target.value, DEFAULT_TOTAL_COURTS, 1, 12)
                    || DEFAULT_TOTAL_COURTS
                  )
                }
                disabled={applying}
              />
            </label>
            <label className="format-input-card" htmlFor="format-start-time">
              <span className="format-input-label">Start time</span>
              <select
                className="format-input-control format-input-control--select"
                id="format-start-time"
                value={schedule.dayStartTime}
                onChange={(event) =>
                  setSchedule((previous) => ({
                    ...previous,
                    dayStartTime: normalizeQuarterHourTime(event.target.value, previous.dayStartTime),
                  }))
                }
                disabled={applying}
              >
                {QUARTER_HOUR_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="format-input-card" htmlFor="format-match-duration">
              <span className="format-input-label">Match duration (min)</span>
              <input
                className="format-input-control"
                id="format-match-duration"
                type="number"
                min={1}
                max={240}
                value={schedule.matchDurationMinutes}
                onChange={(event) =>
                  setSchedule((previous) => ({
                    ...previous,
                    matchDurationMinutes:
                      toPositiveInteger(event.target.value, previous.matchDurationMinutes, 1, 240)
                      || previous.matchDurationMinutes,
                  }))
                }
                disabled={applying}
              />
            </label>
            <label className="format-input-card" htmlFor="format-lunch-start">
              <span className="format-input-label">Lunch start</span>
              <select
                className="format-input-control format-input-control--select"
                id="format-lunch-start"
                value={schedule.lunchStartTime}
                onChange={(event) =>
                  setSchedule((previous) => ({
                    ...previous,
                    lunchStartTime: normalizeQuarterHourTime(event.target.value, ''),
                  }))
                }
                disabled={applying}
              >
                <option value="">No lunch break</option>
                {QUARTER_HOUR_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="format-input-card" htmlFor="format-lunch-duration">
              <span className="format-input-label">Lunch duration (min)</span>
              <input
                className="format-input-control"
                id="format-lunch-duration"
                type="number"
                min={1}
                max={240}
                value={schedule.lunchDurationMinutes}
                onChange={(event) =>
                  setSchedule((previous) => ({
                    ...previous,
                    lunchDurationMinutes:
                      toPositiveInteger(event.target.value, previous.lunchDurationMinutes, 1, 240)
                      || previous.lunchDurationMinutes,
                  }))
                }
                disabled={applying}
              />
            </label>
          </div>

          {suggestedFormats.length === 0 ? (
            <p className="subtle">No suggested formats for this team count and court count.</p>
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

          {selectedFormatSummary && (
            <p className="subtle">
              Supports teams: {(selectedFormatSummary.supportedTeamCounts || []).join(', ')} •
              Min courts: {selectedFormatSummary.minCourts ?? 'N/A'} • Max courts:{' '}
              {selectedFormatSummary.maxCourts ?? 'N/A'}
            </p>
          )}
          <p className="subtle">
            Changes are staged locally until you click Apply Format.
            {hasPendingChanges ? ' You have unapplied changes.' : ' No pending changes.'}
          </p>
        </section>

        {error && <p className="error">{error}</p>}
        {message && <p className="subtle phase1-success">{message}</p>}

        <section className="phase1-schedule">
          <h2 className="secondary-title">Format Schedule Preview</h2>
          {selectedFormatDef ? (
            <p className="subtle">
              {selectedFormatDef.name} • Blocks needed: {totalRoundBlocks || '—'}
              {estimatedEndLabel ? ` • Estimated end: ${estimatedEndLabel}` : ''}
            </p>
          ) : (
            <p className="subtle">Select a format to preview its schedule.</p>
          )}

          {formatPreview.poolScheduleRows.length > 0 ? (
            <div className="phase1-table-wrap">
              <table className="phase1-schedule-table">
                <thead>
                  <tr>
                    <th>Round</th>
                    <th>Time</th>
                    <th>Court</th>
                    <th>Stage</th>
                    <th>Match</th>
                    <th>Ref</th>
                    <th>Bye</th>
                  </tr>
                </thead>
                <tbody>
                  {formatPreview.poolScheduleRows.map((row) => (
                    <tr key={row.id}>
                      <td>R{row.roundBlock}</td>
                      <td>{formatRoundBlockStartTime(row.roundBlock, previewTournament)}</td>
                      <td>{row.court}</td>
                      <td>{row.stageLabel}</td>
                      <td>{row.matchLabel}</td>
                      <td>{row.refLabel || '—'}</td>
                      <td>{row.byeLabel || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="subtle">No pool-play schedule template available for this format.</p>
          )}

          <h3>Playoffs</h3>
          {formatPreview.playoffRows.length > 0 ? (
            <div className="phase1-table-wrap">
              <table className="phase1-schedule-table">
                <thead>
                  <tr>
                    <th>Round</th>
                    <th>Time</th>
                    <th>Court</th>
                    <th>Bracket</th>
                    <th>Matchup</th>
                  </tr>
                </thead>
                <tbody>
                  {formatPreview.playoffRows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.roundLabel}</td>
                      <td>{formatRoundBlockStartTime(row.roundBlock, previewTournament)}</td>
                      <td>{row.court}</td>
                      <td>{row.bracketLabel}</td>
                      <td>{row.matchupLabel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="subtle">No playoff schedule template available for this format.</p>
          )}
        </section>
      </section>
    </main>
  );
}

export default TournamentFormatAdmin;

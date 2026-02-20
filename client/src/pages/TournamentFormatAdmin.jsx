import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { API_URL } from '../config/env.js';
import TournamentAdminNav from '../components/TournamentAdminNav.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { buildFormatPreview } from '../utils/formatPreview.js';
import { formatRoundBlockStartTime, mapCourtLabel } from '../utils/phase1.js';

const ODU_15_FORMAT_ID = 'odu_15_5courts_v1';

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
});

const jsonHeaders = (token) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
});

const normalizeCourtCode = (courtCode) =>
  typeof courtCode === 'string' ? courtCode.trim().toUpperCase() : '';

const uniqueCourts = (values) => {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((entry) => normalizeCourtCode(entry))
    .filter((entry) => {
      if (!entry || seen.has(entry)) {
        return false;
      }
      seen.add(entry);
      return true;
    });
};

const flattenFacilityCourts = (facilities) => {
  const source = facilities && typeof facilities === 'object' ? facilities : {};
  const src = Array.isArray(source.SRC) ? source.SRC : ['SRC-1', 'SRC-2', 'SRC-3'];
  const vc = Array.isArray(source.VC) ? source.VC : ['VC-1', 'VC-2'];
  return uniqueCourts([...src, ...vc]);
};

const getPoolStages = (formatDef) =>
  Array.isArray(formatDef?.stages)
    ? formatDef.stages.filter((stage) => stage?.type === 'poolPlay')
    : [];

const buildFormatSignature = (formatId, courts) => {
  const normalizedFormatId = typeof formatId === 'string' ? formatId.trim() : '';
  const normalizedCourts = uniqueCourts(courts).sort();
  if (!normalizedFormatId || normalizedCourts.length === 0) {
    return '';
  }
  return `${normalizedFormatId}::${normalizedCourts.join(',')}`;
};

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
  const [activeCourts, setActiveCourts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [resettingTournament, setResettingTournament] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const declinedAutoApplySignatureRef = useRef('');

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
      const availableCourts = flattenFacilityCourts(tournamentPayload?.facilities);
      const configuredCourts = uniqueCourts(tournamentPayload?.settings?.format?.activeCourts).filter(
        (courtCode) => availableCourts.includes(courtCode)
      );
      const nextActiveCourts = configuredCourts.length > 0 ? configuredCourts : availableCourts;
      const appliedFormatId =
        typeof tournamentPayload?.settings?.format?.formatId === 'string'
          ? tournamentPayload.settings.format.formatId.trim()
          : '';

      setTournament(tournamentPayload);
      setTeams(normalizedTeams);
      setActiveCourts(nextActiveCourts);
      setSelectedFormatId(appliedFormatId);

      await loadSuggestions(normalizedTeams.length, nextActiveCourts.length);

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
    loadSuggestions(teams.length, activeCourts.length).catch(() => {});
  }, [activeCourts.length, loadSuggestions, teams.length]);

  const appliedFormatId =
    typeof tournament?.settings?.format?.formatId === 'string'
      ? tournament.settings.format.formatId.trim()
      : '';
  const appliedActiveCourts = uniqueCourts(tournament?.settings?.format?.activeCourts);

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

  const availableCourts = useMemo(
    () => flattenFacilityCourts(tournament?.facilities),
    [tournament?.facilities]
  );

  const desiredSignature = useMemo(
    () => buildFormatSignature(selectedFormatId, activeCourts),
    [activeCourts, selectedFormatId]
  );
  const appliedSignature = useMemo(
    () => buildFormatSignature(appliedFormatId, appliedActiveCourts),
    [appliedActiveCourts, appliedFormatId]
  );

  useEffect(() => {
    if (!token || !id || loading || applying) {
      return;
    }

    if (!desiredSignature || desiredSignature === appliedSignature) {
      return;
    }

    if (declinedAutoApplySignatureRef.current === desiredSignature) {
      return;
    }

    let cancelled = false;

    const runApply = async (force) => {
      const suffix = force ? '?force=true' : '';
      const response = await fetch(`${API_URL}/api/tournaments/${id}/apply-format${suffix}`, {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          formatId: selectedFormatId,
          activeCourts: uniqueCourts(activeCourts),
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

    const applySelection = async () => {
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
            if (!cancelled) {
              declinedAutoApplySignatureRef.current = desiredSignature;
              setMessage(firstAttempt.message);
            }
            return;
          }

          await runApply(true);
          if (!cancelled) {
            declinedAutoApplySignatureRef.current = '';
            setMessage('Format applied and existing scheduling data replaced.');
            await loadData();
          }
          return;
        }

        if (!cancelled) {
          declinedAutoApplySignatureRef.current = '';
          setMessage('Format applied.');
          await loadData();
        }
      } catch (applyError) {
        if (!cancelled) {
          setError(applyError.message || 'Unable to apply format');
        }
      } finally {
        if (!cancelled) {
          setApplying(false);
        }
      }
    };

    applySelection();

    return () => {
      cancelled = true;
    };
  }, [
    activeCourts,
    appliedSignature,
    applying,
    desiredSignature,
    id,
    loadData,
    loading,
    selectedFormatId,
    token,
  ]);

  const toggleCourt = useCallback((courtCode) => {
    const normalized = normalizeCourtCode(courtCode);
    if (!normalized) {
      return;
    }

    setActiveCourts((previous) => {
      const exists = previous.includes(normalized);
      if (exists) {
        if (previous.length <= 1) {
          return previous;
        }
        return previous.filter((entry) => entry !== normalized);
      }

      return [...previous, normalized];
    });
  }, []);

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
  const previewCourts = activeCourts.length > 0 ? activeCourts : availableCourts;
  const formatPreview = useMemo(
    () => buildFormatPreview({ formatDef: selectedFormatDef, activeCourts: previewCourts }),
    [previewCourts, selectedFormatDef]
  );

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
              {tournament?.name || 'Tournament'} • Select courts and format. Changes apply
              automatically.
            </p>
            <TournamentAdminNav
              tournamentId={id}
              publicCode={tournament?.publicCode || ''}
              activeMainTab="scheduling"
              scheduling={{
                activeSubTab: 'format',
                showPhase2: showLegacyPhase2,
                phase1Label:
                  appliedFirstPoolStage?.displayName ||
                  (showLegacyPhase2 ? 'Pool Play 1' : 'Pool Play'),
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

          <div className="phase1-admin-actions">
            {availableCourts.map((courtCode) => (
              <label key={courtCode} className="subtle">
                <input
                  type="checkbox"
                  checked={activeCourts.includes(courtCode)}
                  onChange={() => toggleCourt(courtCode)}
                  disabled={applying}
                />
                {' '}
                {mapCourtLabel(courtCode)}
              </label>
            ))}
          </div>

          {suggestedFormats.length === 0 ? (
            <p className="subtle">No suggested formats for this team count and court selection.</p>
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
              Supports teams: {(selectedFormatSummary.supportedTeamCounts || []).join(', ')} • Min
              courts: {selectedFormatSummary.minCourts ?? 'N/A'}
            </p>
          )}
          <p className="subtle">
            Format and court changes are auto-applied.
            {applying ? ' Applying now...' : ''}
          </p>
        </section>

        {error && <p className="error">{error}</p>}
        {message && <p className="subtle phase1-success">{message}</p>}

        <section className="phase1-schedule">
          <h2 className="secondary-title">Format Schedule Preview</h2>
          {selectedFormatDef ? (
            <p className="subtle">
              {selectedFormatDef.name} • Preview generated from the currently selected format.
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
                      <td>{formatRoundBlockStartTime(row.roundBlock, tournament)}</td>
                      <td>{mapCourtLabel(row.court)}</td>
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
                      <td>{formatRoundBlockStartTime(row.roundBlock, tournament)}</td>
                      <td>{mapCourtLabel(row.court)}</td>
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


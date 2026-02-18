import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { API_URL } from "../config/env.js";
import { planTournamentTeamSync } from "./tournamentTeamDiff.utils.js";

const DEFAULT_TIMEZONE = "America/New_York";

const resolveTimezone = () => {
  if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function") {
    return DEFAULT_TIMEZONE;
  }

  const timezone = Intl.DateTimeFormat().resolvedOptions()?.timeZone;
  return typeof timezone === "string" && timezone.trim() ? timezone : DEFAULT_TIMEZONE;
};

const normalizeText = (value) => (typeof value === "string" ? value.trim() : "");

const normalizeSeedInput = (value) => {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return "";
  }

  return String(parsed);
};

const formatDateLabel = (value) => {
  if (!value) {
    return "No date";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "No date";
  }

  return parsed.toLocaleDateString();
};

const formatStatusLabel = (value) => {
  if (!value) {
    return "setup";
  }

  return String(value)
    .replaceAll("_", " ")
    .replace(/(^|\s)\S/g, (char) => char.toUpperCase());
};

function TournamentsTab({
  user,
  token,
  initialTournamentId = "",
  onTournamentIdChange,
  onShowToast,
}) {
  const navigate = useNavigate();
  const rowCounterRef = useRef(0);

  const [createName, setCreateName] = useState("");
  const [createDate, setCreateDate] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");

  const [tournaments, setTournaments] = useState([]);
  const [tournamentsLoading, setTournamentsLoading] = useState(false);
  const [tournamentsError, setTournamentsError] = useState("");
  const [selectedTournamentId, setSelectedTournamentId] = useState("");

  const [selectedTournament, setSelectedTournament] = useState(null);
  const [teamsInitial, setTeamsInitial] = useState([]);
  const [teamRows, setTeamRows] = useState([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [teamsSaving, setTeamsSaving] = useState(false);
  const [teamsError, setTeamsError] = useState("");
  const [teamsMessage, setTeamsMessage] = useState("");

  const makeRowId = useCallback(() => {
    rowCounterRef.current += 1;
    return `team-row-${rowCounterRef.current}`;
  }, []);

  const toDraftRow = useCallback(
    (team = {}) => ({
      rowId: makeRowId(),
      _id: team?._id ? String(team._id) : "",
      name: team?.name || "",
      shortName: team?.shortName || "",
      seed: normalizeSeedInput(team?.seed),
      logoUrl: typeof team?.logoUrl === "string" ? team.logoUrl : "",
    }),
    [makeRowId]
  );

  const fetchJson = useCallback(async (url, options = {}) => {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(payload?.message || "Request failed");
    }

    return payload;
  }, []);

  const authHeaders = useCallback(
    (includeJson = false) => {
      const headers = {};
      if (includeJson) {
        headers["Content-Type"] = "application/json";
      }
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      return headers;
    },
    [token]
  );

  const loadTournaments = useCallback(
    async ({ preferredTournamentId } = {}) => {
      if (!token) {
        setTournaments([]);
        setSelectedTournamentId("");
        return [];
      }

      setTournamentsLoading(true);
      setTournamentsError("");

      try {
        const payload = await fetchJson(`${API_URL}/api/tournaments`, {
          headers: authHeaders(),
        });
        const list = Array.isArray(payload) ? payload : [];
        setTournaments(list);

        setSelectedTournamentId((current) => {
          const candidates = [
            preferredTournamentId,
            initialTournamentId,
            current,
          ]
            .map((candidate) => (typeof candidate === "string" ? candidate.trim() : ""))
            .filter(Boolean);

          for (const candidate of candidates) {
            if (list.some((item) => String(item?._id) === candidate)) {
              return candidate;
            }
          }

          return list[0]?._id ? String(list[0]._id) : "";
        });

        return list;
      } catch (error) {
        setTournamentsError(error?.message || "Unable to load tournaments");
        return [];
      } finally {
        setTournamentsLoading(false);
      }
    },
    [authHeaders, fetchJson, initialTournamentId, token]
  );

  const loadSelectedTournament = useCallback(
    async (tournamentId) => {
      const normalizedId = typeof tournamentId === "string" ? tournamentId.trim() : "";

      if (!token || !normalizedId) {
        setSelectedTournament(null);
        setTeamsInitial([]);
        setTeamRows([]);
        setTeamsLoading(false);
        return;
      }

      setTeamsLoading(true);
      setTeamsError("");

      try {
        const [tournamentPayload, teamsPayload] = await Promise.all([
          fetchJson(`${API_URL}/api/tournaments/${normalizedId}`, {
            headers: authHeaders(),
          }),
          fetchJson(`${API_URL}/api/tournaments/${normalizedId}/teams`, {
            headers: authHeaders(),
          }),
        ]);

        const normalizedTeams = Array.isArray(teamsPayload)
          ? teamsPayload.map((team) => ({
              _id: team?._id ? String(team._id) : "",
              name: team?.name || "",
              shortName: team?.shortName || "",
              seed: team?.seed ?? null,
              logoUrl: typeof team?.logoUrl === "string" ? team.logoUrl : null,
            }))
          : [];

        setSelectedTournament(tournamentPayload || null);
        setTeamsInitial(normalizedTeams);
        setTeamRows(normalizedTeams.map((team) => toDraftRow(team)));
      } catch (error) {
        setSelectedTournament(null);
        setTeamsInitial([]);
        setTeamRows([]);
        setTeamsError(error?.message || "Unable to load tournament teams");
      } finally {
        setTeamsLoading(false);
      }
    },
    [authHeaders, fetchJson, toDraftRow, token]
  );

  useEffect(() => {
    if (!user || !token) {
      setTournaments([]);
      setSelectedTournamentId("");
      setSelectedTournament(null);
      setTeamsInitial([]);
      setTeamRows([]);
      setTournamentsError("");
      setTeamsError("");
      setTeamsMessage("");
      return;
    }

    loadTournaments();
  }, [loadTournaments, token, user]);

  useEffect(() => {
    const nextId = typeof initialTournamentId === "string" ? initialTournamentId.trim() : "";
    if (!nextId) {
      return;
    }

    setSelectedTournamentId((current) => (current === nextId ? current : nextId));
  }, [initialTournamentId]);

  useEffect(() => {
    if (typeof onTournamentIdChange === "function") {
      onTournamentIdChange(selectedTournamentId);
    }
  }, [onTournamentIdChange, selectedTournamentId]);

  useEffect(() => {
    setTeamsMessage("");
    setTeamsError("");
    loadSelectedTournament(selectedTournamentId);
  }, [loadSelectedTournament, selectedTournamentId]);

  const canEditTeams = selectedTournament?.status === "setup";
  const currentTeamCount = teamRows.length;

  const teamWarnings = useMemo(() => {
    if (!selectedTournament) {
      return [];
    }

    const warnings = [];
    if (currentTeamCount < 15) {
      warnings.push("Pool Play 1 full schedule requires 15 teams.");
    }
    if (currentTeamCount > 15) {
      warnings.push("Pool Play 1 seed initialization currently uses the first 15 teams.");
    }
    return warnings;
  }, [currentTeamCount, selectedTournament]);

  const selectTournament = (nextId) => {
    const cleaned = typeof nextId === "string" ? nextId.trim() : "";
    setSelectedTournamentId(cleaned);
  };

  const addTeamRow = () => {
    if (!canEditTeams || teamsSaving) {
      return;
    }

    setTeamRows((previous) => [
      ...previous,
      {
        rowId: makeRowId(),
        _id: "",
        name: "",
        shortName: "",
        seed: "",
        logoUrl: "",
      },
    ]);
  };

  const removeTeamRow = (rowId) => {
    if (!canEditTeams || teamsSaving) {
      return;
    }

    setTeamRows((previous) => previous.filter((row) => row.rowId !== rowId));
  };

  const updateTeamRow = (rowId, field, value) => {
    if (!canEditTeams || teamsSaving) {
      return;
    }

    setTeamRows((previous) =>
      previous.map((row) => {
        if (row.rowId !== rowId) {
          return row;
        }
        return {
          ...row,
          [field]: value,
        };
      })
    );
  };

  const handleCreateTournament = async (event) => {
    event.preventDefault();

    if (!token || createBusy) {
      return;
    }

    setCreateBusy(true);
    setCreateError("");

    const payload = {
      name: normalizeText(createName),
      date: createDate,
      timezone: resolveTimezone(),
    };

    try {
      const createdTournament = await fetchJson(`${API_URL}/api/tournaments`, {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify(payload),
      });

      const createdId = createdTournament?._id
        ? String(createdTournament._id)
        : createdTournament?.id
          ? String(createdTournament.id)
          : "";

      await loadTournaments({ preferredTournamentId: createdId });
      setCreateName("");
      onShowToast?.("success", "Tournament created");

      if (createdId) {
        navigate(`/tournaments/${createdId}/phase1`);
      }
    } catch (error) {
      const message = error?.message || "Unable to create tournament";
      setCreateError(message);
      onShowToast?.("error", message);
    } finally {
      setCreateBusy(false);
    }
  };

  const handleSaveTeams = async () => {
    if (!token || !selectedTournamentId || !canEditTeams || teamsSaving) {
      return;
    }

    for (let index = 0; index < teamRows.length; index += 1) {
      const row = teamRows[index];
      const name = normalizeText(row?.name);
      const shortName = normalizeText(row?.shortName);
      const seedValue = row?.seed;

      if (!name || !shortName) {
        setTeamsError(`Team ${index + 1} must include both name and short name.`);
        return;
      }

      if (seedValue !== "" && seedValue !== null && seedValue !== undefined) {
        const parsedSeed = Number(seedValue);
        if (!Number.isFinite(parsedSeed)) {
          setTeamsError(`Team ${index + 1} seed must be numeric.`);
          return;
        }
      }
    }

    setTeamsSaving(true);
    setTeamsError("");
    setTeamsMessage("");

    const draftTeams = teamRows.map((row) => ({
      _id: row._id ? String(row._id) : "",
      name: row.name,
      shortName: row.shortName,
      seed: row.seed,
      logoUrl: row.logoUrl,
    }));

    const syncPlan = planTournamentTeamSync(teamsInitial, draftTeams);

    try {
      for (const patch of syncPlan.patches) {
        await fetchJson(`${API_URL}/api/tournament-teams/${patch.id}`, {
          method: "PATCH",
          headers: authHeaders(true),
          body: JSON.stringify(patch.payload),
        });
      }

      if (syncPlan.creates.length > 0) {
        await fetchJson(`${API_URL}/api/tournaments/${selectedTournamentId}/teams`, {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify(syncPlan.creates),
        });
      }

      for (const teamId of syncPlan.deletes) {
        await fetchJson(`${API_URL}/api/tournament-teams/${teamId}`, {
          method: "DELETE",
          headers: authHeaders(),
        });
      }

      await loadSelectedTournament(selectedTournamentId);
      setTeamsMessage("Team changes saved.");
      onShowToast?.("success", "Tournament teams updated");
    } catch (error) {
      const message = error?.message || "Unable to save team changes";
      setTeamsError(message);
      onShowToast?.("error", message);
      await loadSelectedTournament(selectedTournamentId);
    } finally {
      setTeamsSaving(false);
    }
  };

  if (!user || !token) {
    return (
      <section className="tournaments-auth-card">
        <h2 className="secondary-title">Tournaments</h2>
        <p className="subtle">Sign in to create tournaments, manage teams, and open admin stages.</p>
        <a className="primary-button" href="/?mode=signin">
          Sign in to manage tournaments
        </a>
      </section>
    );
  }

  return (
    <div className="tournaments-panel">
      <div className="tournaments-layout">
        <section className="tournaments-card tournaments-create-card">
          <h2 className="secondary-title">Create Tournament</h2>
          <p className="subtle">Start a new tournament and jump directly into Pool Play 1 setup.</p>
          <form className="tournaments-form" onSubmit={handleCreateTournament}>
            <label className="input-label" htmlFor="tournament-name">
              Tournament name
            </label>
            <input
              id="tournament-name"
              type="text"
              placeholder="Spring Classic"
              required
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
            />

            <label className="input-label" htmlFor="tournament-date">
              Tournament date
            </label>
            <input
              id="tournament-date"
              type="date"
              required
              value={createDate}
              onChange={(event) => setCreateDate(event.target.value)}
            />

            {createError && <p className="error">{createError}</p>}

            <button className="primary-button" type="submit" disabled={createBusy}>
              {createBusy ? "Creating..." : "Create tournament"}
            </button>
          </form>
        </section>

        <section className="tournaments-card tournaments-list-card">
          <div className="tournaments-list-header">
            <h2 className="secondary-title">Your Tournaments</h2>
            <button
              className="ghost-button"
              type="button"
              onClick={() => loadTournaments({ preferredTournamentId: selectedTournamentId })}
              disabled={tournamentsLoading}
            >
              {tournamentsLoading ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          {tournamentsError && <p className="error">{tournamentsError}</p>}
          {tournamentsLoading && tournaments.length === 0 && <p className="subtle">Loading tournaments...</p>}
          {!tournamentsLoading && tournaments.length === 0 && (
            <p className="subtle">No tournaments yet. Create one to get started.</p>
          )}

          {tournaments.length > 0 && (
            <div className="tournament-list">
              {tournaments.map((tournament) => {
                const id = tournament?._id ? String(tournament._id) : "";
                const isSelected = id === selectedTournamentId;

                return (
                  <article
                    key={id || tournament?.publicCode || tournament?.name}
                    className={`tournament-list-item ${isSelected ? "is-selected" : ""}`}
                  >
                    <button
                      type="button"
                      className="tournament-select-button"
                      onClick={() => selectTournament(id)}
                    >
                      <span className="tournament-select-name">
                        {tournament?.name || "Untitled tournament"}
                      </span>
                      <span className="tournament-select-meta">
                        {formatDateLabel(tournament?.date)} · {formatStatusLabel(tournament?.status)}
                      </span>
                      <span className="tournament-select-code">
                        Code {tournament?.publicCode || "------"}
                      </span>
                    </button>

                    <div className="tournament-list-actions">
                      <a className="secondary-button" href={`/tournaments/${id}/phase1`}>
                        Pool Play 1
                      </a>
                      <a className="secondary-button" href={`/tournaments/${id}/phase2`}>
                        Pool Play 2
                      </a>
                      <a className="secondary-button" href={`/tournaments/${id}/playoffs`}>
                        Playoffs
                      </a>
                      <a
                        className="secondary-button"
                        href={`/t/${tournament?.publicCode || ""}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Public View
                      </a>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <section className="tournaments-card tournaments-team-card">
        <div className="tournaments-team-header">
          <div>
            <h2 className="secondary-title">Team Setup</h2>
            {selectedTournament ? (
              <p className="subtle">
                {selectedTournament?.name || "Tournament"} · Status{" "}
                <strong>{formatStatusLabel(selectedTournament?.status)}</strong>
              </p>
            ) : (
              <p className="subtle">Select a tournament to manage teams.</p>
            )}
          </div>
          <div className="tournaments-team-actions">
            <button
              type="button"
              className="ghost-button"
              onClick={addTeamRow}
              disabled={!selectedTournament || !canEditTeams || teamsSaving}
            >
              Add team
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={handleSaveTeams}
              disabled={!selectedTournament || !canEditTeams || teamsSaving}
            >
              {teamsSaving ? "Saving..." : "Save team changes"}
            </button>
          </div>
        </div>

        {selectedTournament && !canEditTeams && (
          <p className="subtle tournaments-lock-message">
            Team edits are locked because this tournament is in{" "}
            <strong>{formatStatusLabel(selectedTournament?.status)}</strong> status.
          </p>
        )}

        {teamWarnings.length > 0 && (
          <div className="tournaments-team-warnings">
            {teamWarnings.map((warning) => (
              <p key={warning} className="subtle tournaments-team-warning">
                {warning}
              </p>
            ))}
          </div>
        )}

        {teamsLoading && <p className="subtle">Loading teams...</p>}
        {teamsError && <p className="error">{teamsError}</p>}
        {teamsMessage && <p className="subtle tournaments-team-success">{teamsMessage}</p>}

        {!teamsLoading && selectedTournament && teamRows.length === 0 && (
          <p className="subtle">No teams yet. Add teams and save to begin.</p>
        )}

        {selectedTournament && teamRows.length > 0 && (
          <div className="tournament-team-grid">
            {teamRows.map((team, index) => (
              <div key={team.rowId} className="tournament-team-row">
                <div className="tournament-team-row-fields">
                  <label className="input-label" htmlFor={`team-name-${team.rowId}`}>
                    Team name {index + 1}
                  </label>
                  <input
                    id={`team-name-${team.rowId}`}
                    type="text"
                    value={team.name}
                    disabled={!canEditTeams || teamsSaving}
                    onChange={(event) => updateTeamRow(team.rowId, "name", event.target.value)}
                  />
                </div>

                <div className="tournament-team-row-fields">
                  <label className="input-label" htmlFor={`team-short-${team.rowId}`}>
                    Short name {index + 1}
                  </label>
                  <input
                    id={`team-short-${team.rowId}`}
                    type="text"
                    value={team.shortName}
                    disabled={!canEditTeams || teamsSaving}
                    onChange={(event) => updateTeamRow(team.rowId, "shortName", event.target.value)}
                  />
                </div>

                <div className="tournament-team-row-fields tournament-team-row-fields--seed">
                  <label className="input-label" htmlFor={`team-seed-${team.rowId}`}>
                    Seed
                  </label>
                  <input
                    id={`team-seed-${team.rowId}`}
                    type="number"
                    min="1"
                    step="1"
                    value={team.seed}
                    disabled={!canEditTeams || teamsSaving}
                    onChange={(event) => updateTeamRow(team.rowId, "seed", event.target.value)}
                  />
                </div>

                <button
                  type="button"
                  className="ghost-button tournament-team-remove"
                  disabled={!canEditTeams || teamsSaving}
                  onClick={() => removeTeamRow(team.rowId)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default TournamentsTab;

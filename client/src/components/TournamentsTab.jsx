import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DndContext, PointerSensor, TouchSensor, KeyboardSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { API_URL } from "../config/env.js";
import TournamentDatePicker from "./TournamentDatePicker.jsx";

const DEFAULT_TIMEZONE = "America/New_York";

const resolveTimezone = () => {
  if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function") {
    return DEFAULT_TIMEZONE;
  }

  const timezone = Intl.DateTimeFormat().resolvedOptions()?.timeZone;
  return typeof timezone === "string" && timezone.trim() ? timezone : DEFAULT_TIMEZONE;
};

const normalizeText = (value) => (typeof value === "string" ? value.trim() : "");

const parseUsDateInput = (value) => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(trimmed);

  if (!match) {
    return null;
  }

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);

  if (!Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(year)) {
    return null;
  }

  const parsed = new Date(year, month - 1, day);

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== year ||
    parsed.getMonth() + 1 !== month ||
    parsed.getDate() !== day
  ) {
    return null;
  }

  return parsed;
};

const toIsoDateString = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const normalizeLogoUrl = (value) => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const formatDateLabel = (value) => {
  if (!value) {
    return "No date";
  }

  if (typeof value === "string") {
    const datePartMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());

    if (datePartMatch) {
      const year = Number(datePartMatch[1]);
      const month = Number(datePartMatch[2]);
      const day = Number(datePartMatch[3]);
      const utcDate = new Date(Date.UTC(year, month - 1, day));

      if (!Number.isNaN(utcDate.getTime())) {
        return new Intl.DateTimeFormat(undefined, { timeZone: "UTC" }).format(utcDate);
      }
    }
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "No date";
  }

  return new Intl.DateTimeFormat(undefined, { timeZone: "UTC" }).format(parsed);
};

const formatStatusLabel = (value) => {
  if (!value) {
    return "setup";
  }

  return String(value)
    .replaceAll("_", " ")
    .replace(/(^|\s)\S/g, (char) => char.toUpperCase());
};

const reorderRows = (rows, activeId, overId) => {
  const sourceIndex = rows.findIndex((row) => row.rowId === activeId);
  const targetIndex = rows.findIndex((row) => row.rowId === overId);

  if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
    return null;
  }

  return arrayMove(rows, sourceIndex, targetIndex);
};

function SortableTeamCard({ team, index, disabled, onUpdate, onRemove }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: team.rowId,
    disabled,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`tournament-team-card ${isDragging ? "is-dragging" : ""}`}
    >
      <div className="tournament-team-card-header">
        <div className="tournament-team-card-rank">#{index + 1}</div>
        <button
          type="button"
          className="tournament-team-drag-handle"
          aria-label={`Drag team ${index + 1}`}
          disabled={disabled}
          {...attributes}
          {...listeners}
        >
          Drag
        </button>
      </div>

      <div className="tournament-team-card-fields-row">
        <div className="tournament-team-card-fields">
          <label className="input-label" htmlFor={`team-name-${team.rowId}`}>
            Team name
          </label>
          <input
            id={`team-name-${team.rowId}`}
            type="text"
            value={team.name}
            disabled={disabled}
            onChange={(event) => onUpdate(team.rowId, "name", event.target.value)}
          />
        </div>

        <div className="tournament-team-card-fields">
          <label className="input-label" htmlFor={`team-logo-${team.rowId}`}>
            Logo URL (optional)
          </label>
          <input
            id={`team-logo-${team.rowId}`}
            type="text"
            value={team.logoUrl}
            disabled={disabled}
            onChange={(event) => onUpdate(team.rowId, "logoUrl", event.target.value)}
          />
        </div>

        <button
          type="button"
          className="ghost-button tournament-team-remove"
          disabled={disabled}
          onClick={() => onRemove(team.rowId)}
        >
          Remove
        </button>
      </div>

      {normalizeLogoUrl(team.logoUrl) && (
        <div className="tournament-team-logo-preview">
          <img src={team.logoUrl} alt={`${team.name || team.shortName || "Team"} logo`} />
        </div>
      )}
    </article>
  );
}

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
  const [newTeamName, setNewTeamName] = useState("");
  const [newTeamLogoUrl, setNewTeamLogoUrl] = useState("");
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [teamsSaving, setTeamsSaving] = useState(false);
  const [teamCreateBusy, setTeamCreateBusy] = useState(false);
  const [teamOrderSaving, setTeamOrderSaving] = useState(false);
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
      name: team?.name || team?.shortName || "",
      shortName: team?.shortName || team?.name || "",
      logoUrl: typeof team?.logoUrl === "string" ? team.logoUrl : "",
      orderIndex: Number.isFinite(Number(team?.orderIndex)) ? Number(team.orderIndex) : null,
    }),
    [makeRowId]
  );

  const dragSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 160, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
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
              name: team?.name || team?.shortName || "",
              shortName: team?.shortName || team?.name || "",
              logoUrl: typeof team?.logoUrl === "string" ? team.logoUrl : "",
              orderIndex: Number.isFinite(Number(team?.orderIndex))
                ? Number(team.orderIndex)
                : null,
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
    setNewTeamName("");
    setNewTeamLogoUrl("");
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
      warnings.push("Pool auto-fill uses the first 15 teams by card order.");
    }
    return warnings;
  }, [currentTeamCount, selectedTournament]);

  const selectTournament = (nextId) => {
    const cleaned = typeof nextId === "string" ? nextId.trim() : "";
    setSelectedTournamentId(cleaned);
  };

  const updateTeamRow = (rowId, field, value) => {
    if (!canEditTeams || teamsSaving || teamOrderSaving) {
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

  const handleAddTeam = async () => {
    if (!token || !selectedTournamentId || !canEditTeams || teamsSaving || teamCreateBusy) {
      return;
    }

    const name = normalizeText(newTeamName);
    const logoUrl = normalizeLogoUrl(newTeamLogoUrl);
    if (!name) {
      setTeamsError("Team name is required to add a team.");
      return;
    }

    setTeamCreateBusy(true);
    setTeamsError("");
    setTeamsMessage("");

    try {
      const payload = {
        name,
        shortName: name,
      };
      if (logoUrl !== null) {
        payload.logoUrl = logoUrl;
      }

      await fetchJson(`${API_URL}/api/tournaments/${selectedTournamentId}/teams`, {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify(payload),
      });
      await loadSelectedTournament(selectedTournamentId);
      setNewTeamName("");
      setNewTeamLogoUrl("");
      setTeamsMessage("Team added.");
      onShowToast?.("success", "Team added");
    } catch (error) {
      const message = error?.message || "Unable to add team";
      setTeamsError(message);
      onShowToast?.("error", message);
    } finally {
      setTeamCreateBusy(false);
    }
  };

  const removeTeamRow = async (rowId) => {
    if (!token || !canEditTeams || teamsSaving || teamOrderSaving) {
      return;
    }

    const row = teamRows.find((team) => team.rowId === rowId);
    if (!row?._id) {
      return;
    }

    setTeamsError("");
    setTeamsMessage("");

    try {
      await fetchJson(`${API_URL}/api/tournament-teams/${row._id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      await loadSelectedTournament(selectedTournamentId);
      setTeamsMessage("Team removed.");
      onShowToast?.("success", "Team removed");
    } catch (error) {
      const message = error?.message || "Unable to remove team";
      setTeamsError(message);
      onShowToast?.("error", message);
    }
  };

  const persistTeamOrder = useCallback(
    async (rows) => {
      const orderedTeamIds = rows.map((row) => row._id).filter(Boolean);
      await fetchJson(`${API_URL}/api/tournaments/${selectedTournamentId}/teams/order`, {
        method: "PUT",
        headers: authHeaders(true),
        body: JSON.stringify({ orderedTeamIds }),
      });
      setTeamsInitial((previous) => {
        const byId = new Map(previous.map((row) => [String(row._id), row]));
        return orderedTeamIds
          .map((teamId, index) => {
            const existing = byId.get(teamId);
            if (!existing) {
              return null;
            }

            return {
              ...existing,
              orderIndex: index + 1,
            };
          })
          .filter(Boolean);
      });
    },
    [authHeaders, fetchJson, selectedTournamentId]
  );

  const handleTeamDragEnd = useCallback(
    async (event) => {
      if (!canEditTeams || teamsSaving || teamOrderSaving) {
        return;
      }

      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }

      const previousRows = teamRows;
      const nextRows = reorderRows(previousRows, active.id, over.id);

      if (!nextRows) {
        return;
      }

      setTeamRows(nextRows);
      setTeamsError("");
      setTeamsMessage("");
      setTeamOrderSaving(true);

      try {
        await persistTeamOrder(nextRows);
        setTeamsMessage("Team order saved.");
      } catch (error) {
        setTeamRows(previousRows);
        setTeamsError(error?.message || "Unable to save team order");
      } finally {
        setTeamOrderSaving(false);
      }
    },
    [canEditTeams, persistTeamOrder, teamOrderSaving, teamRows, teamsSaving]
  );

  const handleCreateTournament = async (event) => {
    event.preventDefault();

    if (!token || createBusy) {
      return;
    }

    const parsedDate = parseUsDateInput(createDate);
    if (!parsedDate) {
      setCreateError("Tournament date must use MM-DD-YYYY.");
      return;
    }

    setCreateBusy(true);
    setCreateError("");

    const payload = {
      name: normalizeText(createName),
      date: toIsoDateString(parsedDate),
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
    if (!token || !selectedTournamentId || !canEditTeams || teamsSaving || teamOrderSaving) {
      return;
    }

    for (let index = 0; index < teamRows.length; index += 1) {
      const row = teamRows[index];
      const name = normalizeText(row?.name || row?.shortName);

      if (!name) {
        setTeamsError(`Team ${index + 1} must include a team name.`);
        return;
      }
    }

    const initialById = new Map(
      teamsInitial
        .filter((team) => team?._id)
        .map((team) => [String(team._id), team])
    );

    const patches = teamRows
      .filter((row) => row?._id && initialById.has(String(row._id)))
      .map((row) => {
        const id = String(row._id);
        const previous = initialById.get(id);
        const payload = {};
        const nextName = normalizeText(row?.name || row?.shortName);
        const previousName = normalizeText(previous?.name || previous?.shortName);
        const previousShortName = normalizeText(previous?.shortName || previous?.name);
        const nextLogoUrl = normalizeLogoUrl(row.logoUrl);
        const previousLogoUrl = normalizeLogoUrl(previous?.logoUrl);

        if (nextName !== previousName || nextName !== previousShortName) {
          payload.name = nextName;
          payload.shortName = nextName;
        }

        if (nextLogoUrl !== previousLogoUrl) {
          payload.logoUrl = nextLogoUrl;
        }

        return {
          id,
          payload,
        };
      })
      .filter((patch) => Object.keys(patch.payload).length > 0);

    if (patches.length === 0) {
      setTeamsMessage("No team field changes to save.");
      setTeamsError("");
      return;
    }

    setTeamsSaving(true);
    setTeamsError("");
    setTeamsMessage("");

    try {
      for (const patch of patches) {
        await fetchJson(`${API_URL}/api/tournament-teams/${patch.id}`, {
          method: "PATCH",
          headers: authHeaders(true),
          body: JSON.stringify(patch.payload),
        });
      }

      await loadSelectedTournament(selectedTournamentId);
      setTeamsMessage("Team field changes saved.");
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

  const teamEditDisabled = !canEditTeams || teamsSaving || teamOrderSaving;

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
            <TournamentDatePicker
              id="tournament-date"
              value={createDate}
              required
              disabled={createBusy}
              onChange={setCreateDate}
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
              onClick={handleSaveTeams}
              disabled={!selectedTournament || !canEditTeams || teamsSaving || teamOrderSaving}
            >
              {teamsSaving ? "Saving..." : "Save team fields"}
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
        {teamOrderSaving && <p className="subtle">Saving team order...</p>}
        {teamsError && <p className="error">{teamsError}</p>}
        {teamsMessage && <p className="subtle tournaments-team-success">{teamsMessage}</p>}

        {selectedTournament && (
          <div className="tournament-team-add-row">
            <div className="tournament-team-card-fields">
              <label className="input-label" htmlFor="team-add-name">
                New team name
              </label>
              <input
                id="team-add-name"
                type="text"
                value={newTeamName}
                disabled={teamEditDisabled || teamCreateBusy}
                onChange={(event) => setNewTeamName(event.target.value)}
                placeholder="ODU"
              />
            </div>
            <div className="tournament-team-card-fields">
              <label className="input-label" htmlFor="team-add-logo">
                Logo URL (optional)
              </label>
              <input
                id="team-add-logo"
                type="text"
                value={newTeamLogoUrl}
                disabled={teamEditDisabled || teamCreateBusy}
                onChange={(event) => setNewTeamLogoUrl(event.target.value)}
                placeholder="https://..."
              />
            </div>
            <button
              type="button"
              className="primary-button"
              onClick={handleAddTeam}
              disabled={!selectedTournament || teamEditDisabled || teamCreateBusy}
            >
              {teamCreateBusy ? "Adding..." : "Add Team"}
            </button>
          </div>
        )}

        {!teamsLoading && selectedTournament && teamRows.length === 0 && (
          <p className="subtle">No teams yet. Add a team to begin.</p>
        )}

        {selectedTournament && teamRows.length > 0 && (
          <DndContext
            sensors={dragSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleTeamDragEnd}
          >
            <SortableContext
              items={teamRows.map((team) => team.rowId)}
              strategy={verticalListSortingStrategy}
            >
              <div className="tournament-team-grid">
                {teamRows.map((team, index) => (
                  <SortableTeamCard
                    key={team.rowId}
                    team={team}
                    index={index}
                    disabled={teamEditDisabled}
                    onUpdate={updateTeamRow}
                    onRemove={removeTeamRow}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </section>
    </div>
  );
}

export default TournamentsTab;

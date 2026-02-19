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
const TOURNAMENT_DETAILS_MAP_SLOTS = 3;
const TOURNAMENT_DETAILS_DEFAULTS = Object.freeze({
  specialNotes: "",
  foodInfo: {
    text: "",
    linkUrl: "",
  },
  facilitiesInfo: "",
  parkingInfo: "",
  mapImageUrls: [],
});
const TOURNAMENT_SHARE_LINK_DEFAULTS = Object.freeze({
  enabled: false,
  role: "admin",
  hasLink: false,
  joinPath: "",
  joinUrl: "",
});

const resolveTimezone = () => {
  if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function") {
    return DEFAULT_TIMEZONE;
  }

  const timezone = Intl.DateTimeFormat().resolvedOptions()?.timeZone;
  return typeof timezone === "string" && timezone.trim() ? timezone : DEFAULT_TIMEZONE;
};

const normalizeText = (value) => (typeof value === "string" ? value.trim() : "");
const normalizeDetailText = (value) => (typeof value === "string" ? value : "");
const normalizeDetailUrl = (value) => {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
};
const normalizeTournamentDetails = (details) => {
  const source = details && typeof details === "object" ? details : {};
  const foodInfo = source.foodInfo && typeof source.foodInfo === "object" ? source.foodInfo : {};
  const mapImageUrls = Array.isArray(source.mapImageUrls) ? source.mapImageUrls : [];

  return {
    specialNotes:
      typeof source.specialNotes === "string"
        ? source.specialNotes
        : TOURNAMENT_DETAILS_DEFAULTS.specialNotes,
    foodInfo: {
      text:
        typeof foodInfo.text === "string"
          ? foodInfo.text
          : TOURNAMENT_DETAILS_DEFAULTS.foodInfo.text,
      linkUrl:
        typeof foodInfo.linkUrl === "string"
          ? foodInfo.linkUrl
          : TOURNAMENT_DETAILS_DEFAULTS.foodInfo.linkUrl,
    },
    facilitiesInfo:
      typeof source.facilitiesInfo === "string"
        ? source.facilitiesInfo
        : TOURNAMENT_DETAILS_DEFAULTS.facilitiesInfo,
    parkingInfo:
      typeof source.parkingInfo === "string"
        ? source.parkingInfo
        : TOURNAMENT_DETAILS_DEFAULTS.parkingInfo,
    mapImageUrls: mapImageUrls
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim())
      .slice(0, TOURNAMENT_DETAILS_MAP_SLOTS),
  };
};
const buildMapImageSlots = (mapImageUrls = []) => {
  const slots = Array.isArray(mapImageUrls)
    ? mapImageUrls
        .filter((entry) => typeof entry === "string")
        .map((entry) => entry.trim())
        .slice(0, TOURNAMENT_DETAILS_MAP_SLOTS)
    : [];

  while (slots.length < TOURNAMENT_DETAILS_MAP_SLOTS) {
    slots.push("");
  }

  return slots;
};
const createDetailsDraft = (details) => {
  const normalized = normalizeTournamentDetails(details);
  return {
    specialNotes: normalized.specialNotes,
    facilitiesInfo: normalized.facilitiesInfo,
    parkingInfo: normalized.parkingInfo,
    foodText: normalized.foodInfo.text,
    foodLinkUrl: normalized.foodInfo.linkUrl,
    mapImageSlots: buildMapImageSlots(normalized.mapImageUrls),
  };
};
const normalizeShareLinkPayload = (shareLink) => {
  const source = shareLink && typeof shareLink === "object" ? shareLink : {};
  return {
    enabled: Boolean(source.enabled),
    role: typeof source.role === "string" && source.role.trim() ? source.role.trim() : "admin",
    hasLink: Boolean(source.hasLink),
    joinPath: typeof source.joinPath === "string" ? source.joinPath : "",
    joinUrl: typeof source.joinUrl === "string" ? source.joinUrl : "",
  };
};

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

const normalizeTeamLocationRecord = (location) => {
  const source = location && typeof location === "object" ? location : {};
  const toNullableCoordinate = (value) => {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return {
    label: typeof source.label === "string" ? source.label : "",
    latitude: toNullableCoordinate(source.latitude),
    longitude: toNullableCoordinate(source.longitude),
  };
};

const buildTeamLocationPayload = ({ label }) => {
  const normalizedLabel = normalizeText(label);

  return {
    location: {
      label: normalizedLabel,
      latitude: null,
      longitude: null,
    },
    hasAnyInput: Boolean(normalizedLabel),
    error: "",
  };
};

const areTeamLocationsEqual = (left, right) => {
  const normalizedLeft = normalizeTeamLocationRecord(left);
  const normalizedRight = normalizeTeamLocationRecord(right);

  return (
    normalizedLeft.label === normalizedRight.label &&
    normalizedLeft.latitude === normalizedRight.latitude &&
    normalizedLeft.longitude === normalizedRight.longitude
  );
};

const toAbsoluteUrl = (value) => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return "";
  }

  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  if (typeof window === "undefined" || !window.location?.origin) {
    return raw;
  }

  return `${window.location.origin}${raw.startsWith("/") ? "" : "/"}${raw}`;
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

function SortableTeamCard({
  team,
  index,
  rosterDisabled,
  nameDisabled,
  assetsDisabled,
  onUpdate,
  onRemove,
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: team.rowId,
    disabled: rosterDisabled,
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
          disabled={rosterDisabled}
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
            disabled={nameDisabled}
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
            disabled={assetsDisabled}
            onChange={(event) => onUpdate(team.rowId, "logoUrl", event.target.value)}
          />
        </div>

        <button
          type="button"
          className="ghost-button tournament-team-remove"
          disabled={rosterDisabled}
          onClick={() => onRemove(team.rowId)}
        >
          Remove
        </button>
      </div>

      <div className="tournament-team-card-fields-row tournament-team-card-fields-row--location">
        <div className="tournament-team-card-fields">
          <label className="input-label" htmlFor={`team-location-label-${team.rowId}`}>
            Location label (optional)
          </label>
          <input
            id={`team-location-label-${team.rowId}`}
            type="text"
            value={team.locationLabel || ""}
            disabled={assetsDisabled}
            onChange={(event) => onUpdate(team.rowId, "locationLabel", event.target.value)}
            placeholder="Norfolk, VA"
          />
        </div>
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
  mode = "hub",
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
  const [detailsDraft, setDetailsDraft] = useState(() => createDetailsDraft());
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [detailsMessage, setDetailsMessage] = useState("");
  const [teamsInitial, setTeamsInitial] = useState([]);
  const [teamRows, setTeamRows] = useState([]);
  const [newTeamName, setNewTeamName] = useState("");
  const [newTeamLogoUrl, setNewTeamLogoUrl] = useState("");
  const [newTeamLocationLabel, setNewTeamLocationLabel] = useState("");
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [teamsSaving, setTeamsSaving] = useState(false);
  const [teamCreateBusy, setTeamCreateBusy] = useState(false);
  const [teamOrderSaving, setTeamOrderSaving] = useState(false);
  const [teamsError, setTeamsError] = useState("");
  const [teamsMessage, setTeamsMessage] = useState("");
  const [teamLinks, setTeamLinks] = useState([]);
  const [teamLinksLoading, setTeamLinksLoading] = useState(false);
  const [teamLinksError, setTeamLinksError] = useState("");
  const [teamLinkActionTeamId, setTeamLinkActionTeamId] = useState("");
  const [copiedTeamLinkTeamId, setCopiedTeamLinkTeamId] = useState("");
  const [accessOwner, setAccessOwner] = useState(null);
  const [accessAdmins, setAccessAdmins] = useState([]);
  const [pendingInvites, setPendingInvites] = useState([]);
  const [shareLinkInfo, setShareLinkInfo] = useState(() => TOURNAMENT_SHARE_LINK_DEFAULTS);
  const [sharingLoading, setSharingLoading] = useState(false);
  const [sharingError, setSharingError] = useState("");
  const [sharingMessage, setSharingMessage] = useState("");
  const [shareEmailInput, setShareEmailInput] = useState("");
  const [sharingActionBusy, setSharingActionBusy] = useState("");
  const [copiedShareLink, setCopiedShareLink] = useState(false);
  const [lastInviteLink, setLastInviteLink] = useState("");
  const [deletingTournamentId, setDeletingTournamentId] = useState("");
  const normalizedMode =
    mode === "details" || mode === "teams" ? mode : "hub";
  const showCreateCard = normalizedMode === "hub";
  const showDetailsSection = normalizedMode === "details";
  const showTeamsSection = normalizedMode === "teams";

  const makeRowId = useCallback(() => {
    rowCounterRef.current += 1;
    return `team-row-${rowCounterRef.current}`;
  }, []);

  const toDraftRow = useCallback(
    (team = {}) => {
      const location = normalizeTeamLocationRecord(team?.location);
      return {
        rowId: makeRowId(),
        _id: team?._id ? String(team._id) : "",
        name: team?.name || team?.shortName || "",
        shortName: team?.shortName || team?.name || "",
        logoUrl: typeof team?.logoUrl === "string" ? team.logoUrl : "",
        locationLabel: location.label,
        orderIndex: Number.isFinite(Number(team?.orderIndex)) ? Number(team.orderIndex) : null,
      };
    },
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

  const loadTeamLinks = useCallback(
    async (tournamentId) => {
      const normalizedId = typeof tournamentId === "string" ? tournamentId.trim() : "";

      if (!token || !normalizedId) {
        return [];
      }

      const payload = await fetchJson(`${API_URL}/api/tournaments/${normalizedId}/teams/links`, {
        headers: authHeaders(),
      });

      return Array.isArray(payload)
        ? payload.map((entry) => ({
            teamId: entry?.teamId ? String(entry.teamId) : "",
            shortName: entry?.shortName || "TBD",
            publicTeamCode: entry?.publicTeamCode || "",
            teamLinkUrl: toAbsoluteUrl(entry?.teamLinkUrl || ""),
          }))
        : [];
    },
    [authHeaders, fetchJson, token]
  );

  const refreshSharingAccess = useCallback(
    async ({ tournamentId, showLoading = true } = {}) => {
      const normalizedId =
        typeof tournamentId === "string" && tournamentId.trim()
          ? tournamentId.trim()
          : selectedTournamentId;

      if (!token || !normalizedId) {
        setAccessOwner(null);
        setAccessAdmins([]);
        setPendingInvites([]);
        setShareLinkInfo(TOURNAMENT_SHARE_LINK_DEFAULTS);
        setSharingError("");
        setSharingLoading(false);
        return null;
      }

      if (showLoading) {
        setSharingLoading(true);
      }

      try {
        const payload = await fetchJson(`${API_URL}/api/tournaments/${normalizedId}/access`, {
          headers: authHeaders(),
        });

        setAccessOwner(payload?.owner || null);
        setAccessAdmins(Array.isArray(payload?.admins) ? payload.admins : []);
        setPendingInvites(Array.isArray(payload?.pendingInvites) ? payload.pendingInvites : []);
        setShareLinkInfo(normalizeShareLinkPayload(payload?.shareLink));
        setSharingError("");
        setSelectedTournament((current) => {
          if (!current || String(current?._id || "") !== normalizedId) {
            return current;
          }

          return {
            ...current,
            accessRole: payload?.callerRole || current.accessRole,
            isOwner: Boolean(payload?.isOwner),
          };
        });

        return payload;
      } catch (error) {
        setAccessOwner(null);
        setAccessAdmins([]);
        setPendingInvites([]);
        setShareLinkInfo(TOURNAMENT_SHARE_LINK_DEFAULTS);
        setSharingError(error?.message || "Unable to load sharing access");
        return null;
      } finally {
        if (showLoading) {
          setSharingLoading(false);
        }
      }
    },
    [authHeaders, fetchJson, selectedTournamentId, token]
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
        setDetailsDraft(createDetailsDraft());
        setDetailsError("");
        setDetailsMessage("");
        setTeamsInitial([]);
        setTeamRows([]);
        setTeamLinks([]);
        setTeamLinksError("");
        setTeamLinksLoading(false);
        setTeamsLoading(false);
        setAccessOwner(null);
        setAccessAdmins([]);
        setPendingInvites([]);
        setShareLinkInfo(TOURNAMENT_SHARE_LINK_DEFAULTS);
        setSharingLoading(false);
        setSharingError("");
        setSharingMessage("");
        setShareEmailInput("");
        setSharingActionBusy("");
        setCopiedShareLink(false);
        setLastInviteLink("");
        return;
      }

      setTeamsLoading(true);
      setTeamsError("");
      setTeamLinksLoading(true);
      setTeamLinksError("");

      try {
        const [tournamentPayload, teamsPayload] = await Promise.all([
          fetchJson(`${API_URL}/api/tournaments/${normalizedId}`, {
            headers: authHeaders(),
          }),
          fetchJson(`${API_URL}/api/tournaments/${normalizedId}/teams`, {
            headers: authHeaders(),
          }),
        ]);
        let linksPayload = [];

        try {
          linksPayload = await loadTeamLinks(normalizedId);
          setTeamLinksError("");
        } catch (linkError) {
          linksPayload = [];
          setTeamLinksError(linkError?.message || "Unable to load team links");
        }

        await refreshSharingAccess({ tournamentId: normalizedId });

        const normalizedTeams = Array.isArray(teamsPayload)
          ? teamsPayload.map((team) => ({
              _id: team?._id ? String(team._id) : "",
              name: team?.name || team?.shortName || "",
              shortName: team?.shortName || team?.name || "",
              logoUrl: typeof team?.logoUrl === "string" ? team.logoUrl : "",
              location: normalizeTeamLocationRecord(team?.location),
              orderIndex: Number.isFinite(Number(team?.orderIndex))
                ? Number(team.orderIndex)
                : null,
            }))
          : [];

        setSelectedTournament(tournamentPayload || null);
        setDetailsDraft(createDetailsDraft(tournamentPayload?.details));
        setDetailsError("");
        setDetailsMessage("");
        setTeamsInitial(normalizedTeams);
        setTeamRows(normalizedTeams.map((team) => toDraftRow(team)));
        setTeamLinks(linksPayload);
      } catch (error) {
        setSelectedTournament(null);
        setDetailsDraft(createDetailsDraft());
        setDetailsError("");
        setDetailsMessage("");
        setTeamsInitial([]);
        setTeamRows([]);
        setTeamLinks([]);
        setTeamLinksError("");
        setAccessOwner(null);
        setAccessAdmins([]);
        setPendingInvites([]);
        setShareLinkInfo(TOURNAMENT_SHARE_LINK_DEFAULTS);
        setSharingLoading(false);
        setSharingError("");
        setSharingMessage("");
        setShareEmailInput("");
        setSharingActionBusy("");
        setCopiedShareLink(false);
        setLastInviteLink("");
        setTeamsError(error?.message || "Unable to load tournament teams");
      } finally {
        setTeamsLoading(false);
        setTeamLinksLoading(false);
      }
    },
    [authHeaders, fetchJson, loadTeamLinks, refreshSharingAccess, toDraftRow, token]
  );

  useEffect(() => {
    if (!user || !token) {
      setTournaments([]);
      setSelectedTournamentId("");
      setSelectedTournament(null);
      setDetailsDraft(createDetailsDraft());
      setDetailsSaving(false);
      setDetailsError("");
      setDetailsMessage("");
      setTeamsInitial([]);
      setTeamRows([]);
      setTeamLinks([]);
      setTeamLinksError("");
      setTeamLinksLoading(false);
      setTeamLinkActionTeamId("");
      setCopiedTeamLinkTeamId("");
      setAccessOwner(null);
      setAccessAdmins([]);
      setPendingInvites([]);
      setShareLinkInfo(TOURNAMENT_SHARE_LINK_DEFAULTS);
      setSharingLoading(false);
      setSharingError("");
      setSharingMessage("");
      setShareEmailInput("");
      setSharingActionBusy("");
      setCopiedShareLink(false);
      setLastInviteLink("");
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
    setDetailsError("");
    setDetailsMessage("");
    setNewTeamName("");
    setNewTeamLogoUrl("");
    setNewTeamLocationLabel("");
    setCopiedTeamLinkTeamId("");
    setTeamLinkActionTeamId("");
    setSharingMessage("");
    setSharingError("");
    setShareEmailInput("");
    setSharingActionBusy("");
    setCopiedShareLink(false);
    setLastInviteLink("");
    if (normalizedMode === "hub") {
      setSelectedTournament(null);
      setDetailsDraft(createDetailsDraft());
      setTeamsInitial([]);
      setTeamRows([]);
      setTeamLinks([]);
      setTeamLinksError("");
      setTeamLinksLoading(false);
      setTeamsLoading(false);
      setAccessOwner(null);
      setAccessAdmins([]);
      setPendingInvites([]);
      setShareLinkInfo(TOURNAMENT_SHARE_LINK_DEFAULTS);
      setSharingLoading(false);
      return;
    }

    loadSelectedTournament(selectedTournamentId);
  }, [loadSelectedTournament, normalizedMode, selectedTournamentId]);

  const canEditTeamRoster = selectedTournament?.status === "setup";
  const canEditTeamNames = selectedTournament?.status === "setup";
  const canEditTeamAssets = Boolean(selectedTournament);
  const selectedTournamentRole = selectedTournament?.accessRole || (selectedTournament?.isOwner ? "owner" : "admin");
  const selectedTournamentIsOwner = selectedTournamentRole === "owner";
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
  const detailsPreviewUrls = useMemo(
    () =>
      detailsDraft.mapImageSlots
        .map((entry) => normalizeDetailUrl(entry))
        .filter(Boolean)
        .slice(0, TOURNAMENT_DETAILS_MAP_SLOTS),
    [detailsDraft.mapImageSlots]
  );

  const selectTournament = (nextId) => {
    const cleaned = typeof nextId === "string" ? nextId.trim() : "";
    setSelectedTournamentId(cleaned);
  };

  const refreshTeamLinks = useCallback(
    async ({ tournamentId, showLoading = true } = {}) => {
      const normalizedId =
        typeof tournamentId === "string" && tournamentId.trim()
          ? tournamentId.trim()
          : selectedTournamentId;

      if (!normalizedId || !token) {
        setTeamLinks([]);
        setTeamLinksError("");
        setTeamLinksLoading(false);
        return [];
      }

      if (showLoading) {
        setTeamLinksLoading(true);
      }

      try {
        const links = await loadTeamLinks(normalizedId);
        setTeamLinks(links);
        setTeamLinksError("");
        return links;
      } catch (error) {
        setTeamLinks([]);
        setTeamLinksError(error?.message || "Unable to load team links");
        return [];
      } finally {
        if (showLoading) {
          setTeamLinksLoading(false);
        }
      }
    },
    [loadTeamLinks, selectedTournamentId, token]
  );
  const updateDetailsField = useCallback((field, value) => {
    setDetailsDraft((previous) => ({
      ...previous,
      [field]: value,
    }));
  }, []);

  const updateMapImageSlot = useCallback((index, value) => {
    setDetailsDraft((previous) => ({
      ...previous,
      mapImageSlots: previous.mapImageSlots.map((entry, slotIndex) =>
        slotIndex === index ? value : entry
      ),
    }));
  }, []);

  const handleSaveDetails = useCallback(async () => {
    if (!token || !selectedTournamentId || detailsSaving) {
      return;
    }

    setDetailsSaving(true);
    setDetailsError("");
    setDetailsMessage("");

    try {
      const payload = {
        specialNotes: normalizeDetailText(detailsDraft.specialNotes),
        facilitiesInfo: normalizeDetailText(detailsDraft.facilitiesInfo),
        parkingInfo: normalizeDetailText(detailsDraft.parkingInfo),
        foodInfo: {
          text: normalizeDetailText(detailsDraft.foodText),
          linkUrl: normalizeDetailUrl(detailsDraft.foodLinkUrl),
        },
        mapImageUrls: detailsDraft.mapImageSlots
          .map((entry) => normalizeDetailUrl(entry))
          .filter(Boolean)
          .slice(0, TOURNAMENT_DETAILS_MAP_SLOTS),
      };

      const response = await fetchJson(`${API_URL}/api/tournaments/${selectedTournamentId}/details`, {
        method: "PATCH",
        headers: authHeaders(true),
        body: JSON.stringify(payload),
      });

      const normalizedDetails = normalizeTournamentDetails(response?.details);
      setSelectedTournament((current) =>
        current
          ? {
              ...current,
              details: normalizedDetails,
            }
          : current
      );
      setDetailsDraft(createDetailsDraft(normalizedDetails));
      setDetailsMessage("Tournament details saved.");
      onShowToast?.("success", "Tournament details updated");
    } catch (error) {
      const message = error?.message || "Unable to save tournament details";
      setDetailsError(message);
      onShowToast?.("error", message);
    } finally {
      setDetailsSaving(false);
    }
  }, [
    authHeaders,
    detailsDraft,
    detailsSaving,
    fetchJson,
    onShowToast,
    selectedTournamentId,
    token,
  ]);

  const updateTeamRow = (rowId, field, value) => {
    if (teamsSaving || teamOrderSaving) {
      return;
    }

    const isNameField = field === "name" || field === "shortName";
    if (isNameField && !canEditTeamNames) {
      return;
    }

    if (!isNameField && !canEditTeamAssets) {
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
    if (!token || !selectedTournamentId || !canEditTeamRoster || teamsSaving || teamCreateBusy) {
      return;
    }

    const name = normalizeText(newTeamName);
    const logoUrl = normalizeLogoUrl(newTeamLogoUrl);
    const locationResult = buildTeamLocationPayload({
      label: newTeamLocationLabel,
    });
    if (!name) {
      setTeamsError("Team name is required to add a team.");
      return;
    }
    if (locationResult.error) {
      setTeamsError(locationResult.error);
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
      if (locationResult.hasAnyInput) {
        payload.location = locationResult.location;
      }

      await fetchJson(`${API_URL}/api/tournaments/${selectedTournamentId}/teams`, {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify(payload),
      });
      await loadSelectedTournament(selectedTournamentId);
      setNewTeamName("");
      setNewTeamLogoUrl("");
      setNewTeamLocationLabel("");
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
    if (!token || !canEditTeamRoster || teamsSaving || teamOrderSaving) {
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

  const handleCopyTeamLink = useCallback(
    async (teamId, teamLinkUrl) => {
      if (!teamLinkUrl) {
        return;
      }

      try {
        await navigator.clipboard.writeText(teamLinkUrl);
        setCopiedTeamLinkTeamId(teamId);
        onShowToast?.("success", "Team link copied");
        setTimeout(() => {
          setCopiedTeamLinkTeamId((current) => (current === teamId ? "" : current));
        }, 1400);
      } catch {
        onShowToast?.("error", "Unable to copy team link");
      }
    },
    [onShowToast]
  );

  const handleRegenerateTeamLink = useCallback(
    async (teamId, shortName) => {
      if (!token || !teamId || teamLinkActionTeamId) {
        return;
      }

      const confirmed = window.confirm(
        `Regenerate public link for ${shortName || "this team"}? Existing link will stop working.`
      );

      if (!confirmed) {
        return;
      }

      setTeamLinkActionTeamId(teamId);
      setTeamLinksError("");

      try {
        await fetchJson(`${API_URL}/api/tournament-teams/${teamId}/regenerate-link`, {
          method: "POST",
          headers: authHeaders(),
        });

        await refreshTeamLinks({ showLoading: false });
        onShowToast?.("success", "Team link regenerated");
      } catch (error) {
        const message = error?.message || "Unable to regenerate team link";
        setTeamLinksError(message);
        onShowToast?.("error", message);
      } finally {
        setTeamLinkActionTeamId("");
      }
    },
    [authHeaders, fetchJson, onShowToast, refreshTeamLinks, teamLinkActionTeamId, token]
  );

  const handleCopyShareLink = useCallback(
    async (link) => {
      const normalizedLink = typeof link === "string" ? link.trim() : "";
      if (!normalizedLink) {
        return;
      }

      try {
        await navigator.clipboard.writeText(normalizedLink);
        setCopiedShareLink(true);
        onShowToast?.("success", "Share link copied");
        setTimeout(() => {
          setCopiedShareLink(false);
        }, 1400);
      } catch {
        onShowToast?.("error", "Unable to copy share link");
      }
    },
    [onShowToast]
  );

  const handleCreateShareLink = useCallback(async () => {
    if (!token || !selectedTournamentId || !selectedTournamentIsOwner || sharingActionBusy) {
      return;
    }

    setSharingActionBusy("create-link");
    setSharingError("");
    setSharingMessage("");

    try {
      const payload = await fetchJson(`${API_URL}/api/tournaments/${selectedTournamentId}/share/link`, {
        method: "POST",
        headers: authHeaders(),
      });

      const normalized = normalizeShareLinkPayload(payload);
      setShareLinkInfo(normalized);
      setSharingMessage("Admin share link is ready.");
      if (normalized.joinUrl) {
        await handleCopyShareLink(normalized.joinUrl);
      }
    } catch (error) {
      const message = error?.message || "Unable to create share link";
      setSharingError(message);
      onShowToast?.("error", message);
    } finally {
      setSharingActionBusy("");
    }
  }, [
    authHeaders,
    fetchJson,
    handleCopyShareLink,
    onShowToast,
    selectedTournamentId,
    selectedTournamentIsOwner,
    sharingActionBusy,
    token,
  ]);

  const handleSetShareLinkEnabled = useCallback(
    async (enabled) => {
      if (!token || !selectedTournamentId || !selectedTournamentIsOwner || sharingActionBusy) {
        return;
      }

      setSharingActionBusy(enabled ? "enable-link" : "disable-link");
      setSharingError("");
      setSharingMessage("");

      try {
        const payload = await fetchJson(`${API_URL}/api/tournaments/${selectedTournamentId}/share/link`, {
          method: "PATCH",
          headers: authHeaders(true),
          body: JSON.stringify({ enabled }),
        });

        setShareLinkInfo(normalizeShareLinkPayload(payload));
        setSharingMessage(enabled ? "Share link enabled." : "Share link disabled.");
      } catch (error) {
        const message = error?.message || "Unable to update share link";
        setSharingError(message);
        onShowToast?.("error", message);
      } finally {
        setSharingActionBusy("");
      }
    },
    [
      authHeaders,
      fetchJson,
      onShowToast,
      selectedTournamentId,
      selectedTournamentIsOwner,
      sharingActionBusy,
      token,
    ]
  );

  const handleInviteAdminByEmail = useCallback(
    async (event) => {
      event.preventDefault();

      const normalizedEmail = normalizeText(shareEmailInput).toLowerCase();
      if (!token || !selectedTournamentId || !selectedTournamentIsOwner || sharingActionBusy) {
        return;
      }

      if (!normalizedEmail || !normalizedEmail.includes("@")) {
        setSharingError("Enter a valid email address.");
        return;
      }

      setSharingActionBusy("invite-email");
      setSharingError("");
      setSharingMessage("");
      setLastInviteLink("");

      try {
        const payload = await fetchJson(`${API_URL}/api/tournaments/${selectedTournamentId}/share/email`, {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({
            email: normalizedEmail,
            role: "admin",
          }),
        });

        await refreshSharingAccess({ tournamentId: selectedTournamentId, showLoading: false });
        setShareEmailInput("");

        const inviteLink = payload?.inviteUrl || payload?.invitePath || "";
        if (inviteLink) {
          setLastInviteLink(inviteLink);
        }

        if (payload?.granted) {
          setSharingMessage("Admin access granted.");
        } else if (payload?.emailDelivered) {
          setSharingMessage("Invite sent by email.");
        } else if (inviteLink) {
          setSharingMessage("Invite created. Copy and send the invite link.");
        } else {
          setSharingMessage("Invite created.");
        }
      } catch (error) {
        const message = error?.message || "Unable to send invite";
        setSharingError(message);
        onShowToast?.("error", message);
      } finally {
        setSharingActionBusy("");
      }
    },
    [
      authHeaders,
      fetchJson,
      onShowToast,
      refreshSharingAccess,
      selectedTournamentId,
      selectedTournamentIsOwner,
      shareEmailInput,
      sharingActionBusy,
      token,
    ]
  );

  const handleRevokeAdminAccess = useCallback(
    async (userId, displayName) => {
      if (!token || !selectedTournamentId || !selectedTournamentIsOwner || !userId || sharingActionBusy) {
        return;
      }

      const confirmed = window.confirm(
        `Remove admin access for ${displayName || "this user"}?`
      );

      if (!confirmed) {
        return;
      }

      setSharingActionBusy(`revoke-${userId}`);
      setSharingError("");
      setSharingMessage("");

      try {
        await fetchJson(`${API_URL}/api/tournaments/${selectedTournamentId}/access/${userId}`, {
          method: "DELETE",
          headers: authHeaders(),
        });

        await refreshSharingAccess({ tournamentId: selectedTournamentId, showLoading: false });
        setSharingMessage("Admin access removed.");
      } catch (error) {
        const message = error?.message || "Unable to remove admin access";
        setSharingError(message);
        onShowToast?.("error", message);
      } finally {
        setSharingActionBusy("");
      }
    },
    [
      authHeaders,
      fetchJson,
      onShowToast,
      refreshSharingAccess,
      selectedTournamentId,
      selectedTournamentIsOwner,
      sharingActionBusy,
      token,
    ]
  );

  const handleLeaveTournament = useCallback(async () => {
    if (!token || !selectedTournamentId || selectedTournamentIsOwner || sharingActionBusy) {
      return;
    }

    const confirmed = window.confirm("Leave this tournament's admin access?");
    if (!confirmed) {
      return;
    }

    setSharingActionBusy("leave");
    setSharingError("");
    setSharingMessage("");

    try {
      await fetchJson(`${API_URL}/api/tournaments/${selectedTournamentId}/access/leave`, {
        method: "POST",
        headers: authHeaders(),
      });

      await loadTournaments({ preferredTournamentId: "" });
      onShowToast?.("success", "You left the tournament");
      navigate("/?tab=tournaments");
    } catch (error) {
      const message = error?.message || "Unable to leave tournament";
      setSharingError(message);
      onShowToast?.("error", message);
    } finally {
      setSharingActionBusy("");
    }
  }, [
    authHeaders,
    fetchJson,
    loadTournaments,
    navigate,
    onShowToast,
    selectedTournamentId,
    selectedTournamentIsOwner,
    sharingActionBusy,
    token,
  ]);

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
      if (!canEditTeamRoster || teamsSaving || teamOrderSaving) {
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
    [canEditTeamRoster, persistTeamOrder, teamOrderSaving, teamRows, teamsSaving]
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
        navigate(`/tournaments/${createdId}/format`);
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
    if (!token || !selectedTournamentId || teamsSaving || teamOrderSaving) {
      return;
    }

    const nextLocationByRowId = new Map();

    for (let index = 0; index < teamRows.length; index += 1) {
      const row = teamRows[index];
      const name = normalizeText(row?.name || row?.shortName);
      const nextLocation = buildTeamLocationPayload({
        label: row?.locationLabel,
      });

      if (!name) {
        setTeamsError(`Team ${index + 1} must include a team name.`);
        return;
      }

      if (nextLocation.error) {
        setTeamsError(`Team ${index + 1}: ${nextLocation.error}`);
        return;
      }

      nextLocationByRowId.set(row.rowId, nextLocation.location);
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
        const nextLocation = nextLocationByRowId.get(row.rowId);
        const previousLocation = normalizeTeamLocationRecord(previous?.location);

        if (canEditTeamNames && (nextName !== previousName || nextName !== previousShortName)) {
          payload.name = nextName;
          payload.shortName = nextName;
        }

        if (nextLogoUrl !== previousLogoUrl) {
          payload.logoUrl = nextLogoUrl;
        }

        if (!areTeamLocationsEqual(nextLocation, previousLocation)) {
          payload.location = nextLocation;
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

  const handleDeleteTournament = useCallback(
    async (tournament) => {
      const tournamentId = tournament?._id ? String(tournament._id) : "";
      const tournamentName = tournament?.name || "this tournament";

      if (!token || !tournamentId || deletingTournamentId) {
        return;
      }

      const shouldDelete = window.confirm(
        `Delete ${tournamentName}?\n\nThis will remove all tournament teams, pools, matches, and linked scoreboards.`
      );
      if (!shouldDelete) {
        return;
      }

      setDeletingTournamentId(tournamentId);
      setTournamentsError("");

      try {
        await fetchJson(`${API_URL}/api/tournaments/${tournamentId}`, {
          method: "DELETE",
          headers: authHeaders(),
        });

        const remaining = tournaments
          .map((entry) => (entry?._id ? String(entry._id) : ""))
          .filter((id) => id && id !== tournamentId);
        const preferredTournamentId =
          selectedTournamentId === tournamentId
            ? remaining[0] || ""
            : selectedTournamentId;

        await loadTournaments({ preferredTournamentId });
        onShowToast?.("success", "Tournament deleted");
      } catch (error) {
        const message = error?.message || "Unable to delete tournament";
        setTournamentsError(message);
        onShowToast?.("error", message);
      } finally {
        setDeletingTournamentId("");
      }
    },
    [
      authHeaders,
      deletingTournamentId,
      fetchJson,
      loadTournaments,
      onShowToast,
      selectedTournamentId,
      token,
      tournaments,
    ]
  );

  const teamRosterEditDisabled = !canEditTeamRoster || teamsSaving || teamOrderSaving;
  const teamNameEditDisabled = !canEditTeamNames || teamsSaving || teamOrderSaving;
  const teamAssetEditDisabled = !canEditTeamAssets || teamsSaving || teamOrderSaving;

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
        {showCreateCard && (
          <section className="tournaments-card tournaments-create-card">
            <h2 className="secondary-title">Create Tournament</h2>
            <p className="subtle">Start a new tournament and jump directly into Scheduling.</p>
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
        )}

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
                    </button>

                    <div className="tournament-list-actions">
                      <a className="secondary-button" href={`/tournaments/${id}/details`}>
                        Details
                      </a>
                      <a className="secondary-button" href={`/tournaments/${id}/teams`}>
                        Team Setup
                      </a>
                      <a className="secondary-button" href={`/tournaments/${id}/format`}>
                        Scheduling
                      </a>
                      <a className="secondary-button" href={`/tournaments/${id}/quick-scores`}>
                        Quick Scores
                      </a>
                      <a
                        className="secondary-button"
                        href={`/t/${tournament?.publicCode || ""}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Public View
                      </a>
                      {tournament?.isOwner && (
                        <button
                          type="button"
                          className="secondary-button tournament-delete-button"
                          onClick={() => handleDeleteTournament(tournament)}
                          disabled={deletingTournamentId === id}
                        >
                          {deletingTournamentId === id ? "Deleting..." : "Delete"}
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {showDetailsSection && (
      <section className="tournaments-card tournaments-details-card">
        <div className="tournaments-team-header">
          <div>
            <h2 className="secondary-title">Tournament Details</h2>
            {selectedTournament ? (
              <p className="subtle">Update public notes, maps, and venue information.</p>
            ) : (
              <p className="subtle">Select a tournament to edit public details.</p>
            )}
          </div>
          <div className="tournaments-team-actions">
            <button
              type="button"
              className="ghost-button"
              onClick={handleSaveDetails}
              disabled={!selectedTournament || detailsSaving}
            >
              {detailsSaving ? "Saving..." : "Save details"}
            </button>
          </div>
        </div>

        {!selectedTournament ? (
          <p className="subtle">Choose a tournament from the list above to start editing details.</p>
        ) : (
          <>
            <div className="tournament-details-grid">
              <div className="tournament-team-card-fields">
                <label className="input-label" htmlFor="tournament-special-notes">
                  Special Notes (markdown supported)
                </label>
                <textarea
                  id="tournament-special-notes"
                  rows={5}
                  value={detailsDraft.specialNotes}
                  onChange={(event) => updateDetailsField("specialNotes", event.target.value)}
                  placeholder="Enter tournament notes for teams and spectators."
                />
              </div>

              <div className="tournament-team-card-fields">
                <label className="input-label" htmlFor="tournament-facilities-info">
                  Facilities / Court Notes
                </label>
                <textarea
                  id="tournament-facilities-info"
                  rows={3}
                  value={detailsDraft.facilitiesInfo}
                  onChange={(event) => updateDetailsField("facilitiesInfo", event.target.value)}
                  placeholder="Court rules, warm-up zones, restroom info, etc."
                />
              </div>

              <div className="tournament-team-card-fields">
                <label className="input-label" htmlFor="tournament-parking-info">
                  Parking (optional)
                </label>
                <textarea
                  id="tournament-parking-info"
                  rows={3}
                  value={detailsDraft.parkingInfo}
                  onChange={(event) => updateDetailsField("parkingInfo", event.target.value)}
                  placeholder="Parking access notes and lot guidance."
                />
              </div>

              <div className="tournament-team-card-fields">
                <label className="input-label" htmlFor="tournament-food-text">
                  Food Info
                </label>
                <textarea
                  id="tournament-food-text"
                  rows={3}
                  value={detailsDraft.foodText}
                  onChange={(event) => updateDetailsField("foodText", event.target.value)}
                  placeholder="Concessions, nearby restaurants, meal notes."
                />
              </div>

              <div className="tournament-team-card-fields">
                <label className="input-label" htmlFor="tournament-food-link">
                  Food Link (optional)
                </label>
                <input
                  id="tournament-food-link"
                  type="text"
                  value={detailsDraft.foodLinkUrl}
                  onChange={(event) => updateDetailsField("foodLinkUrl", event.target.value)}
                  placeholder="https://..."
                />
              </div>
            </div>

            <section className="tournament-details-maps-panel">
              <h3>Map Images (up to 3 URLs)</h3>
              <div className="tournament-details-map-inputs">
                {detailsDraft.mapImageSlots.map((entry, index) => (
                  <div key={`map-slot-${index}`} className="tournament-team-card-fields">
                    <label className="input-label" htmlFor={`tournament-map-url-${index}`}>
                      Map URL {index + 1}
                    </label>
                    <input
                      id={`tournament-map-url-${index}`}
                      type="text"
                      value={entry}
                      onChange={(event) => updateMapImageSlot(index, event.target.value)}
                      placeholder="https://..."
                    />
                  </div>
                ))}
              </div>

              {detailsPreviewUrls.length > 0 ? (
                <div className="tournament-details-map-previews">
                  {detailsPreviewUrls.map((url) => (
                    <a key={url} href={url} target="_blank" rel="noreferrer" className="tournament-details-map-preview">
                      <img src={url} alt="Tournament map preview" loading="lazy" />
                    </a>
                  ))}
                </div>
              ) : (
                <p className="subtle">Add map URLs to preview them before saving.</p>
              )}
            </section>

            <section className="tournament-team-links-panel">
              <div className="tournament-team-links-header">
                <h3>Sharing</h3>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() =>
                    refreshSharingAccess({
                      tournamentId: selectedTournamentId,
                      showLoading: true,
                    })
                  }
                  disabled={sharingLoading}
                >
                  {sharingLoading ? "Refreshing..." : "Refresh"}
                </button>
              </div>

              <p className="subtle">
                Your role:{" "}
                <strong>{selectedTournamentIsOwner ? "Owner" : "Admin"}</strong>
              </p>

              {accessOwner && (
                <div className="tournament-team-link-row">
                  <div className="tournament-team-link-meta">
                    <strong>{accessOwner.displayName || accessOwner.email || "Owner"}</strong>
                    <span className="subtle">Owner</span>
                  </div>
                </div>
              )}

              {accessAdmins.length > 0 ? (
                <div className="tournament-team-links-list">
                  {accessAdmins.map((entry) => (
                    <article key={entry.userId} className="tournament-team-link-row">
                      <div className="tournament-team-link-meta">
                        <strong>{entry.displayName || entry.email || "Admin"}</strong>
                        <span className="subtle">{entry.email || "admin"}</span>
                      </div>
                      {selectedTournamentIsOwner && (
                        <div className="tournament-team-link-actions">
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() =>
                              handleRevokeAdminAccess(
                                entry.userId,
                                entry.displayName || entry.email
                              )
                            }
                            disabled={Boolean(sharingActionBusy)}
                          >
                            Revoke
                          </button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <p className="subtle">No additional admins yet.</p>
              )}

              {selectedTournamentIsOwner && pendingInvites.length > 0 && (
                <div className="tournament-team-links-list">
                  {pendingInvites.map((invite) => (
                    <article key={invite.inviteId || invite.email} className="tournament-team-link-row">
                      <div className="tournament-team-link-meta">
                        <strong>{invite.email}</strong>
                        <span className="subtle">
                          Pending invite
                          {invite.expiresAt
                            ? ` · Expires ${new Date(invite.expiresAt).toLocaleString()}`
                            : ""}
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              )}

              {selectedTournamentIsOwner ? (
                <>
                  <form className="tournaments-form" onSubmit={handleInviteAdminByEmail}>
                    <label className="input-label" htmlFor="tournament-share-email">
                      Add admin by email
                    </label>
                    <div className="tournament-team-add-row">
                      <input
                        id="tournament-share-email"
                        type="email"
                        placeholder="admin@example.com"
                        value={shareEmailInput}
                        disabled={Boolean(sharingActionBusy)}
                        onChange={(event) => setShareEmailInput(event.target.value)}
                      />
                      <button
                        type="submit"
                        className="secondary-button"
                        disabled={Boolean(sharingActionBusy)}
                      >
                        {sharingActionBusy === "invite-email" ? "Inviting..." : "Invite Admin"}
                      </button>
                    </div>
                  </form>

                  <div className="tournament-team-link-row">
                    <div className="tournament-team-link-meta">
                      <strong>Admin Share Link</strong>
                      {shareLinkInfo.joinUrl ? (
                        <code>{shareLinkInfo.joinUrl}</code>
                      ) : (
                        <span className="subtle">No share link created yet.</span>
                      )}
                    </div>
                    <div className="tournament-team-link-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={handleCreateShareLink}
                        disabled={Boolean(sharingActionBusy)}
                      >
                        {sharingActionBusy === "create-link"
                          ? "Creating..."
                          : shareLinkInfo.joinUrl
                            ? copiedShareLink
                              ? "Copied"
                              : "Copy Link"
                            : "Create Link"}
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => handleSetShareLinkEnabled(!shareLinkInfo.enabled)}
                        disabled={Boolean(sharingActionBusy) || !shareLinkInfo.joinUrl}
                      >
                        {sharingActionBusy === "disable-link" || sharingActionBusy === "enable-link"
                          ? "Saving..."
                          : shareLinkInfo.enabled
                            ? "Disable Link"
                            : "Enable Link"}
                      </button>
                    </div>
                  </div>

                  {lastInviteLink && (
                    <div className="tournament-team-link-row">
                      <div className="tournament-team-link-meta">
                        <strong>Latest Invite Link</strong>
                        <code>{lastInviteLink}</code>
                      </div>
                      <div className="tournament-team-link-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => handleCopyShareLink(lastInviteLink)}
                        >
                          Copy Invite Link
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={handleLeaveTournament}
                  disabled={Boolean(sharingActionBusy)}
                >
                  {sharingActionBusy === "leave" ? "Leaving..." : "Leave Tournament"}
                </button>
              )}

              {sharingError && <p className="error">{sharingError}</p>}
              {sharingMessage && (
                <p className="subtle tournaments-team-success">{sharingMessage}</p>
              )}
            </section>

            {detailsError && <p className="error">{detailsError}</p>}
            {detailsMessage && <p className="subtle tournaments-team-success">{detailsMessage}</p>}
          </>
        )}
      </section>
      )}

      {showTeamsSection && (
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
              disabled={!selectedTournament || teamsSaving || teamOrderSaving}
            >
              {teamsSaving ? "Saving..." : "Save team fields"}
            </button>
          </div>
        </div>

        {selectedTournament && !canEditTeamNames && (
          <p className="subtle tournaments-lock-message">
            Team names are locked because this tournament is in{" "}
            <strong>{formatStatusLabel(selectedTournament?.status)}</strong> status. Logos and
            locations stay editable.
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

        {selectedTournament && (
          <section className="tournament-team-links-panel">
            <div className="tournament-team-links-header">
              <h3>Team Links</h3>
              <button
                type="button"
                className="ghost-button"
                onClick={() => refreshTeamLinks({ showLoading: true })}
                disabled={teamLinksLoading}
              >
                {teamLinksLoading ? "Refreshing..." : "Refresh links"}
              </button>
            </div>

            {teamLinksError && <p className="error">{teamLinksError}</p>}

            {teamLinksLoading ? (
              <p className="subtle">Loading team links...</p>
            ) : teamLinks.length === 0 ? (
              <p className="subtle">No team links available yet.</p>
            ) : (
              <div className="tournament-team-links-list">
                {teamLinks.map((entry) => (
                  <article key={entry.teamId || entry.teamLinkUrl} className="tournament-team-link-row">
                    <div className="tournament-team-link-meta">
                      <strong>{entry.shortName || "TBD"}</strong>
                      <code>{entry.teamLinkUrl || "-"}</code>
                    </div>
                    <div className="tournament-team-link-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => handleCopyTeamLink(entry.teamId, entry.teamLinkUrl)}
                        disabled={!entry.teamLinkUrl}
                      >
                        {copiedTeamLinkTeamId === entry.teamId ? "Copied" : "Copy Team Link"}
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => handleRegenerateTeamLink(entry.teamId, entry.shortName)}
                        disabled={!entry.teamId || Boolean(teamLinkActionTeamId)}
                      >
                        {teamLinkActionTeamId === entry.teamId ? "Regenerating..." : "Regenerate link"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
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
                disabled={teamRosterEditDisabled || teamCreateBusy}
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
                disabled={teamRosterEditDisabled || teamCreateBusy}
                onChange={(event) => setNewTeamLogoUrl(event.target.value)}
                placeholder="https://..."
              />
            </div>
            <div className="tournament-team-card-fields">
              <label className="input-label" htmlFor="team-add-location-label">
                Location label (optional)
              </label>
              <input
                id="team-add-location-label"
                type="text"
                value={newTeamLocationLabel}
                disabled={teamRosterEditDisabled || teamCreateBusy}
                onChange={(event) => setNewTeamLocationLabel(event.target.value)}
                placeholder="Norfolk, VA"
              />
            </div>
            <button
              type="button"
              className="primary-button"
              onClick={handleAddTeam}
              disabled={!selectedTournament || teamRosterEditDisabled || teamCreateBusy}
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
                    rosterDisabled={teamRosterEditDisabled}
                    nameDisabled={teamNameEditDisabled}
                    assetsDisabled={teamAssetEditDisabled}
                    onUpdate={updateTeamRow}
                    onRemove={removeTeamRow}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </section>
      )}
    </div>
  );
}

export default TournamentsTab;

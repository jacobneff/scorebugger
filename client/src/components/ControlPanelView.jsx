import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  MdClose,
  MdContentCopy,
  MdChevronLeft,
  MdChevronRight,
  MdEdit,
  MdSave,
  MdExpandLess,
  MdExpandMore,
} from "react-icons/md";
import { FiCheckCircle, FiInfo, FiXCircle } from "react-icons/fi";
import { useScoreboard } from "../hooks/useScoreboard.js";
import SettingsMenu from "./SettingsMenu.jsx";
import ScoreboardOverlay from "./ScoreboardOverlay.jsx";
import { useSettings } from "../context/SettingsContext.jsx";
import { MAX_COMPLETED_SETS, MAX_TOTAL_SETS } from "../constants/scoreboard.js";
import { buildShortcutMap, deriveSetNavigationState, shouldEnableDeleteSet } from "./controlPanel.utils.js";

/* ---------- helpers ---------- */
const getSetScores = (set) => {
  if (Array.isArray(set?.scores) && set.scores.length === 2) {
    const [homeScore, awayScore] = set.scores;
    const safe = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    return [safe(homeScore), safe(awayScore)];
  }
  const safeHome = Number.isFinite(Number(set?.home)) ? Math.max(0, Number(set.home)) : 0;
  const safeAway = Number.isFinite(Number(set?.away)) ? Math.max(0, Number(set.away)) : 0;
  return [safeHome, safeAway];
};

const normalizeSet = (set) => {
  const [homeScore, awayScore] = getSetScores(set);
  const createdAt =
    set?.createdAt && !Number.isNaN(Date.parse(set.createdAt))
      ? new Date(set.createdAt).toISOString()
      : new Date().toISOString();
  return { scores: [homeScore, awayScore], createdAt };
};

const TEAM_NAME_LIMIT = 10;
const isCompleteHex = (value) => /^#([0-9A-F]{3}|[0-9A-F]{6})$/i.test(value);
const scrubHexDraft = (value) => {
  if (typeof value !== "string") return "#";
  const trimmed = value.trim().replace(/^#+/, "");
  const cleaned = trimmed.replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
  return `#${cleaned.toUpperCase()}`;
};

const formatTeamNameForControl = (value = "") => {
  const trimmed = value.trim();
  if (!trimmed) return "Team";
  return trimmed.length > TEAM_NAME_LIMIT ? trimmed.slice(0, TEAM_NAME_LIMIT) : trimmed;
};

const SHORTCUTS = buildShortcutMap({
  increaseHomeScore: { key: "a" },
  decreaseHomeScore: { key: "z" },
  increaseAwayScore: { key: "k" },
  decreaseAwayScore: { key: "m" },
  toggleServing: { key: "s" },
});

/* ---------- component ---------- */
function ControlPanelView({
  scoreboardId,
  showHeader = true,
  // eslint-disable-next-line no-unused-vars
  standalone = true, // unused but kept for API compatibility
  // eslint-disable-next-line no-unused-vars
  showTitleEditor = true, // superseded by inline title editor below
  onScoreboardChange,
}) {
  const { scoreboard, loading, error, updateScoreboard, clearError } = useScoreboard(scoreboardId);
  const { shortcutsEnabled } = useSettings();
  const {
    increaseHomeScore,
    decreaseHomeScore,
    increaseAwayScore,
    decreaseAwayScore,
    toggleServing,
  } = SHORTCUTS;

  const buildShortcutAttributes = (baseTitle, shortcut, options = {}) => {
    const { includeAriaLabel = true, ariaLabel } = options;
    const baseAria = ariaLabel ?? baseTitle;
    if (!shortcut || !shortcutsEnabled) {
      const attrs = { title: baseTitle };
      if (includeAriaLabel) {
        attrs["aria-label"] = baseAria;
      }
      return attrs;
    }
    const titleWithShortcut = `${baseTitle} (Shortcut: ${shortcut.display})`;
    const attrs = {
      title: titleWithShortcut,
      "data-shortcut": shortcut.display,
    };
    if (includeAriaLabel) {
      attrs["aria-label"] = `${baseAria} (Shortcut: ${shortcut.display})`;
    }
    return attrs;
  };

  const MAX_TITLE = 30;
  const remaining = (v, limit = MAX_TITLE) => limit - (v?.length ?? 0);

  // Fallback teams while loading
  const fallbackTeams = useMemo(() => {
    if (scoreboard?.teams && scoreboard.teams.length === 2) {
      return scoreboard.teams.map((team, idx) => ({
        name: team?.name ?? (idx === 0 ? "Home" : "Away"),
        color: team?.color || (idx === 0 ? "#2563eb" : "#16a34a"),
        teamTextColor: team?.teamTextColor || team?.textColor || "#ffffff",
        setColor: team?.setColor || team?.color || "#0b1a3a",
        scoreTextColor: team?.scoreTextColor || "#ffffff",
        textColor: team?.teamTextColor || team?.textColor || "#ffffff",
        score: Number.isFinite(Number(team?.score)) ? Math.max(0, Number(team.score)) : 0,
      }));
    }
    return [
      {
        name: "Home",
        color: "#2563eb",
        teamTextColor: "#ffffff",
        setColor: "#0b1a3a",
        scoreTextColor: "#ffffff",
        textColor: "#ffffff",
        score: 0,
      },
      {
        name: "Away",
        color: "#16a34a",
        teamTextColor: "#ffffff",
        setColor: "#0b1a3a",
        scoreTextColor: "#ffffff",
        textColor: "#ffffff",
        score: 0,
      },
    ];
  }, [scoreboard?.teams]);

  const colorSnapshot = useMemo(() => {
    const snapshot = {};
    fallbackTeams.forEach((team, idx) => {
      snapshot[`team-${idx}-panel`] = (team.color || "#000000").toUpperCase();
      snapshot[`team-${idx}-text`] =
        (team.teamTextColor || team.textColor || "#ffffff").toUpperCase();
    });
    snapshot["score-bg"] = (fallbackTeams[0]?.setColor || "#0b1a3a").toUpperCase();
    snapshot["score-text"] = (fallbackTeams[0]?.scoreTextColor || "#ffffff").toUpperCase();
    return snapshot;
  }, [fallbackTeams]);

  const [colorDrafts, setColorDrafts] = useState(colorSnapshot);

  useEffect(() => {
    setColorDrafts(colorSnapshot);
  }, [colorSnapshot]);

  const updateColorDraft = (key, value) => {
    setColorDrafts((prev) => ({ ...prev, [key]: value }));
  };

  // Title (inline editor control)
  const [titleDraft, setTitleDraft] = useState(scoreboard?.title ?? "");
  const [editingTitle, setEditingTitle] = useState(false);
  const titleRemaining = remaining(titleDraft);
  const titleCountdownClass = `countdown ${titleRemaining <= 5 ? "warn" : ""}`.trim();

  useEffect(() => {
    setTitleDraft(scoreboard?.title ?? "");
  }, [scoreboard?.title]);

  const saveTitle = () => {
    const trimmed = titleDraft.trim().slice(0, MAX_TITLE);
    if (!trimmed || trimmed === scoreboard?.title) {
      setEditingTitle(false);
      return;
    }
    updateScoreboard({ title: trimmed });
    setEditingTitle(false);
    showToast("info", "Title saved");
  };

  // Toasts
  const [toasts, setToasts] = useState([]);
  const showToast = (type, message) => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 2000);
  };

  const toastContent = (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type}`}>
          <div className="toast-icon">
            {t.type === "success" && <FiCheckCircle />}
            {t.type === "info" && <FiInfo />}
            {t.type === "error" && <FiXCircle />}
          </div>
          <span className="toast-text">{t.message}</span>
        </div>
      ))}
    </div>
  );
  const toastLayer =
    toasts.length > 0
      ? typeof document !== "undefined"
        ? createPortal(toastContent, document.body)
        : toastContent
      : null;

  // Copy link state
  const [controlCopied, setControlCopied] = useState(false);
  const [overlayCopied, setOverlayCopied] = useState(false);

  // Manual load
  const [manualId, setManualId] = useState(scoreboardId ?? "");
  useEffect(() => setManualId((scoreboardId ?? "").toUpperCase()), [scoreboardId]);
  useEffect(() => {
    setHasDraftOverride(false);
  }, [scoreboardId]);
  const handleManualSubmit = (e) => {
    e?.preventDefault?.();
    const trimmed = manualId.trim();
    if (!trimmed) return;
    onScoreboardChange?.(trimmed.toUpperCase());
  };

  // Sets / nav state
  const [mode, setMode] = useState("current"); // 'current' | 'history'
  const [historyIndex, setHistoryIndex] = useState(0);
  const [cachedCurrentScores, setCachedCurrentScores] = useState(null);
  const [hasDraftOverride, setHasDraftOverride] = useState(false);
  const [collapsedColorPanels, setCollapsedColorPanels] = useState({ 0: false, 1: false });
  const [isScoreColorsCollapsed, setIsScoreColorsCollapsed] = useState(false);

  const sets = scoreboard?.sets ?? [];
  const totalCompletedSets = sets.length;
  const displayedHistoryIndex = Math.min(historyIndex, Math.max(0, totalCompletedSets - 1));

  // Derived URL
  const overlayUrl = useMemo(() => {
    const id = scoreboard?._id || scoreboard?.code || scoreboardId || "";
    const origin =
      typeof window !== "undefined" && window.location?.origin ? window.location.origin : "";
    return id ? `${origin}/board/${id}/display` : "";
  }, [scoreboard?._id, scoreboard?.code, scoreboardId]);

  const controlUrl = useMemo(() => {
    const id = scoreboard?._id || scoreboard?.code || scoreboardId || "";
    const origin =
      typeof window !== "undefined" && window.location?.origin ? window.location.origin : "";
    return id ? `${origin}/board/${id}/control` : "";
  }, [scoreboard?._id, scoreboard?.code, scoreboardId]);

  useEffect(() => {
    setCollapsedColorPanels({ 0: false, 1: false });
    setIsScoreColorsCollapsed(false);
  }, [scoreboardId]);

  // Team-name edit
  const [editingTeamIndex, setEditingTeamIndex] = useState(null);
  const [teamNameDraft, setTeamNameDraft] = useState("");
  const startEditTeamName = (i) => {
    setEditingTeamIndex(i);
    const currentName = fallbackTeams[i]?.name ?? "";
    setTeamNameDraft(currentName.slice(0, TEAM_NAME_LIMIT));
  };
  const cancelEditTeamName = () => {
    setEditingTeamIndex(null);
    setTeamNameDraft("");
  };
  const saveTeamName = (i) => {
    const name = teamNameDraft.trim();
    if (!name) {
      showToast("error", "Name cannot be empty");
      return;
    }
    updateScoreboard({
      teams: fallbackTeams.map((t, idx) => (idx === i ? { ...t, name } : t)),
    });
    setEditingTeamIndex(null);
    showToast("info", "Name saved");
  };

  const handlePanelColorChange = (index, value) => {
    updateScoreboard({
      teams: fallbackTeams.map((team, idx) => {
        if (idx !== index) return team;
        const next = { ...team, color: value };
        if (!team.setColor || team.setColor === team.color) {
          next.setColor = value;
        }
        return next;
      }),
    });
  };

  const handleSetColorChange = (value) => {
    updateScoreboard({
      teams: fallbackTeams.map((team) => ({ ...team, setColor: value })),
    });
  };

  const handleTextColorChange = (index, value) => {
    updateScoreboard({
      teams: fallbackTeams.map((team, idx) =>
        idx === index ? { ...team, textColor: value, teamTextColor: value } : team
      ),
    });
  };

  const handleScoreTextColorChange = (value) => {
    updateScoreboard({
      teams: fallbackTeams.map((team) => ({ ...team, scoreTextColor: value })),
    });
  };

  const handlePanelColorInput = (index, value) => {
    const normalized = value.toUpperCase();
    updateColorDraft(`team-${index}-panel`, normalized);
    handlePanelColorChange(index, normalized);
  };

  const handlePanelColorTextChange = (index, value) => {
    const draft = scrubHexDraft(value);
    updateColorDraft(`team-${index}-panel`, draft);
    if (isCompleteHex(draft)) {
      handlePanelColorChange(index, draft);
    }
  };

  const handlePanelColorBlur = (index) => {
    const key = `team-${index}-panel`;
    if (!isCompleteHex(colorDrafts[key] || "")) {
      updateColorDraft(key, colorSnapshot[key]);
    }
  };

  const handleTeamTextColorInput = (index, value) => {
    const normalized = value.toUpperCase();
    updateColorDraft(`team-${index}-text`, normalized);
    handleTextColorChange(index, normalized);
  };

  const handleTeamTextColorTextChange = (index, value) => {
    const draft = scrubHexDraft(value);
    updateColorDraft(`team-${index}-text`, draft);
    if (isCompleteHex(draft)) {
      handleTextColorChange(index, draft);
    }
  };

  const handleTeamTextColorBlur = (index) => {
    const key = `team-${index}-text`;
    if (!isCompleteHex(colorDrafts[key] || "")) {
      updateColorDraft(key, colorSnapshot[key]);
    }
  };

  const handleScoreBgInput = (value) => {
    const normalized = value.toUpperCase();
    updateColorDraft("score-bg", normalized);
    handleSetColorChange(normalized);
  };

  const handleScoreBgTextChange = (value) => {
    const draft = scrubHexDraft(value);
    updateColorDraft("score-bg", draft);
    if (isCompleteHex(draft)) {
      handleSetColorChange(draft);
    }
  };

  const handleScoreBgBlur = () => {
    if (!isCompleteHex(colorDrafts["score-bg"] || "")) {
      updateColorDraft("score-bg", colorSnapshot["score-bg"]);
    }
  };

  const handleScoreTextInput = (value) => {
    const normalized = value.toUpperCase();
    updateColorDraft("score-text", normalized);
    handleScoreTextColorChange(normalized);
  };

  const handleScoreTextChange = (value) => {
    const draft = scrubHexDraft(value);
    updateColorDraft("score-text", draft);
    if (isCompleteHex(draft)) {
      handleScoreTextColorChange(draft);
    }
  };

  const handleScoreTextBlur = () => {
    if (!isCompleteHex(colorDrafts["score-text"] || "")) {
      updateColorDraft("score-text", colorSnapshot["score-text"]);
    }
  };

  // --------- Score operations ---------
  const setServing = useCallback(
    (teamIndex) => {
      updateScoreboard((current) => {
        if (!current?.teams || current.servingTeamIndex === teamIndex) {
          return null;
        }
        return { servingTeamIndex: teamIndex };
      });
    },
    [updateScoreboard]
  );

  const bumpScoreCurrent = useCallback(
    (teamIndex, delta) => {
      updateScoreboard((current) => {
        if (!current?.teams || !Number.isFinite(delta)) return null;
        const clamp = (value) => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
        const nextTeams = current.teams.map((team, index) => {
          if (index !== teamIndex) return team;
          const baseScore = clamp(team.score ?? 0);
          return { ...team, score: clamp(baseScore + delta) };
        });
        const partial = { teams: nextTeams };
        if (delta > 0) {
          partial.servingTeamIndex = teamIndex;
        }
        return partial;
      });
    },
    [updateScoreboard]
  );

  const bumpScoreHistory = useCallback(
    (teamIndex, delta) => {
      updateScoreboard((current) => {
        const currentSets = current?.sets ?? [];
        if (!currentSets[historyIndex]) return null;
        const normalizedCurrent = normalizeSet(currentSets[historyIndex]);
        const [homeScore, awayScore] = normalizedCurrent.scores;
        const clamp = (value) => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
        const nextScores =
          teamIndex === 0
            ? [clamp(homeScore + delta), clamp(awayScore)]
            : [clamp(homeScore), clamp(awayScore + delta)];

        const nextSets = currentSets.map((set, idx) => {
          if (idx !== historyIndex) return normalizeSet(set);
          return { ...normalizeSet(set), scores: nextScores };
        });

        return { sets: nextSets };
      });
    },
    [historyIndex, updateScoreboard]
  );

  const archiveCurrentSet = () => {
    if (!scoreboard?.teams) return false;

    if (sets.length >= MAX_COMPLETED_SETS) {
      showToast("error", `Maximum of ${MAX_TOTAL_SETS} sets reached`);
      return false;
    }

    const s0 = scoreboard.teams?.[0]?.score ?? 0;
    const s1 = scoreboard.teams?.[1]?.score ?? 0;

    const existing = sets.map((set) => normalizeSet(set));
    const nextSets = [
      ...existing,
      {
        scores: [Math.max(0, Number(s0) || 0), Math.max(0, Number(s1) || 0)],
        createdAt: new Date().toISOString(),
      },
    ];

    updateScoreboard({
      sets: nextSets,
      teams: scoreboard.teams.map((t) => ({ ...t, score: 0 })),
    });
    setHasDraftOverride(true);
    return true;
  };

  const deleteLastCreatedSet = () => {
    if (!sets || sets.length === 0) return;

    const deletedSetNumber = sets.length;

    updateScoreboard((current) => {
      const currentSets = current?.sets ?? [];
      if (currentSets.length === 0) {
        return null;
      }

      const normalizedSets = currentSets.map((set) => normalizeSet(set));
      const nextSets = normalizedSets.slice(0, normalizedSets.length - 1);

      return {
        sets: nextSets,
      };
    });

    const remainingSets = sets.length - 1;
    if (remainingSets > 0) {
      setMode("history");
      setHistoryIndex(remainingSets - 1);
    } else {
      setMode("current");
      setHistoryIndex(0);
    }
    setCachedCurrentScores(null);
    setHasDraftOverride(false);
    showToast("info", `Set ${deletedSetNumber} deleted`);
  };

  const resetScores = () => {
    if (!scoreboard?.teams) return;
    updateScoreboard({ teams: scoreboard.teams.map((t) => ({ ...t, score: 0 })) });
    setCachedCurrentScores([0, 0]);
    showToast("info", "Scores reset");
  };

  const resetSets = () => {
    if (!scoreboard) return;
    updateScoreboard({ sets: [], teams: scoreboard.teams?.map((t) => ({ ...t, score: 0 })) });
    setMode("current");
    setHistoryIndex(0);
    setCachedCurrentScores([0, 0]);
    setHasDraftOverride(false);
    showToast("info", "All sets deleted");
  };

  const deleteActiveSet = () => {
    if (!deleteStateEligible) return;
    deleteLastCreatedSet();
  };

  // ---------- Navigation ----------
  const goToPreviousSet = () => {
    if (mode === "current") {
      if (sets.length === 0) return;
      setCachedCurrentScores([
        scoreboard.teams?.[0]?.score ?? 0,
        scoreboard.teams?.[1]?.score ?? 0,
      ]);
      setHistoryIndex(sets.length - 1);
      setMode("history");
      return;
    }
    if (historyIndex > 0) setHistoryIndex((i) => i - 1);
  };

  const goToNextSet = () => {
    if (mode === "current") {
      const saved = archiveCurrentSet();
      if (saved) {
        showToast("success", "Set saved");
        setHasDraftOverride(true);
      }
      return;
    }
    if (historyIndex < sets.length - 1) {
      setHistoryIndex((i) => i + 1);
    } else {
      setMode("current");
      if (cachedCurrentScores) {
        const [h, a] = cachedCurrentScores;
        const currH = scoreboard?.teams?.[0]?.score ?? 0;
        const currA = scoreboard?.teams?.[1]?.score ?? 0;
        if (h !== currH || a !== currA) {
          updateScoreboard({
            teams: scoreboard.teams.map((t, idx) => (idx === 0 ? { ...t, score: h } : { ...t, score: a })),
          });
        }
        setCachedCurrentScores(null);
        setHasDraftOverride(true);
      }
    }
  };

  // ---------- Keyboard shortcuts (CURRENT only) ----------
  useEffect(() => {
    if (!shortcutsEnabled || !scoreboard?.teams || mode !== "current" || editingTitle || editingTeamIndex !== null)
      return;

    const isFormElementFocused = () => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable) {
        return true;
      }
      return false;
    };

    const handlerEntries = [
      increaseHomeScore ? [increaseHomeScore.normalizedKey, () => bumpScoreCurrent(0, +1)] : null,
      decreaseHomeScore ? [decreaseHomeScore.normalizedKey, () => bumpScoreCurrent(0, -1)] : null,
      increaseAwayScore ? [increaseAwayScore.normalizedKey, () => bumpScoreCurrent(1, +1)] : null,
      decreaseAwayScore ? [decreaseAwayScore.normalizedKey, () => bumpScoreCurrent(1, -1)] : null,
      toggleServing
        ? [toggleServing.normalizedKey, () => setServing(scoreboard.servingTeamIndex === 0 ? 1 : 0)]
        : null,
    ].filter(Boolean);
    const handlerMap = new Map(handlerEntries);

    const onKey = (e) => {
      if (isFormElementFocused()) return;
      const key = typeof e.key === "string" ? e.key.toLowerCase() : "";
      const handler = handlerMap.get(key);
      if (handler) {
        e.preventDefault();
        handler();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    shortcutsEnabled,
    scoreboard,
    mode,
    editingTitle,
    editingTeamIndex,
    increaseHomeScore,
    decreaseHomeScore,
    increaseAwayScore,
    decreaseAwayScore,
    toggleServing,
    setServing,
    bumpScoreCurrent,
  ]);

  // Auto-clear backend errors
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => clearError?.(), 3000);
    return () => clearTimeout(t);
  }, [error, clearError]);

  const renderTopBar = () =>
    !showHeader ? null : (
      <div className="control-top-bar">
        <div className="control-top-copy">
          <h2 className="control-top-title">Control Panel</h2>
          <p className="control-top-subtitle">
            Share the overlay link with OBS and update the match from anywhere.
          </p>
        </div>
        <div className="control-settings">
          <SettingsMenu />
        </div>
      </div>
    );

  const currentScores = [
    fallbackTeams[0]?.score ?? 0,
    fallbackTeams[1]?.score ?? 0,
  ];
  const lastCompletedScores =
    totalCompletedSets > 0 ? getSetScores(sets[Math.min(totalCompletedSets - 1, sets.length - 1)] ?? {}) : null;
  const draftActiveFromCurrent =
    mode === "current" &&
    totalCompletedSets > 0 &&
    lastCompletedScores &&
    (currentScores[0] !== lastCompletedScores[0] || currentScores[1] !== lastCompletedScores[1]);
  useEffect(() => {
    if (!draftActiveFromCurrent && cachedCurrentScores === null && hasDraftOverride) {
      setHasDraftOverride(false);
    }
  }, [draftActiveFromCurrent, cachedCurrentScores, hasDraftOverride]);

  // Loading state
  if (loading) {
    return (
      <>
        {toastLayer}
        <div className="control-panel-root control-panel-empty">
          {renderTopBar()}
          <p className="hint">Loading control panel…</p>
        </div>
      </>
    );
  }

  const missingIdError = error?.toLowerCase().includes("missing scoreboard identifier");
  const displayedError = missingIdError ? null : error;

  // Empty state (no scoreboard)
  if (!scoreboard) {
    return (
      <>
        {toastLayer}
        <div className="control-panel-root control-panel-empty">
          {renderTopBar()}

          {showHeader && (
            <div className="control-empty-header">
              <div>
                <h2 className="control-empty-title">Control Panel</h2>
                <p className="control-empty-subtitle">Load a scoreboard to begin.</p>
              </div>
            </div>
          )}

          <p className="control-empty-message">No scoreboard loaded.</p>

          <form className="manual-load-form" onSubmit={handleManualSubmit}>
            <label className="input-label" htmlFor="manualId">
              Scoreboard ID
            </label>
            <div className="manual-load-controls">
              <input
                id="manualId"
                className="manual-load-input"
                placeholder="Enter scoreboard ID"
                value={manualId}
                onChange={(e) => setManualId(e.target.value.toUpperCase())}
              />
              <button className="primary-button" type="submit">
                Load
              </button>
            </div>
            <p className="manual-load-hint">
              Paste the 24-character ID or 6-letter code from the setup page.
            </p>
          </form>

          {displayedError && <p className="error" style={{ marginTop: "0.75rem" }}>{displayedError}</p>}
        </div>
      </>
    );
  }

  /* ---------- main UI (scoreboard loaded) ---------- */

  // Reusable render for score buttons
  const renderScoreControls = (teamIndex) => {
    if (mode === "current") {
      const t = fallbackTeams[teamIndex];
      const baseDecreaseLabel = `Decrease ${t.name} score`;
      const baseIncreaseLabel = `Increase ${t.name} score`;
      const decreaseShortcut =
        teamIndex === 0 ? decreaseHomeScore : decreaseAwayScore;
      const increaseShortcut =
        teamIndex === 0 ? increaseHomeScore : increaseAwayScore;
      const decreaseAttrs = buildShortcutAttributes(baseDecreaseLabel, decreaseShortcut);
      const increaseAttrs = buildShortcutAttributes(baseIncreaseLabel, increaseShortcut);
      return (
        <>
          <button
            type="button"
            className="score-chip"
            onClick={() => bumpScoreCurrent(teamIndex, -1)}
            {...decreaseAttrs}
          >
            −
          </button>
          <div className="control-card-score">{t.score ?? 0}</div>
          <button
            type="button"
            className="score-chip"
            onClick={() => bumpScoreCurrent(teamIndex, +1)}
            {...increaseAttrs}
          >
            +
          </button>
        </>
      );
    }
    // history
    const [homeScore, awayScore] = getSetScores(sets[historyIndex] ?? {});
    const value = teamIndex === 0 ? homeScore : awayScore;
    return (
      <>
        <button type="button" aria-label="Decrease score" className="score-chip" onClick={() => bumpScoreHistory(teamIndex, -1)}>
          −
        </button>
        <div className="control-card-score">{value ?? 0}</div>
        <button type="button" aria-label="Increase score" className="score-chip" onClick={() => bumpScoreHistory(teamIndex, +1)}>
          +
        </button>
      </>
    );
  };

  const { totalSetCount, activeSetNumber, deleteLabelNumber, hasCompletedSets } = deriveSetNavigationState({
    mode,
    totalCompletedSets,
    historyIndex: displayedHistoryIndex,
  });
  const deleteStateEligible = shouldEnableDeleteSet({
    mode,
    totalCompletedSets,
    historyIndex,
  });
  const statusText = `Editing Set ${activeSetNumber} of ${totalSetCount}`;
  const deleteButtonLabel = deleteLabelNumber > 0 ? `Delete Set ${deleteLabelNumber}` : "Delete Set";

  const toggleColorPanel = (teamIndex) => {
    setCollapsedColorPanels((prev) => ({
      ...prev,
      [teamIndex]: !prev?.[teamIndex],
    }));
  };

  const toggleScoreColors = () => {
    setIsScoreColorsCollapsed((prev) => !prev);
  };

  const hasActiveScores = scoreboard?.teams?.some((t) => (t.score ?? 0) > 0);
  const disableDeleteSet = !deleteStateEligible;
  const canArchiveMoreSets = totalCompletedSets < MAX_COMPLETED_SETS;

  return (
    <>
      {toastLayer}
      <div className="control-panel-root">
        {renderTopBar()}
        {scoreboard?.temporary && (
          <div className="temporary-banner" role="status">
            <div className="temporary-banner__text">
              <strong>Temporary scoreboard</strong>
              <span>This scoreboard may be deleted after 24 hours. Sign in to keep it.</span>
            </div>
            <a className="temporary-banner__action" href="/?mode=signin">
              Sign in to save
            </a>
          </div>
        )}

        {showHeader && (
          <header className="cp-header">
            <div className="cp-actions">
              <label className="cp-compact-toggle">
                <input
                  type="checkbox"
                  onChange={(e) => updateScoreboard({ compact: !!e.target.checked })}
                  checked={!!scoreboard?.compact}
                />
                <span>Compact mode</span>
              </label>
            </div>
          </header>
        )}

        {/* Title row (Home-style inline edit) */}
        <div className="control-title-card">
          <div className="control-title-label">Scoreboard Title</div>

          {!editingTitle ? (
            <div className="control-title-display">
              <h3 className="control-title-text">
                {scoreboard?.title?.trim() ? scoreboard.title : "Untitled"}
              </h3>
              <button
                type="button"
                className="team-name-button"
                title="Rename title"
                onClick={() => {
                  setTitleDraft(scoreboard?.title ?? "");
                  setEditingTitle(true);
                }}
              >
                <MdEdit />
              </button>
            </div>
          ) : (
              <div className="team-name-edit">
              <div className="input-count-wrapper">
                <input
                  className="control-title-input has-countdown"
                  value={titleDraft}
                  maxLength={MAX_TITLE}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveTitle();
                    if (e.key === "Escape") {
                      setEditingTitle(false);
                      setTitleDraft(scoreboard?.title ?? "");
                    }
                  }}
                  autoFocus
                />
                {titleRemaining <= 5 && <span className={titleCountdownClass}>{titleRemaining}</span>}
              </div>
              <div className="team-name-actions">
                <button type="button" className="team-name-button save" title="Save" onClick={saveTitle}>
                  <MdSave />
                </button>
                <button
                  type="button"
                  className="team-name-button cancel"
                  title="Cancel"
                  onClick={() => {
                    setEditingTitle(false);
                    setTitleDraft(scoreboard?.title ?? "");
                  }}
                >
                  <MdClose />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Control link row */}
        <div className="control-link-card">
          <div className="control-link-header">
            <span className="control-link-label">Control Link</span>
          </div>
          <div className="control-link-row">
            <a
              className="control-link-url"
              href={controlUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={controlUrl || "Control link"}
            >
              {controlUrl}
            </a>
            <button
              className={`control-link-copy ${controlCopied ? "is-copied" : ""}`}
              type="button"
              title={controlCopied ? "Copied!" : "Copy control link"}
              onClick={async () => {
                if (!controlUrl) return;
                try {
                  await navigator.clipboard.writeText(controlUrl);
                  setControlCopied(true);
                  setTimeout(() => setControlCopied(false), 1500);
                } catch {
                  /* ignore */
                }
              }}
              aria-live="polite"
            >
              <span className="copy-icon copy-icon--copy">
                <MdContentCopy />
              </span>
              <span className="copy-icon copy-icon--check" aria-hidden={!controlCopied}>
                ✓
              </span>
            </button>
          </div>
        </div>

        {/* Overlay link row (clickable + copy) */}
        <div className="control-link-card">
          <div className="control-link-header">
            <span className="control-link-label">Overlay Link</span>
          </div>
          <div className="control-link-row">
            <a
              className="control-link-url"
              href={overlayUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={overlayUrl || "Overlay link"}
            >
              {overlayUrl}
            </a>
            <button
              className={`control-link-copy ${overlayCopied ? "is-copied" : ""}`}
              type="button"
              title={overlayCopied ? "Copied!" : "Copy overlay link"}
              onClick={async () => {
                if (!overlayUrl) return;
                try {
                  await navigator.clipboard.writeText(overlayUrl);
                  setOverlayCopied(true);
                  setTimeout(() => setOverlayCopied(false), 1500);
                } catch {
                  /* ignore */
                }
              }}
              aria-live="polite"
            >
              <span className="copy-icon copy-icon--copy">
                <MdContentCopy />
              </span>
              <span className="copy-icon copy-icon--check" aria-hidden={!overlayCopied}>
                ✓
              </span>
            </button>
          </div>
        </div>

        <div className="score-preview-card">
          <div className="score-preview-header">
            <h3 className="score-preview-title">Overlay Preview</h3>
            <p className="score-preview-subtitle">Live view of the scoreboard with current settings.</p>
          </div>
          <div className="score-preview-frame">
            <ScoreboardOverlay
              scoreboard={scoreboard
                ? {
                    ...scoreboard,
                    teams: fallbackTeams,
                  }
                : {
                    teams: fallbackTeams,
                    sets,
                    servingTeamIndex: scoreboard?.servingTeamIndex ?? 0,
                    compact: scoreboard?.compact ?? false,
                  }}
            />
          </div>
        </div>

        {/* Prev / Next set controls */}
        <div className="set-nav">
          <button
            className="secondary-button set-nav-button prev"
            type="button"
            onClick={goToPreviousSet}
            disabled={mode === "current" ? sets.length === 0 : historyIndex === 0}
            title={mode === "current" ? "View previous sets" : "Go to earlier set"}
            aria-label={mode === "current" ? "Previous set" : "Go to earlier set"}
          >
            <MdChevronLeft className="set-nav-icon" />
            <span className="set-nav-text set-nav-text--long">Previous Set</span>
            <span className="set-nav-text set-nav-text--short" aria-hidden="true">
              Prev
            </span>
          </button>

          <div className="set-nav-status">{statusText}</div>

          <button
            className="secondary-button set-nav-button next"
            type="button"
            onClick={goToNextSet}
            disabled={
              mode === "current"
                ? !canArchiveMoreSets
                : sets.length === 0 || (historyIndex >= sets.length - 1 && sets.length >= MAX_TOTAL_SETS)
            }
            title={
              mode === "current"
                ? canArchiveMoreSets
                  ? "Save current as a completed set"
                  : `Maximum of ${MAX_TOTAL_SETS} sets reached`
                : "Go forward; past the last set returns to Current"
            }
            aria-label={
              mode === "current"
                ? canArchiveMoreSets
                  ? "Save current as a completed set"
                  : `Maximum of ${MAX_TOTAL_SETS} sets reached`
                : "Next set"
            }
          >
            <span className="set-nav-text set-nav-text--long">Next Set</span>
            <span className="set-nav-text set-nav-text--short" aria-hidden="true">
              Next
            </span>
            <MdChevronRight className="set-nav-icon" />
          </button>
        </div>

        {/* Toolbar */}
        <div className="control-toolbar">
          <button
            type="button"
            className="control-tool-button danger"
            onClick={deleteActiveSet}
            disabled={disableDeleteSet}
          >
            {deleteButtonLabel}
          </button>
          <button type="button" className="control-tool-button danger" onClick={resetSets} disabled={!hasCompletedSets}>
            Delete All Sets
          </button>
          <button type="button" className="control-tool-button reset" onClick={resetScores} disabled={!hasActiveScores}>
            Reset Scores
          </button>
        </div>

        {/* Team cards */}
        <div className="control-grid">
          {fallbackTeams.map((t, i) => {
            const isServing = mode === "current" && scoreboard.servingTeamIndex === i;
            const isEditingName = editingTeamIndex === i;
            const teamNameRemaining = isEditingName ? remaining(teamNameDraft, TEAM_NAME_LIMIT) : null;
            const teamCountdownClass = isEditingName
              ? `countdown ${teamNameRemaining <= 2 ? "warn" : ""}`.trim()
              : "countdown";
            const teamNameForHeading =
              scoreboard?.teams?.[i]?.name?.trim() || (i === 0 ? "Home" : "Away");
            const teamHeadingLabel = teamNameForHeading || `Team ${i + 1}`;
            const panelKey = `team-${i}-panel`;
            const textKey = `team-${i}-text`;
            const serveLabel = isServing
              ? `Unset ${teamHeadingLabel} as serving`
              : `Set ${teamHeadingLabel} to serve`;
            const serveShortcutAttrs = buildShortcutAttributes(serveLabel, toggleServing, {
              ariaLabel: serveLabel,
            });

            return (
              <div key={i} className={`control-card ${isServing ? "serving" : ""}`} style={{ "--team-accent": t.color }}>
                <div className="team-card-header">
                  {mode === "current" && (
                    <button
                      type="button"
                      className={`serve-toggle ${isServing ? "active" : ""}`}
                      onClick={() => setServing(i)}
                      {...serveShortcutAttrs}
                    >
                      {isServing ? "Serving" : "Set to serve"}
                    </button>
                  )}
                </div>

                <div className="team-card-field">
                  <label className="input-label">Team Name</label>

                  {isEditingName ? (
                    <div className="team-name-edit">
                      <div className="input-count-wrapper">
                        <input
                          className="team-name-input has-countdown"
                          value={teamNameDraft}
                          maxLength={TEAM_NAME_LIMIT}
                          onChange={(e) => setTeamNameDraft(e.target.value.slice(0, TEAM_NAME_LIMIT))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveTeamName(i);
                            if (e.key === "Escape") cancelEditTeamName();
                          }}
                          autoFocus
                        />
                        <span className={teamCountdownClass}>{teamNameRemaining}</span>
                      </div>
                      <div className="team-name-actions">
                        <button type="button" className="team-name-button save" title="Save name" onClick={() => saveTeamName(i)}>
                          <MdSave />
                        </button>
                        <button type="button" className="team-name-button cancel" title="Cancel rename" onClick={cancelEditTeamName}>
                          <MdClose />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="team-name-row">
                      <h4 className="team-name-text" title={t.name}>{formatTeamNameForControl(t.name)}</h4>
                      <button
                        type="button"
                        className="team-name-button"
                        title="Rename team"
                        onClick={() => startEditTeamName(i)}
                      >
                        <MdEdit />
                      </button>
                    </div>
                  )}
                </div>

                <div className="control-card-score-row">{renderScoreControls(i)}</div>

                <div
                  className={`team-color-controls ${
                    collapsedColorPanels?.[i] ? "is-collapsed" : ""
                  }`}
                >
                  <div className="team-color-header">
                    <h4
                      className="team-color-heading"
                      id={`team-colors-heading-${i}`}
                    >{`${teamHeadingLabel} Colors`}</h4>
                    <button
                      type="button"
                      className="team-color-toggle"
                      onClick={() => toggleColorPanel(i)}
                      aria-expanded={!collapsedColorPanels?.[i]}
                      aria-controls={`team-color-grid-${i}`}
                      title={`${collapsedColorPanels?.[i] ? "Expand" : "Collapse"} ${teamHeadingLabel} color controls`}
                    >
                      {collapsedColorPanels?.[i] ? <MdExpandMore /> : <MdExpandLess />}
                    </button>
                  </div>
                  <div
                    className="team-color-grid"
                    id={`team-color-grid-${i}`}
                    role="region"
                    aria-labelledby={`team-colors-heading-${i}`}
                    aria-hidden={!!collapsedColorPanels?.[i]}
                  >
                    <label className="team-color-field">
                      <span className="team-color-label">Panel</span>
                      <div className="team-color-inputs">
                        <input
                          type="color"
                          value={colorDrafts[panelKey] || t.color}
                          onChange={(e) => handlePanelColorInput(i, e.target.value)}
                        />
                        <input
                          type="text"
                          maxLength={7}
                          value={colorDrafts[panelKey] || ""}
                          onChange={(e) => handlePanelColorTextChange(i, e.target.value)}
                          onBlur={() => handlePanelColorBlur(i)}
                          aria-label={`${teamHeadingLabel} panel color hex`}
                        />
                      </div>
                    </label>
                    <label className="team-color-field">
                      <span className="team-color-label">Team Text</span>
                      <div className="team-color-inputs">
                        <input
                          type="color"
                          value={colorDrafts[textKey] || t.teamTextColor || t.textColor || "#ffffff"}
                          onChange={(e) => handleTeamTextColorInput(i, e.target.value)}
                        />
                        <input
                          type="text"
                          maxLength={7}
                          value={colorDrafts[textKey] || ""}
                          onChange={(e) => handleTeamTextColorTextChange(i, e.target.value)}
                          onBlur={() => handleTeamTextColorBlur(i)}
                          aria-label={`${teamHeadingLabel} text color hex`}
                        />
                      </div>
                    </label>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className={`score-color-card ${isScoreColorsCollapsed ? "is-collapsed" : ""}`}>
          <div className="score-color-header">
            <h3 className="score-color-title">Score Colors</h3>
            <p className="score-color-subtitle">Shared colors for the scoreboard columns.</p>
            <button
              type="button"
              className="score-color-toggle"
              onClick={toggleScoreColors}
              aria-expanded={!isScoreColorsCollapsed}
              aria-controls="score-color-grid"
              title={`${isScoreColorsCollapsed ? "Expand" : "Collapse"} score color controls`}
            >
              {isScoreColorsCollapsed ? <MdExpandMore /> : <MdExpandLess />}
            </button>
          </div>
          <div
            className="score-color-grid"
            id="score-color-grid"
            aria-hidden={isScoreColorsCollapsed}
          >
            <label className="score-color-field">
              <span className="score-color-label">Score Background</span>
              <div className="team-color-inputs">
                <input
                  type="color"
                  value={colorDrafts["score-bg"] || "#0b1a3a"}
                  onChange={(e) => handleScoreBgInput(e.target.value)}
                />
                <input
                  type="text"
                  maxLength={7}
                  value={colorDrafts["score-bg"] || ""}
                  onChange={(e) => handleScoreBgTextChange(e.target.value)}
                  onBlur={handleScoreBgBlur}
                  aria-label="Score background color hex"
                />
              </div>
            </label>
            <label className="score-color-field">
              <span className="score-color-label">Score Text</span>
              <div className="team-color-inputs">
                <input
                  type="color"
                  value={colorDrafts["score-text"] || "#ffffff"}
                  onChange={(e) => handleScoreTextInput(e.target.value)}
                />
                <input
                  type="text"
                  maxLength={7}
                  value={colorDrafts["score-text"] || ""}
                  onChange={(e) => handleScoreTextChange(e.target.value)}
                  onBlur={handleScoreTextBlur}
                  aria-label="Score text color hex"
                />
              </div>
            </label>
          </div>
        </div>
      </div>
    </>
  );
}

export default ControlPanelView;

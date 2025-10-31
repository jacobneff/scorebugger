import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  MdClose,
  MdContentCopy,
  MdChevronLeft,
  MdChevronRight,
  MdEdit,
  MdSave,
} from "react-icons/md";
import { FiCheckCircle, FiInfo, FiXCircle } from "react-icons/fi";
import { useScoreboard } from "../hooks/useScoreboard.js";
import SettingsMenu from "./SettingsMenu.jsx";
import ScoreboardOverlay from "./ScoreboardOverlay.jsx";
import { useSettings } from "../context/SettingsContext.jsx";
import { MAX_COMPLETED_SETS, MAX_TOTAL_SETS } from "../constants/scoreboard.js";

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

/* ---------- component ---------- */
function ControlPanelView({
  scoreboardId,
  showHeader = true,
  standalone = true, // unused but kept for API compatibility
  showTitleEditor = true, // superseded by inline title editor below
  onScoreboardChange,
}) {
  const { scoreboard, loading, error, updateScoreboard, clearError } = useScoreboard(scoreboardId);
  const { shortcutsEnabled } = useSettings();

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
  const setServing = (i) => {
    if (scoreboard?.servingTeamIndex === i) return;
    updateScoreboard({ servingTeamIndex: i });
  };

  const bumpScoreCurrent = (teamIndex, delta) => {
    if (!scoreboard?.teams) return;
    const nextTeams = scoreboard.teams.map((t, i) =>
      i === teamIndex ? { ...t, score: Math.max(0, (t.score ?? 0) + delta) } : t
    );
    const next = { teams: nextTeams };
    if (delta > 0) next.servingTeamIndex = teamIndex;
    updateScoreboard(next);
  };

  const bumpScoreHistory = (teamIndex, delta) => {
    if (!sets[historyIndex]) return;
    const current = normalizeSet(sets[historyIndex]);
    const [homeScore, awayScore] = current.scores;
    const clamp = (v) => Math.max(0, v);
    const nextScores =
      teamIndex === 0 ? [clamp(homeScore + delta), clamp(awayScore)] : [clamp(homeScore), clamp(awayScore + delta)];
    const nextSets = sets.map((s, idx) => (idx === historyIndex ? { ...normalizeSet(s), scores: nextScores } : normalizeSet(s)));
    updateScoreboard({ sets: nextSets });
  };

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
    return true;
  };


  const removeSetAtIndex = (idx, sourceMode = mode) => {
    if (!sets[idx]) return;

    const normalizedSets = sets.map((set) => normalizeSet(set));
    const nextSets = normalizedSets.filter((_, i) => i !== idx);
    const lastSet = nextSets[nextSets.length - 1] ?? null;
    const [carryHome, carryAway] = lastSet ? getSetScores(lastSet) : [0, 0];

    updateScoreboard((current) => {
      if (!current?.teams) {
        return current;
      }
      return {
        sets: nextSets,
        teams: current.teams.map((team, teamIdx) => ({
          ...team,
          score: teamIdx === 0 ? carryHome : carryAway,
        })),
      };
    });

    const hasSetsRemaining = nextSets.length > 0;
    const nextMode = hasSetsRemaining ? "history" : "current";
    const maxHistoryIndex = Math.max(0, nextSets.length - 1);
    const nextHistoryIndex = hasSetsRemaining
      ? sourceMode === "current"
        ? maxHistoryIndex
        : Math.min(idx, maxHistoryIndex)
      : 0;

    setMode(nextMode);
    setHistoryIndex(nextHistoryIndex);
    setCachedCurrentScores(null);
    showToast("info", `Set ${idx + 1} deleted`);
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
    showToast("info", "All sets deleted");
  };

  const deleteActiveSet = () => {
    if (disableDeleteSet) return;

    if (totalCompletedSets === 0) return;

    if (mode === "current") {
      removeSetAtIndex(totalCompletedSets - 1, "current");
      return;
    }

    removeSetAtIndex(displayedHistoryIndex, "history");
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

    const onKey = (e) => {
      if (isFormElementFocused()) return;
      const key = e.key.toLowerCase();
      if (key === "a") bumpScoreCurrent(0, +1);
      if (key === "z") bumpScoreCurrent(0, -1);
      if (key === "k") bumpScoreCurrent(1, +1);
      if (key === "m") bumpScoreCurrent(1, -1);
      if (key === "s") setServing(scoreboard.servingTeamIndex === 0 ? 1 : 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcutsEnabled, scoreboard, mode, editingTitle, editingTeamIndex]);

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
      return (
        <>
          <button
            type="button"
            aria-label={`Decrease ${t.name} score`}
            className="score-chip"
            onClick={() => bumpScoreCurrent(teamIndex, -1)}
          >
            −
          </button>
          <div className="control-card-score">{t.score ?? 0}</div>
          <button
            type="button"
            aria-label={`Increase ${t.name} score`}
            className="score-chip"
            onClick={() => bumpScoreCurrent(teamIndex, +1)}
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

  const currentSetNumber = Math.min(MAX_TOTAL_SETS, Math.max(1, totalCompletedSets + 1));
  const historySetCount = Math.max(1, Math.min(totalCompletedSets, MAX_TOTAL_SETS));
  const statusText =
    mode === "current"
      ? `Editing Set ${currentSetNumber} (Current)`
      : totalCompletedSets > 0
        ? `Viewing Set ${Math.min(displayedHistoryIndex + 1, historySetCount)} of ${historySetCount}`
        : "No completed sets";

  const deleteTargetSetNumber =
    mode === "current"
      ? Math.max(totalCompletedSets, 1)
      : Math.min(displayedHistoryIndex + 1, historySetCount);

  const hasActiveScores = scoreboard?.teams?.some((t) => (t.score ?? 0) > 0);
  const hasCompletedSets = totalCompletedSets > 0;
  const disableDeleteSet = totalCompletedSets === 0;
  const canArchiveMoreSets = totalCompletedSets < MAX_COMPLETED_SETS;

  return (
    <>
      {toastLayer}
      <div className="control-panel-root">
        {renderTopBar()}

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
          <div className="control-link-meta">
            <div className="control-link-label">Control Link</div>
            <a className="control-link-url" href={controlUrl} target="_blank" rel="noopener noreferrer">
              {controlUrl}
            </a>
          </div>
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

        {/* Overlay link row (clickable + copy) */}
        <div className="control-link-card">
          <div className="control-link-meta">
            <div className="control-link-label">Overlay Link</div>
            <a className="control-link-url" href={overlayUrl} target="_blank" rel="noopener noreferrer">
              {overlayUrl}
            </a>
          </div>
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
            className="secondary-button"
            type="button"
            onClick={goToPreviousSet}
            disabled={mode === "current" && sets.length === 0}
            title={mode === "current" ? "View previous sets" : "Go to earlier set"}
          >
            <MdChevronLeft style={{ marginRight: 6 }} />
            Previous Set
          </button>

          <div className="set-nav-status">{statusText}</div>

          <button
            className="secondary-button"
            type="button"
            onClick={goToNextSet}
            disabled={mode === "current" && !canArchiveMoreSets}
            title={
              mode === "current"
                ? canArchiveMoreSets
                  ? "Save current as a completed set"
                  : `Maximum of ${MAX_TOTAL_SETS} sets reached`
                : "Go forward; past the last set returns to Current"
            }
          >
            Next Set
            <MdChevronRight style={{ marginLeft: 6 }} />
          </button>
        </div>

        {/* Toolbar */}
        <div className="control-toolbar">
          <button type="button" className="control-tool-button" onClick={resetScores} disabled={!hasActiveScores}>
            Reset Scores
          </button>
          <button
            type="button"
            className="control-tool-button danger"
            onClick={deleteActiveSet}
            disabled={disableDeleteSet}
          >
            Delete Set {deleteTargetSetNumber}
          </button>
          <button type="button" className="control-tool-button danger" onClick={resetSets} disabled={!hasCompletedSets}>
            Delete All Sets
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

            return (
              <div key={i} className={`control-card ${isServing ? "serving" : ""}`} style={{ "--team-accent": t.color }}>
                <div className="team-card-header">
                  {mode === "current" && (
                    <button
                      type="button"
                      className={`serve-toggle ${isServing ? "active" : ""}`}
                      onClick={() => setServing(i)}
                      title="Toggle serving"
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

                <div className="team-color-controls">
                  <div className="team-color-header">
                    <h4 className="team-color-heading">{`${teamHeadingLabel} Colors`}</h4>
                  </div>
                  <div className="team-color-grid">
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

        <div className="score-color-card">
          <div className="score-color-header">
            <h3 className="score-color-title">Score Colors</h3>
            <p className="score-color-subtitle">Shared colors for the scoreboard columns.</p>
          </div>
          <div className="score-color-grid">
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

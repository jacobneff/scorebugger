import { useEffect, useMemo, useState } from "react";
import { MdContentCopy, MdDelete, MdEdit, MdSave } from "react-icons/md";
import { FiCheckCircle, FiInfo, FiXCircle } from "react-icons/fi";
import ControlPanelView from "../components/ControlPanelView.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import SettingsMenu from "../components/SettingsMenu.jsx";
import { API_URL } from "../config/env.js";

const defaultTeams = [
  {
    name: "Home",
    color: "#2563eb",
    teamTextColor: "#ffffff",
    setColor: "#0b1a3a",
    scoreTextColor: "#ffffff",
    textColor: "#ffffff",
  },
  {
    name: "Away",
    color: "#16a34a",
    teamTextColor: "#ffffff",
    setColor: "#0b1a3a",
    scoreTextColor: "#ffffff",
    textColor: "#ffffff",
  },
];

function Home() {
  const { user, token, logout, login, register, authBusy } = useAuth();

  // Create form
  const [teams, setTeams] = useState(defaultTeams);
  const [newTitle, setNewTitle] = useState("");

  // General
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  // Boards
  const [boards, setBoards] = useState([]);
  const [boardsLoading, setBoardsLoading] = useState(false);
  const [boardsError, setBoardsError] = useState(null);
  const [copiedBoardId, setCopiedBoardId] = useState(null);

  // Tabs
  const [activeTab, setActiveTab] = useState("setup");
  const [selectedBoardId, setSelectedBoardId] = useState("");

  // Rename
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState("");

  // Toasts (stack)
  const [toasts, setToasts] = useState([]);

  // Auth panel
  const [authMode, setAuthMode] = useState("signin"); // 'signin' | 'signup'
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authDisplayName, setAuthDisplayName] = useState("");
  const [authError, setAuthError] = useState("");

  const MAX_TITLE = 30;
  const TEAM_NAME_LIMIT = 10;
  const remaining = (v, limit = MAX_TITLE) => limit - (v?.length ?? 0);

  const openBoard = (id) => {
    if (!id) return;
    setSelectedBoardId(String(id).toUpperCase());
    setActiveTab("control");
  };

  const handleInputChange = (index, field, value) =>
    setTeams((prevTeams) =>
      prevTeams.map((team, idx) => {
        if (idx !== index) return team;
        if (field === "color") {
          const next = { ...team, color: value };
          if (!team.setColor || team.setColor === team.color) {
            next.setColor = value;
          }
          return next;
        }
        if (field === "name") {
          const nextName = value.slice(0, TEAM_NAME_LIMIT);
          return { ...team, name: nextName };
        }
        return { ...team, [field]: value };
      })
    );

  const showToast = (type, message) => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 2500);
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!token) return setError("Please sign in to create a scoreboard.");
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/scoreboards`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          teams,
          title: newTitle?.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error("Error creating scoreboard");
      const data = await res.json();
      setBoards((b) => [data, ...b]);
      setResult(data);
      setNewTitle("");
      showToast("success", "Scoreboard created");
      setTimeout(() => openBoard(data.code || data._id), 200);
    } catch (err) {
      setError(err.message);
      showToast("error", "Failed to create scoreboard");
    } finally {
      setLoading(false);
    }
  };

  const identifier = useMemo(() => result?.code || result?._id || null, [result]);

  const fetchBoards = async () => {
    if (!token) return;
    setBoardsLoading(true);
    setBoardsError(null);
    try {
      const res = await fetch(`${API_URL}/api/scoreboards/mine`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Unable to load your scoreboards.");
      const data = await res.json();
      setBoards(data);
    } catch (err) {
      setBoardsError(err.message);
    } finally {
      setBoardsLoading(false);
    }
  };

  useEffect(() => {
    fetchBoards();
  }, [token]);

  const formatCompactTime = (value) => {
    if (!value) return "";
    const diff = Date.now() - new Date(value).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };

  const handleRenameSave = async (id) => {
    const trimmed = editValue.trim().slice(0, MAX_TITLE);
    if (!trimmed) return;
    setBoards((prev) =>
      prev.map((b) => (b._id === id ? { ...b, title: trimmed, updatedAt: new Date().toISOString() } : b))
    );
    setEditingId(null);
    showToast("info", "Saved");
    try {
      const res = await fetch(`${API_URL}/api/scoreboards/${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) throw new Error("Rename failed");
      const data = await res.json();
      setBoards((prev) => prev.map((b) => (b._id === data._id ? { ...b, ...data } : b)));
    } catch (err) {
      showToast("error", err.message);
      fetchBoards();
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Delete this scoreboard?")) return;
    const prevBoards = boards;
    setBoards((p) => p.filter((b) => b._id !== id));
    try {
      const res = await fetch(`${API_URL}/api/scoreboards/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Delete failed");
      showToast("error", "Scoreboard deleted");
    } catch (err) {
      setBoards(prevBoards);
      showToast("error", err.message);
    }
  };

  const boardTitle = (b) => b.title || "New Scoreboard";

  const handleCopyBoardId = async (value, id) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedBoardId(id);
      setTimeout(() => {
        setCopiedBoardId((prev) => (prev === id ? null : prev));
      }, 1500);
    } catch (err) {
      showToast("error", "Unable to copy ID");
    }
  };

  // --- Auth submit handler (uses AuthContext) ---
  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setAuthError("");
    if (authMode === "signin") {
      const res = await login({ email: authEmail, password: authPassword });
      if (!res?.ok) {
        setAuthError(res?.message || "Unable to sign in");
        showToast("error", res?.message || "Unable to sign in");
      } else {
        showToast("success", "Signed in");
      }
    } else {
      const res = await register({
        email: authEmail,
        password: authPassword,
        displayName: authDisplayName,
      });
      if (!res?.ok) {
        setAuthError(res?.message || "Unable to create account");
        showToast("error", res?.message || "Unable to create account");
      } else {
        showToast("success", "Account created");
      }
    }
  };

  return (
    <main className="container">
      {/* Toast Stack */}
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

      <section className={`card home-card fade-section ${activeTab}`}>
        <div className="card-settings">
          <SettingsMenu />
        </div>
        {activeTab === "setup" ? (
          <>
            <h1 className="title">SETPOINT</h1>
            <p className="subtitle">
              A volleyball scoreboard you can control and embed live in your stream.
            </p>
          </>
        ) : (
          <>
            <h1 className="title">Control Panel</h1>
            <p className="subtitle">
              Share the overlay link with OBS and update the match from anywhere.
            </p>
          </>
        )}

        <div className="home-tabs">
          <button
            className={`home-tab-button ${activeTab === "setup" ? "active" : ""}`}
            onClick={() => setActiveTab("setup")}
          >
            Setup
          </button>
          <button
            className={`home-tab-button ${activeTab === "control" ? "active" : ""}`}
            onClick={() => setActiveTab("control")}
          >
            Control
          </button>
        </div>

        {activeTab === "setup" ? (
          <div className="home-tabpanel fadein">
            <div className="home-grid">
              <form className="form" onSubmit={handleCreate}>
                <fieldset className="fieldset modern-fieldset">
                  <legend>Scoreboard Title</legend>
                  <div className="input-count-wrapper input-count-wrapper--stretch">
                    <input
                      className={`title-input ${remaining(newTitle) <= 5 ? "has-countdown" : ""}`}
                      type="text"
                      placeholder="New Scoreboard"
                      maxLength={MAX_TITLE}
                      value={newTitle}
                      disabled={!user}
                      onChange={(e) => setNewTitle(e.target.value)}
                    />
                    {remaining(newTitle) <= 5 && (
                      <span className="countdown">{remaining(newTitle)}</span>
                    )}
                  </div>
                </fieldset>

                <fieldset className="fieldset modern-fieldset">
                  <legend>Team Setup</legend>
                  {teams.map((t, i) => {
                    const nameRemaining = remaining(t.name, TEAM_NAME_LIMIT);
                    const showCountdown = nameRemaining <= 3;
                    const countdownClass = `countdown ${showCountdown && nameRemaining <= 1 ? "warn" : ""}`.trim();
                    const inputClass = `team-setup-input${showCountdown ? " has-countdown" : ""}`.trim();

                    return (
                      <div key={i} className="team-config modern-team-card">
                        <div className="team-accent" style={{ backgroundColor: t.color }} />
                        <div className="team-body">
                          <label className="input-label">Name</label>
                          <div className="input-count-wrapper">
                            <input
                              className={inputClass}
                              type="text"
                              required
                              disabled={!user}
                              maxLength={TEAM_NAME_LIMIT}
                              value={t.name}
                              onChange={(e) => handleInputChange(i, "name", e.target.value)}
                            />
                            {showCountdown && <span className={countdownClass}>{nameRemaining}</span>}
                          </div>
                          <label className="input-label">Accent Color</label>
                          <input
                            type="color"
                            disabled={!user}
                            value={t.color}
                            onChange={(e) => handleInputChange(i, "color", e.target.value)}
                          />
                        </div>
                      </div>
                    );
                  })}
                </fieldset>

                {/* Hide left CTA when logged out */}
                {user && (
                  <button className="primary-button" type="submit" disabled={loading}>
                    {loading ? "Creating..." : "Create Scoreboard"}
                  </button>
                )}
              </form>

              <aside className="account-panel">
                {user ? (
                  <>
                    <div className="account-header">
                      <h2>Welcome back</h2>
                      <p>
                        Signed in as <b>{user.displayName || user.email}</b>
                      </p>
                      <button className="ghost-button" onClick={logout}>
                        Sign out
                      </button>
                    </div>

                    <div className="boards-list">
                      <h3>Your Scoreboards</h3>
                      {boardsLoading && <p>Loading...</p>}
                      {boardsError && <p className="error">{boardsError}</p>}
                      {!boardsLoading && boards.length === 0 && (
                        <p className="subtle">No scoreboards yet.</p>
                      )}

                      {boards.map((b) => {
                        const id = b.code || b._id;
                        const rawIdentifier = b.code || b._id || "";
                        const alphanumeric = (rawIdentifier.match(/[a-z0-9]/gi) || [])
                          .join("")
                          .toUpperCase();
                        const shortIdentifier =
                          alphanumeric.slice(0, 5) || rawIdentifier.slice(0, 5).toUpperCase();
                        const displayIdentifier = shortIdentifier || "-----";
                        return (
                          <div key={id} className="board-item" onClick={() => openBoard(id)}>
                            <div className="board-title-wrap">
                              {editingId === b._id ? (
                                <div className="input-count-wrapper" style={{ width: "100%" }}>
                                  <input
                                    className="edit-input"
                                    value={editValue}
                                    maxLength={MAX_TITLE}
                                    onChange={(e) => setEditValue(e.target.value)}
                                    onClick={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") handleRenameSave(b._id);
                                      if (e.key === "Escape") setEditingId(null);
                                    }}
                                    autoFocus
                                  />
                                  {remaining(editValue) <= 5 && (
                                    <span className="countdown">{remaining(editValue)}</span>
                                  )}
                                </div>
                              ) : (
                                <h4 className="board-title-text">{boardTitle(b)}</h4>
                              )}
                              <div className="board-meta">
                                <span className="board-updated">
                                  {formatCompactTime(b.updatedAt)}
                                </span>
                                <div className="board-icons" onClick={(e) => e.stopPropagation()}>
                                  {editingId === b._id ? (
                                    <div
                                      className="icon-box blue"
                                      title="Save"
                                      onClick={() => handleRenameSave(b._id)}
                                    >
                                      <MdSave />
                                    </div>
                                  ) : (
                                    <div
                                      className="icon-box blue"
                                      title="Rename"
                                      onClick={() => {
                                        setEditingId(b._id);
                                        setEditValue(boardTitle(b));
                                      }}
                                    >
                                      <MdEdit />
                                    </div>
                                  )}
                                  <div
                                    className="icon-box red"
                                    title="Delete"
                                    onClick={() => handleDelete(b._id)}
                                  >
                                    <MdDelete />
                                  </div>
                                </div>
                              </div>
                            </div>
                            <div
                              className="board-code-row"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <span className="board-code-badge" aria-label="Scoreboard ID">
                                {displayIdentifier}
                              </span>
                              <button
                                type="button"
                                className={`board-code-copy ${
                                  copiedBoardId === id ? "is-copied" : ""
                                }`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCopyBoardId(rawIdentifier, id);
                                }}
                                aria-label="Copy scoreboard ID"
                              >
                                <span className="copy-icon copy-icon--copy">
                                  <MdContentCopy />
                                </span>
                                <span
                                  className="copy-icon copy-icon--check"
                                  aria-hidden={copiedBoardId !== id}
                                >
                                  ✓
                                </span>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <div className="auth-card">
                    <div className="auth-header">
                      <h2 className="secondary-title" style={{ marginBottom: 4 }}>
                        {authMode === "signin" ? "Sign in" : "Create account"}
                      </h2>
                      <p className="subtle" style={{ margin: 0 }}>
                        {authMode === "signin"
                          ? "Access your scoreboards and control them from anywhere."
                          : "Create an account to save and manage your scoreboards."}
                      </p>
                    </div>

                    <div className="auth-switch" role="tablist" aria-label="Authentication mode">
                      <button
                        type="button"
                        role="tab"
                        className={`auth-switch-button ${authMode === "signin" ? "active" : ""}`}
                        aria-selected={authMode === "signin"}
                        onClick={() => setAuthMode("signin")}
                      >
                        Sign in
                      </button>
                      <button
                        type="button"
                        role="tab"
                        className={`auth-switch-button ${authMode === "signup" ? "active" : ""}`}
                        aria-selected={authMode === "signup"}
                        onClick={() => setAuthMode("signup")}
                      >
                        Create account
                      </button>
                    </div>

                    <form className="account-form auth-form" onSubmit={handleAuthSubmit}>
                      {authMode === "signup" && (
                        <>
                          <label className="input-label" htmlFor="displayName">Display Name</label>
                          <input
                            id="displayName"
                            type="text"
                            placeholder="Your name"
                            value={authDisplayName}
                            onChange={(e) => setAuthDisplayName(e.target.value)}
                          />
                        </>
                      )}

                      <label className="input-label" htmlFor="email">Email</label>
                      <input
                        id="email"
                        type="email"
                        placeholder="you@example.com"
                        required
                        value={authEmail}
                        onChange={(e) => setAuthEmail(e.target.value)}
                      />

                      <label className="input-label" htmlFor="password">Password</label>
                      <input
                        id="password"
                        type="password"
                        placeholder="••••••••"
                        required
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                      />

                      {authError && <p className="error" style={{ marginTop: 4 }}>{authError}</p>}

                      <button
                        className="primary-button"
                        type="submit"
                        disabled={authBusy}
                        style={{ width: "100%", marginTop: "0.25rem" }}
                      >
                        {authBusy
                          ? authMode === "signin" ? "Signing in..." : "Creating..."
                          : authMode === "signin" ? "Sign in" : "Create account"}
                      </button>
                    </form>
                  </div>
                )}
              </aside>
            </div>

            {error && <p className="error">{error}</p>}
          </div>
        ) : (
          <div className="home-tabpanel fadein">
            <ControlPanelView
              scoreboardId={selectedBoardId}
              standalone={false}
              showHeader={false}
              onScoreboardChange={(nextId) => {
                const cleaned = nextId?.trim();
                if (!cleaned) return;
                setSelectedBoardId(cleaned.toUpperCase());
                setActiveTab("control");
              }}
            />
          </div>
        )}
      </section>

    </main>
  );
}

export default Home;

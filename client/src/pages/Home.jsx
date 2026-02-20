import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MdContentCopy, MdDelete, MdEdit, MdSave } from "react-icons/md";
import { FiCheckCircle, FiInfo, FiXCircle } from "react-icons/fi";
import { useNavigate, useSearchParams } from "react-router-dom";
import ControlPanelView from "../components/ControlPanelView.jsx";
import TournamentsTab from "../components/TournamentsTab.jsx";
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
  const {
    user,
    token,
    logout,
    login,
    register,
    authBusy,
    resendVerification,
    requestPasswordReset,
    changePassword,
  } = useAuth();

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

  const claimInFlightRef = useRef(false);
  const claimAttemptsRef = useRef(0);
  const claimRetryTimerRef = useRef(null);
  const [claimRetryTick, setClaimRetryTick] = useState(0);

  // Tabs
  const [activeTab, setActiveTab] = useState("setup");
  const [activeService, setActiveService] = useState("landing");
  const [selectedBoardId, setSelectedBoardId] = useState("");
  const [selectedTournamentId, setSelectedTournamentId] = useState("");

  // Rename
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState("");

  // Toasts (stack)
  const [toasts, setToasts] = useState([]);

  // Auth panel
  const [authMode, setAuthMode] = useState("signin"); // 'signin' | 'signup' | 'verify' | 'forgot'
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authDisplayName, setAuthDisplayName] = useState("");
  const [authError, setAuthError] = useState("");
  const [authInfo, setAuthInfo] = useState("");
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState("");
  const [resendBusy, setResendBusy] = useState(false);
  const [forgotBusy, setForgotBusy] = useState(false);

  // Change password (authenticated)
  const [currentPasswordInput, setCurrentPasswordInput] = useState("");
  const [newPasswordInput, setNewPasswordInput] = useState("");
  const [confirmPasswordInput, setConfirmPasswordInput] = useState("");
  const [changePasswordBusy, setChangePasswordBusy] = useState(false);
  const [changePasswordError, setChangePasswordError] = useState("");
  const [changePasswordInfo, setChangePasswordInfo] = useState("");

  const authHeading = useMemo(() => {
    switch (authMode) {
      case "signup":
        return "Create account";
      case "forgot":
        return "Reset password";
      case "verify":
        return "Check your inbox";
      default:
        return "Sign in";
    }
  }, [authMode]);

  const authSubheading = useMemo(() => {
    switch (authMode) {
      case "signup":
        return "Create an account to save and manage your scoreboards.";
      case "forgot":
        return "Enter your email and we'll send you a reset link.";
      case "verify":
        return pendingVerificationEmail
          ? `We sent a verification link to ${pendingVerificationEmail}.`
          : "We sent a verification link to your email address.";
      default:
        return "Access your scoreboards and control them from anywhere.";
    }
  }, [authMode, pendingVerificationEmail]);

  const MAX_TITLE = 30;
  const TEAM_NAME_LIMIT = 10;
  const remaining = (v, limit = MAX_TITLE) => limit - (v?.length ?? 0);

  const openBoard = (id) => {
    if (!id) return;
    setSelectedBoardId(String(id).toUpperCase());
    setActiveService("scoreboards");
    setActiveTab("control");
  };

  const handleForgotSubmit = async (e) => {
    e.preventDefault();
    setAuthError("");
    setAuthInfo("");
    setForgotBusy(true);
    try {
      const res = await requestPasswordReset(authEmail);
      if (!res?.ok) {
        setAuthError(res?.message || "Unable to send reset email");
        showToast("error", res?.message || "Unable to send reset email");
      } else {
        setAuthInfo(
          res?.message ||
            "If that account exists, you will receive password reset instructions shortly."
        );
        showToast(
          "info",
          res?.message ||
            "If that account exists, you will receive password reset instructions shortly."
        );
      }
    } finally {
      setForgotBusy(false);
    }
  };

  const handleResendVerification = async () => {
    const targetEmail = pendingVerificationEmail || authEmail;
    if (!targetEmail) return;
    setAuthError("");
    setAuthInfo("");
    setResendBusy(true);
    try {
      const res = await resendVerification(targetEmail);
      if (!res?.ok) {
        setAuthError(res?.message || "Unable to resend verification email");
        showToast("error", res?.message || "Unable to resend verification email");
      } else {
        setAuthInfo(res?.message || "Verification email sent. Check your inbox.");
        setPendingVerificationEmail(targetEmail);
        showToast("info", res?.message || "Verification email sent. Check your inbox.");
      }
    } finally {
      setResendBusy(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setChangePasswordError("");
    setChangePasswordInfo("");

    if (!currentPasswordInput.trim() || !newPasswordInput.trim()) {
      setChangePasswordError("All password fields are required");
      return;
    }

    if (newPasswordInput !== confirmPasswordInput) {
      setChangePasswordError("New passwords do not match");
      return;
    }

    setChangePasswordBusy(true);
    try {
      const res = await changePassword({
        currentPassword: currentPasswordInput,
        newPassword: newPasswordInput,
      });

      if (!res?.ok) {
        setChangePasswordError(res?.message || "Unable to update password");
        showToast("error", res?.message || "Unable to update password");
        return;
      }

      setChangePasswordInfo(res?.message || "Password updated successfully");
      setCurrentPasswordInput("");
      setNewPasswordInput("");
      setConfirmPasswordInput("");
      showToast("success", res?.message || "Password updated successfully");
    } finally {
      setChangePasswordBusy(false);
    }
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
        if (field === "teamTextColor" || field === "textColor") {
          return {
            ...team,
            teamTextColor: value,
            textColor: value,
          };
        }
        if (field === "name") {
          const nextName = value.slice(0, TEAM_NAME_LIMIT);
          return { ...team, name: nextName };
        }
        return { ...team, [field]: value };
      })
    );

  const showToast = useCallback((type, message) => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 2500);
  }, []);

  const switchAuthMode = useCallback((mode) => {
    setAuthMode(mode);
    setAuthError("");
    setAuthInfo("");
    if (mode !== "verify") {
      setPendingVerificationEmail("");
    }
  }, []);

  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const initializedFromQuery = useRef(false);
  const returnToTarget = useMemo(() => {
    const rawValue = searchParams.get("returnTo");
    const normalized = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!normalized || !normalized.startsWith("/") || normalized.startsWith("//")) {
      return "";
    }
    return normalized;
  }, [searchParams]);

  useEffect(() => {
    if (initializedFromQuery.current) return;

    const modeParam = searchParams.get("mode");
    const emailParam = searchParams.get("email");
    const tabParam = searchParams.get("tab");
    const tournamentIdParam = searchParams.get("tournamentId");

    if (modeParam) {
      const normalizedMode = modeParam.toLowerCase();
      if (["signin", "signup", "forgot", "verify"].includes(normalizedMode)) {
        switchAuthMode(normalizedMode);
        if (normalizedMode === "verify") {
          if (emailParam) {
            setPendingVerificationEmail(emailParam);
            setAuthInfo(`We sent a verification link to ${emailParam}.`);
          } else {
            setAuthInfo("Check your inbox and click the verification link to continue.");
          }
        }
      }
    }

    const normalizedTab =
      typeof tabParam === "string" ? tabParam.trim().toLowerCase() : "";
    if (["setup", "control"].includes(normalizedTab)) {
      setActiveTab(normalizedTab);
      setActiveService("scoreboards");
    }
    if (normalizedTab === "tournaments") {
      setActiveTab("tournaments");
      setActiveService("tournaments");
    }

    const normalizedTournamentId =
      typeof tournamentIdParam === "string" ? tournamentIdParam.trim() : "";
    if (normalizedTournamentId) {
      setSelectedTournamentId(normalizedTournamentId);
      if (!["setup", "control", "tournaments"].includes(normalizedTab)) {
        setActiveService("tournaments");
        setActiveTab("tournaments");
      }
    }

    initializedFromQuery.current = true;
  }, [searchParams, switchAuthMode]);

  const syncHomeQuery = useCallback(
    ({ service, tab, tournamentId = "" }) => {
      const nextParams = new URLSearchParams(searchParams);

      if (service === "landing") {
        nextParams.delete("tab");
        nextParams.delete("tournamentId");
      } else if (service === "scoreboards") {
        nextParams.set("tab", tab === "control" ? "control" : "setup");
        nextParams.delete("tournamentId");
      } else if (service === "tournaments") {
        nextParams.set("tab", "tournaments");
        if (typeof tournamentId === "string" && tournamentId.trim()) {
          nextParams.set("tournamentId", tournamentId.trim());
        } else {
          nextParams.delete("tournamentId");
        }
      }

      if (nextParams.toString() !== searchParams.toString()) {
        setSearchParams(nextParams);
      }
    },
    [searchParams, setSearchParams]
  );

  const openScoreboardsService = useCallback(
    (tab = "setup") => {
      const normalizedTab = tab === "control" ? "control" : "setup";
      setActiveService("scoreboards");
      setActiveTab(normalizedTab);
      syncHomeQuery({ service: "scoreboards", tab: normalizedTab });
    },
    [syncHomeQuery]
  );

  const openTournamentsService = useCallback(() => {
    setActiveService("tournaments");
    setActiveTab("tournaments");
    syncHomeQuery({
      service: "tournaments",
      tab: "tournaments",
      tournamentId: selectedTournamentId,
    });
  }, [selectedTournamentId, syncHomeQuery]);

  const openServicesLanding = useCallback(() => {
    setActiveService("landing");
    syncHomeQuery({ service: "landing" });
  }, [syncHomeQuery]);

  useEffect(() => {
    if (!initializedFromQuery.current || activeService !== "tournaments") {
      return;
    }

    syncHomeQuery({
      service: "tournaments",
      tab: "tournaments",
      tournamentId: selectedTournamentId,
    });
  }, [activeService, selectedTournamentId, syncHomeQuery]);

  useEffect(() => {
    if (!initializedFromQuery.current || activeService !== "scoreboards") {
      return;
    }

    syncHomeQuery({
      service: "scoreboards",
      tab: activeTab === "control" ? "control" : "setup",
    });
  }, [activeService, activeTab, syncHomeQuery]);

  const handleCreate = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const isAuthenticated = Boolean(token);
    const endpoint = isAuthenticated
      ? `${API_URL}/api/scoreboards`
      : `${API_URL}/api/scoreboards/guest`;

    const headers = { 'Content-Type': 'application/json' };
    if (isAuthenticated) {
      headers.Authorization = `Bearer ${token}`;
    }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          teams,
          title: newTitle?.trim() || undefined,
        }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok || !data) {
        throw new Error(data?.message || 'Error creating scoreboard');
      }

      if (isAuthenticated) {
        setBoards((b) => [data, ...b]);
        showToast('success', 'Scoreboard created');
      } else {
        showToast('info', 'Temporary scoreboard ready');
      }

      setResult(data);
      setNewTitle('');
      setTimeout(() => openBoard(data.code || data._id), 200);
    } catch (err) {
      const message = err?.message || 'Failed to create scoreboard';
      setError(message);
      showToast('error', message);
    } finally {
      setLoading(false);
    }
  };

  const temporaryScoreboardId = result?._id;
  const isTemporaryScoreboard = Boolean(result?.temporary);

  const fetchBoards = useCallback(async () => {
    if (!token) return;
    setBoardsLoading(true);
    setBoardsError(null);
    try {
      const res = await fetch(`${API_URL}/api/scoreboards/mine`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Unable to load your scoreboards.');
      const data = await res.json();
      setBoards(data);
    } catch (err) {
      setBoardsError(err.message);
    } finally {
      setBoardsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchBoards();
  }, [fetchBoards]);

  useEffect(() => () => {
    if (claimRetryTimerRef.current) {
      clearTimeout(claimRetryTimerRef.current);
      claimRetryTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!user || !token || !isTemporaryScoreboard || !temporaryScoreboardId) {
      return;
    }

    if (claimAttemptsRef.current >= 3 || claimInFlightRef.current) {
      return;
    }

    let cancelled = false;

    const attemptClaim = async () => {
      if (claimAttemptsRef.current >= 3 || claimInFlightRef.current) {
        return;
      }

      claimInFlightRef.current = true;

      try {
        const res = await fetch(`${API_URL}/api/scoreboards/${temporaryScoreboardId}/claim`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}` },
        });

        const data = await res.json().catch(() => null);

        if (!res.ok || !data) {
          throw new Error(data?.message || "Unable to save scoreboard");
        }

        if (cancelled) {
          return;
        }

        claimAttemptsRef.current = 0;
        if (claimRetryTimerRef.current) {
          clearTimeout(claimRetryTimerRef.current);
          claimRetryTimerRef.current = null;
        }
        setResult(data);
        showToast("success", "Scoreboard saved to your account");
        await fetchBoards();
      } catch (err) {
        if (cancelled) {
          return;
        }
        const message = err?.message || "Unable to save scoreboard";
        showToast("error", message);
        claimAttemptsRef.current += 1;
        if (claimAttemptsRef.current < 3) {
          if (claimRetryTimerRef.current) {
            clearTimeout(claimRetryTimerRef.current);
          }
          claimRetryTimerRef.current = setTimeout(() => {
            setClaimRetryTick((tick) => tick + 1);
          }, 2000);
        } else if (claimRetryTimerRef.current) {
          clearTimeout(claimRetryTimerRef.current);
          claimRetryTimerRef.current = null;
        }
      } finally {
        claimInFlightRef.current = false;
      }
    };

    attemptClaim();

    return () => {
      cancelled = true;
    };
  }, [
    user,
    token,
    isTemporaryScoreboard,
    temporaryScoreboardId,
    fetchBoards,
    showToast,
    claimRetryTick,
  ]);

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
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.message || "Rename failed");
      }
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
      const normalizedValue = String(value).trim();
      const origin =
        typeof window !== "undefined" && window.location?.origin
          ? window.location.origin
          : "";
      const controlLink = `${origin}/board/${encodeURIComponent(normalizedValue)}/control`;
      await navigator.clipboard.writeText(controlLink);
      setCopiedBoardId(id);
      setTimeout(() => {
        setCopiedBoardId((prev) => (prev === id ? null : prev));
      }, 1500);
    } catch {
      showToast("error", "Unable to copy ID");
    }
  };

  const promptSignIn = useCallback(() => {
    openScoreboardsService("setup");
    switchAuthMode("signin");
    if (typeof document !== "undefined") {
      const target = document.getElementById("account-panel");
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [openScoreboardsService, switchAuthMode]);

  // --- Auth submit handler (uses AuthContext) ---
  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    if (authMode !== "signin" && authMode !== "signup") {
      return;
    }

    setAuthError("");
    setAuthInfo("");

    if (authMode === "signin") {
      const res = await login({ email: authEmail, password: authPassword });
      if (!res?.ok) {
        if (res?.code === "EMAIL_NOT_VERIFIED") {
          setPendingVerificationEmail(authEmail);
          setAuthInfo(res?.message || "Please verify your email before signing in.");
          setAuthMode("verify");
          showToast("info", res?.message || "Check your email to verify your account.");
        } else {
          setAuthError(res?.message || "Unable to sign in");
          showToast("error", res?.message || "Unable to sign in");
        }
        return;
      }

      setAuthEmail("");
      setAuthPassword("");
      showToast("success", "Signed in");
      if (returnToTarget) {
        navigate(returnToTarget, { replace: true });
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
        return;
      }

      if (res?.requiresEmailVerification) {
        const message =
          res?.message || "Account created. Check your email to verify your account.";
        setPendingVerificationEmail(res?.email || authEmail);
        setAuthInfo(message);
        setAuthMode("verify");
        setAuthPassword("");
        showToast("info", message);
        return;
      }

      setAuthEmail("");
      setAuthPassword("");
      setAuthDisplayName("");
      showToast("success", "Account created");
      if (returnToTarget) {
        navigate(returnToTarget, { replace: true });
      }
    }
  };

  const renderAuthCard = () => (
    <div className="auth-card">
      <div className="auth-header">
        <h2 className="secondary-title" style={{ marginBottom: 4 }}>
          {authHeading}
        </h2>
        <p className="subtle" style={{ margin: 0 }}>
          {authSubheading}
        </p>
      </div>

      {["signin", "signup"].includes(authMode) && (
        <>
          <div className="auth-switch" role="tablist" aria-label="Authentication mode">
            <button
              type="button"
              role="tab"
              className={`auth-switch-button ${authMode === "signin" ? "active" : ""}`}
              aria-selected={authMode === "signin"}
              onClick={() => switchAuthMode("signin")}
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              className={`auth-switch-button ${authMode === "signup" ? "active" : ""}`}
              aria-selected={authMode === "signup"}
              onClick={() => switchAuthMode("signup")}
            >
              Create account
            </button>
          </div>

          <form className="account-form auth-form" onSubmit={handleAuthSubmit}>
            {authMode === "signup" && (
              <>
                <label className="input-label" htmlFor="displayName">
                  Display Name
                </label>
                <input
                  id="displayName"
                  type="text"
                  placeholder="Your name"
                  value={authDisplayName}
                  onChange={(e) => setAuthDisplayName(e.target.value)}
                />
              </>
            )}

            <label className="input-label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              placeholder="you@example.com"
              required
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
            />

            <label className="input-label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              placeholder="••••••••"
              required
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
            />

            {authError && (
              <p className="error" style={{ marginTop: 4 }}>
                {authError}
              </p>
            )}
            {authInfo && (
              <p className="subtle" style={{ marginTop: 4, color: "#16a34a" }}>
                {authInfo}
              </p>
            )}

            <button
              className="primary-button"
              type="submit"
              disabled={authBusy}
              style={{ width: "100%", marginTop: "0.25rem" }}
            >
              {authBusy
                ? authMode === "signin"
                  ? "Signing in..."
                  : "Creating..."
                : authMode === "signin"
                  ? "Sign in"
                  : "Create account"}
            </button>
          </form>

          <button
            type="button"
            className="ghost-button"
            style={{ marginTop: "0.75rem" }}
            onClick={() => switchAuthMode("forgot")}
          >
            Forgot your password?
          </button>
        </>
      )}

      {authMode === "forgot" && (
        <form className="account-form auth-form" onSubmit={handleForgotSubmit}>
          <label className="input-label" htmlFor="forgot-email">
            Email
          </label>
          <input
            id="forgot-email"
            type="email"
            placeholder="you@example.com"
            required
            value={authEmail}
            onChange={(e) => setAuthEmail(e.target.value)}
          />

          {authError && (
            <p className="error" style={{ marginTop: 4 }}>
              {authError}
            </p>
          )}
          {authInfo && (
            <p className="subtle" style={{ marginTop: 4, color: "#2563eb" }}>
              {authInfo}
            </p>
          )}

          <button
            className="primary-button"
            type="submit"
            disabled={forgotBusy}
            style={{ width: "100%", marginTop: "0.25rem" }}
          >
            {forgotBusy ? "Sending..." : "Send reset link"}
          </button>
          <button
            type="button"
            className="ghost-button"
            style={{ marginTop: "0.75rem" }}
            onClick={() => switchAuthMode("signin")}
          >
            Back to sign in
          </button>
        </form>
      )}

      {authMode === "verify" && (
        <div className="account-form auth-form">
          {!pendingVerificationEmail && (
            <>
              <label className="input-label" htmlFor="verify-email">
                Email
              </label>
              <input
                id="verify-email"
                type="email"
                placeholder="you@example.com"
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                style={{ marginBottom: "0.75rem" }}
              />
            </>
          )}
          {authInfo && (
            <p className="subtle" style={{ marginBottom: "0.75rem", color: "#2563eb" }}>
              {authInfo}
            </p>
          )}
          {authError && (
            <p className="error" style={{ marginBottom: "0.75rem" }}>
              {authError}
            </p>
          )}
          <button
            type="button"
            className="primary-button"
            onClick={handleResendVerification}
            disabled={resendBusy || !(pendingVerificationEmail || authEmail)}
            style={{ width: "100%" }}
          >
            {resendBusy ? "Sending..." : "Resend verification email"}
          </button>
          <button
            type="button"
            className="ghost-button"
            style={{ marginTop: "0.75rem" }}
            onClick={() => switchAuthMode("signin")}
          >
            Back to sign in
          </button>
        </div>
      )}
    </div>
  );

  const renderScoreboardsList = () => (
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
              <button
                type="button"
                className={`board-code-copy ${
                  copiedBoardId === id ? "is-copied" : ""
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopyBoardId(rawIdentifier, id);
                }}
                aria-label="Copy scoreboard control link"
              >
                <span className="copy-icon copy-icon--copy">
                  <MdContentCopy />
                </span>
                <span>Copy Scoreboard Link</span>
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
  );

  const renderChangePasswordSection = () => (
    <div style={{ marginTop: "2rem" }}>
      <h3 className="secondary-title" style={{ marginBottom: "0.75rem" }}>
        Change password
      </h3>
      <form className="account-form auth-form" onSubmit={handleChangePassword}>
        <label className="input-label" htmlFor="currentPassword">
          Current password
        </label>
        <input
          id="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          value={currentPasswordInput}
          onChange={(e) => setCurrentPasswordInput(e.target.value)}
        />

        <label className="input-label" htmlFor="newPassword">
          New password
        </label>
        <input
          id="newPassword"
          type="password"
          autoComplete="new-password"
          required
          value={newPasswordInput}
          onChange={(e) => setNewPasswordInput(e.target.value)}
        />

        <label className="input-label" htmlFor="confirmPassword">
          Confirm new password
        </label>
        <input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          value={confirmPasswordInput}
          onChange={(e) => setConfirmPasswordInput(e.target.value)}
        />

        {changePasswordError && (
          <p className="error" style={{ marginTop: 4 }}>
            {changePasswordError}
          </p>
        )}
        {changePasswordInfo && (
          <p className="subtle" style={{ marginTop: 4, color: "#16a34a" }}>
            {changePasswordInfo}
          </p>
        )}

        <button
          className="primary-button"
          type="submit"
          disabled={changePasswordBusy}
          style={{ width: "100%", marginTop: "0.25rem" }}
        >
          {changePasswordBusy ? "Updating..." : "Update password"}
        </button>
      </form>
    </div>
  );

  const renderSignedInAccountPanel = ({ includeScoreboards = false } = {}) => (
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

      {includeScoreboards && renderScoreboardsList()}
      {renderChangePasswordSection()}
    </>
  );

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
        {activeService === "landing" ? (
          <>
            <h1 className="title">scorebugger</h1>
            <p className="subtitle">
              Choose a service to get started.
            </p>
            <div className="service-landing-grid">
              <button
                type="button"
                className="service-landing-card"
                onClick={() => openScoreboardsService("setup")}
              >
                <span className="service-landing-kicker">Scorebugger</span>
                <h2>Scoreboard Overlays</h2>
                <p>Create and control live overlays for streaming and in-venue displays.</p>
              </button>
              <button
                type="button"
                className="service-landing-card"
                onClick={openTournamentsService}
              >
                <span className="service-landing-kicker">Scorebugger</span>
                <h2>Tournaments</h2>
                <p>Plan tournament schedules, share public views, and follow live matches.</p>
              </button>
            </div>
            <aside className="account-panel" id="account-panel" style={{ marginTop: "1.5rem" }}>
              {user ? renderSignedInAccountPanel() : renderAuthCard()}
            </aside>
          </>
        ) : (
          <>
            {activeService === "scoreboards" && activeTab === "setup" && (
              <>
                <h1 className="title">Scoreboard Overlays</h1>
                <p className="subtitle">
                  A volleyball scoreboard you can control and embed live in your stream.
                </p>
              </>
            )}
            {activeService === "scoreboards" && activeTab === "control" && (
              <>
                <h1 className="title">Control Panel</h1>
                <p className="subtitle">
                  Share the overlay link with OBS and update the match from anywhere.
                </p>
              </>
            )}
            {activeService === "tournaments" && (
              <>
                <h1 className="title">Tournament Hub</h1>
                <p className="subtitle">
                  Create tournaments, manage teams, and publish live event updates.
                </p>
              </>
            )}

            <div className="home-service-nav">
              <button type="button" className="ghost-button" onClick={openServicesLanding}>
                All services
              </button>
              {activeService === "scoreboards" ? (
                <button type="button" className="ghost-button" onClick={openTournamentsService}>
                  Open Tournaments
                </button>
              ) : (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => openScoreboardsService("setup")}
                >
                  Open Scoreboard Overlays
                </button>
              )}
            </div>

            {activeService === "scoreboards" && (
              <div className="home-tabs">
                <button
                  className={`home-tab-button ${activeTab === "setup" ? "active" : ""}`}
                  onClick={() => openScoreboardsService("setup")}
                >
                  Setup
                </button>
                <button
                  className={`home-tab-button ${activeTab === "control" ? "active" : ""}`}
                  onClick={() => openScoreboardsService("control")}
                >
                  Control
                </button>
              </div>
            )}
          </>
        )}

        {activeService !== "landing" && (
          activeService === "scoreboards" ? (
        activeTab === "setup" ? (
          <div className="home-tabpanel fadein">
            {!user && (
              <div className="temporary-banner" role="status">
                <div className="temporary-banner__text">
                  <strong>Temporary scoreboard</strong>
                  <span>Scoreboards created while signed out may be deleted after 24 hours.</span>
                </div>
                <button type="button" className="temporary-banner__action" onClick={promptSignIn}>
                  Sign in to save this scoreboard
                </button>
              </div>
            )}
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
                              maxLength={TEAM_NAME_LIMIT}
                              value={t.name}
                              onChange={(e) => handleInputChange(i, "name", e.target.value)}
                            />
                            {showCountdown && <span className={countdownClass}>{nameRemaining}</span>}
                          </div>
                          <div className="team-color-row">
                            <label className="team-color-field">
                              <span className="input-label">Panel Color</span>
                              <input
                                type="color"
                                value={t.color}
                                onChange={(e) => handleInputChange(i, "color", e.target.value)}
                              />
                            </label>
                            <label className="team-color-field">
                              <span className="input-label">Text Color</span>
                              <input
                                type="color"
                                value={t.teamTextColor || t.textColor || "#ffffff"}
                                onChange={(e) =>
                                  handleInputChange(i, "teamTextColor", e.target.value)
                                }
                              />
                            </label>
                          </div>
                          <div
                            className="team-color-preview"
                            style={{
                              backgroundColor: t.color,
                              color: t.teamTextColor || t.textColor || "#ffffff",
                            }}
                          >
                            {t.name || (i === 0 ? "Home" : "Away")} Preview
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </fieldset>

                <button className="primary-button" type="submit" disabled={loading}>
                  {loading
                    ? user
                      ? "Creating..."
                      : "Starting..."
                    : user
                      ? "Create Scoreboard"
                      : "Start Temporary Scoreboard"}
                </button>
              </form>

              <aside className="account-panel" id="account-panel">
                {user
                  ? renderSignedInAccountPanel({ includeScoreboards: true })
                  : renderAuthCard()}
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
                openScoreboardsService("control");
              }}
            />
          </div>
        )
        ) : (
          <div className="home-tabpanel fadein">
            <TournamentsTab
              user={user}
              token={token}
              initialTournamentId={selectedTournamentId}
              onTournamentIdChange={setSelectedTournamentId}
              onShowToast={showToast}
              mode="hub"
            />
          </div>
        )
        )}
      </section>

    </main>
  );
}

export default Home;

import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

function ResetPassword() {
  const { resetPassword } = useAuth();
  const [searchParams] = useSearchParams();
  const token = useMemo(() => searchParams.get("token") ?? "", [searchParams]);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState(token ? "idle" : "missing");
  const [message, setMessage] = useState(
    token ? "Enter a new password to finish resetting your account." : "Reset token is missing or invalid."
  );
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!token) {
      setStatus("error");
      setMessage("Reset token is missing or invalid.");
      return;
    }

    if (password.trim().length < 8) {
      setStatus("error");
      setMessage("Password must be at least 8 characters long.");
      return;
    }

    if (password !== confirmPassword) {
      setStatus("error");
      setMessage("Passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      const response = await resetPassword({ token, password });
      if (!response?.ok) {
        setStatus("error");
        setMessage(response?.message || "Unable to reset password with that link.");
        return;
      }

      setStatus("success");
      setMessage(response?.message || "Password updated successfully. You are signed in.");
      setPassword("");
      setConfirmPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="container">
      <section className="card home-card fade-section active" style={{ maxWidth: 480, margin: "4rem auto" }}>
        <h1 className="title" style={{ fontSize: "2rem", marginBottom: "0.75rem" }}>
          Set a new password
        </h1>

        {status === "success" ? (
          <>
            <p className="subtle" style={{ fontSize: "1rem", marginBottom: "1.5rem", color: "#16a34a" }}>
              {message}
            </p>
            <Link className="primary-button" to="/">
              Go to dashboard
            </Link>
          </>
        ) : status === "missing" ? (
          <>
            <p className="error" style={{ fontSize: "1rem", marginBottom: "1.5rem" }}>{message}</p>
            <Link className="primary-button" to="/">
              Return home
            </Link>
          </>
        ) : (
          <form className="account-form auth-form" onSubmit={handleSubmit}>
            <p className="subtle" style={{ fontSize: "1rem", marginBottom: "1rem" }}>{message}</p>

            <label className="input-label" htmlFor="new-password">
              New password
            </label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              placeholder="••••••••"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />

            <label className="input-label" htmlFor="confirm-new-password">
              Confirm new password
            </label>
            <input
              id="confirm-new-password"
              type="password"
              autoComplete="new-password"
              placeholder="••••••••"
              required
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />

            {status === "error" && (
              <p className="error" style={{ marginTop: 4 }}>{message}</p>
            )}

            <button
              className="primary-button"
              type="submit"
              disabled={busy}
              style={{ width: "100%", marginTop: "0.5rem" }}
            >
              {busy ? "Updating..." : "Update password"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}

export default ResetPassword;

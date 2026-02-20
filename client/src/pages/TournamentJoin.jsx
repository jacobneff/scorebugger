import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { API_URL } from "../config/env.js";
import { useAuth } from "../context/AuthContext.jsx";

function TournamentJoin() {
  const { user, token } = useAuth();
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [joinedTournamentId, setJoinedTournamentId] = useState("");

  const inviteToken = useMemo(() => {
    const raw = searchParams.get("token");
    return typeof raw === "string" ? raw.trim() : "";
  }, [searchParams]);

  const isInviteToken = useMemo(() => {
    const raw = searchParams.get("invite");
    if (!raw) {
      return false;
    }
    return ["1", "true", "yes"].includes(raw.toLowerCase());
  }, [searchParams]);

  const returnToPath = useMemo(() => {
    if (typeof window === "undefined") {
      return "/tournaments/join";
    }
    return `${window.location.pathname}${window.location.search}`;
  }, []);

  const signInHref = useMemo(
    () => `/?mode=signin&returnTo=${encodeURIComponent(returnToPath)}`,
    [returnToPath]
  );

  const tournamentHubHref = useMemo(() => {
    if (joinedTournamentId) {
      return `/?tab=tournaments&tournamentId=${encodeURIComponent(joinedTournamentId)}`;
    }
    return "/?tab=tournaments";
  }, [joinedTournamentId]);

  useEffect(() => {
    if (!inviteToken) {
      setStatus("error");
      setMessage("Join token is missing.");
      return;
    }

    if (!user || !token) {
      setStatus("signin");
      setMessage("Sign in to join this tournament.");
      return;
    }

    let cancelled = false;
    const endpoint = isInviteToken
      ? `${API_URL}/api/tournament-invites/accept`
      : `${API_URL}/api/tournaments/join`;

    const joinTournament = async () => {
      setStatus("loading");
      setMessage("Joining tournament...");

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ token: inviteToken }),
        });

        const payload = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(payload?.message || "Unable to join tournament");
        }

        if (cancelled) {
          return;
        }

        setJoinedTournamentId(
          payload?.tournamentId ? String(payload.tournamentId) : ""
        );
        setStatus("success");
        setMessage("You now have admin access to this tournament.");
      } catch (error) {
        if (cancelled) {
          return;
        }

        setStatus("error");
        setMessage(error?.message || "Unable to join tournament");
      }
    };

    joinTournament();

    return () => {
      cancelled = true;
    };
  }, [inviteToken, isInviteToken, token, user]);

  return (
    <main className="container">
      <section
        className="card home-card fade-section active"
        style={{ maxWidth: 560, margin: "4rem auto" }}
      >
        <h1 className="title" style={{ fontSize: "2rem", marginBottom: "0.75rem" }}>
          Tournament Invite
        </h1>

        <p
          className={status === "error" ? "error" : "subtle"}
          style={{ marginBottom: "1.5rem", fontSize: "1rem" }}
        >
          {message || "Join this tournament to continue."}
        </p>

        {status === "signin" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <a className="primary-button" href={signInHref}>
              Sign In to Continue
            </a>
            <Link className="ghost-button" to="/">
              Return home
            </Link>
          </div>
        ) : status === "success" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <a className="primary-button" href={tournamentHubHref}>
              Open Tournament Hub
            </a>
            <Link className="ghost-button" to="/">
              Return home
            </Link>
          </div>
        ) : status === "error" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <Link className="primary-button" to="/">
              Return home
            </Link>
          </div>
        ) : (
          <p className="subtle">Please wait...</p>
        )}
      </section>
    </main>
  );
}

export default TournamentJoin;

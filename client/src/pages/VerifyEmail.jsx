import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

function VerifyEmail() {
  const { verifyEmail, user } = useAuth();
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState("loading");
  const [message, setMessage] = useState("Verifying your email…");
  const userEmail = user?.email ?? "";

  const token = useMemo(() => searchParams.get("token") ?? "", [searchParams]);
  const emailParam = useMemo(() => searchParams.get("email") ?? "", [searchParams]);
  const verifyLinkTarget = useMemo(() => {
    const resolvedEmail = userEmail || emailParam;
    if (resolvedEmail) {
      return `/?mode=verify&email=${encodeURIComponent(resolvedEmail)}`;
    }
    return "/?mode=verify";
  }, [emailParam, userEmail]);

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setMessage("Verification token is missing or invalid.");
      return;
    }

    let isMounted = true;

    verifyEmail(token).then((result) => {
      if (!isMounted) return;
      if (result?.ok) {
        setStatus("success");
        setMessage(result?.message || "Email verified successfully. You are signed in.");
      } else {
        setStatus("error");
        setMessage(result?.message || "We could not verify that link. Request a new one and try again.");
      }
    });

    return () => {
      isMounted = false;
    };
  }, [token, verifyEmail]);

  return (
    <main className="container">
      <section className="card home-card fade-section active" style={{ maxWidth: 480, margin: "4rem auto" }}>
        <h1 className="title" style={{ fontSize: "2rem", marginBottom: "0.75rem" }}>
          Email Verification
        </h1>
        <p
          className={status === "error" ? "error" : "subtle"}
          style={{ marginBottom: "1.5rem", fontSize: "1rem" }}
        >
          {message}
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <Link className="primary-button" to="/">
            Return to scorebugger
          </Link>
          {status === "error" && (
            <Link className="ghost-button" to={verifyLinkTarget}>
              Resend verification email
            </Link>
          )}
        </div>
      </section>
    </main>
  );
}

export default VerifyEmail;

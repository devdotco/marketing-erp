"use client";

import { useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/base-path";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState("loading");
    setError("");

    const res = await apiFetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    if (res.ok) {
      setState("sent");
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Something went wrong. Please try again.");
      setState("error");
    }
  }

  return (
    <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)", padding: "40px 24px" }}>
      <div style={{ width: "100%", maxWidth: 360 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 40 }}>
          <div style={{ width: 24, height: 24, background: "var(--text)", borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ color: "var(--bg)", fontSize: 11, fontWeight: 700 }}>M</span>
          </div>
          <span style={{ fontSize: 13, fontWeight: 600 }}>marketing.erp.io</span>
        </div>

        {state === "sent" ? (
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em", marginBottom: 8 }}>Check your email</h1>
            <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.65, marginBottom: 28 }}>
              If <strong>{email}</strong> has an account, we sent a password reset link. Check your inbox (and spam folder).
            </p>
            <Link href="/login" style={{ fontSize: 13, color: "var(--text-muted)", textDecoration: "underline" }}>
              Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em", marginBottom: 6 }}>Forgot password</h1>
              <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 24 }}>
                Enter your email and we&apos;ll send a reset link.
              </p>
            </div>

            {(state === "error") && (
              <div style={{ background: "var(--danger-bg)", border: "1px solid var(--danger)", borderRadius: "var(--radius)", padding: "10px 14px", fontSize: 13, color: "var(--danger)" }}>
                {error}
              </div>
            )}

            <div>
              <label className="input-label" htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                required
                autoFocus
                className="input"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <button
              type="submit"
              className="btn btn-primary"
              disabled={state === "loading"}
              style={{ width: "100%" }}
            >
              {state === "loading" ? "Sending…" : "Send reset link"}
            </button>

            <p style={{ fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>
              <Link href="/login" style={{ color: "var(--text-muted)", textDecoration: "underline" }}>
                Back to sign in
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}

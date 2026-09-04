"use client";

import { useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch } from "@/lib/base-path";

function ResetPasswordForm() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") ?? "";
  const email = params.get("email") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState("");

  if (!token || !email) {
    return (
      <div style={{ textAlign: "center" }}>
        <p style={{ color: "var(--danger)", marginBottom: 16 }}>Invalid reset link.</p>
        <Link href="/forgot-password" style={{ fontSize: 13, color: "var(--text-muted)", textDecoration: "underline" }}>
          Request a new one
        </Link>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError("Passwords don't match."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }

    setState("loading");
    setError("");

    const res = await apiFetch("/api/auth/reset-password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, token, password }),
    });

    if (res.ok) {
      setState("done");
      setTimeout(() => router.push("/login"), 2000);
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Something went wrong.");
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>✓</div>
        <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Password updated</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Redirecting you to sign in…</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em", marginBottom: 6 }}>New password</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 4 }}>
          Resetting password for <strong>{email}</strong>
        </p>
      </div>

      {error && (
        <div style={{ background: "var(--danger-bg)", border: "1px solid var(--danger)", borderRadius: "var(--radius)", padding: "10px 14px", fontSize: 13, color: "var(--danger)" }}>
          {error}
        </div>
      )}

      <div>
        <label className="input-label" htmlFor="password">New password</label>
        <input
          id="password"
          type="password"
          required
          minLength={8}
          autoFocus
          className="input"
          placeholder="Min. 8 characters"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      <div>
        <label className="input-label" htmlFor="confirm">Confirm password</label>
        <input
          id="confirm"
          type="password"
          required
          className="input"
          placeholder="Repeat password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>

      <button
        type="submit"
        className="btn btn-primary"
        disabled={state === "loading"}
        style={{ width: "100%" }}
      >
        {state === "loading" ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)", padding: "40px 24px" }}>
      <div style={{ width: "100%", maxWidth: 360 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 40 }}>
          <div style={{ width: 24, height: 24, background: "var(--text)", borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ color: "var(--bg)", fontSize: 11, fontWeight: 700 }}>M</span>
          </div>
          <span style={{ fontSize: 13, fontWeight: 600 }}>marketing.erp.io</span>
        </div>
        <Suspense fallback={<p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>}>
          <ResetPasswordForm />
        </Suspense>
      </div>
    </div>
  );
}

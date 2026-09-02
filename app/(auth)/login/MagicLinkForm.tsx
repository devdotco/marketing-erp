"use client";

import { useState } from "react";

export function MagicLinkForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "sent">("idle");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState("loading");

    const res = await fetch("/api/auth/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    // Always show "sent" — don't leak whether email exists
    setState("sent");
    void res;
  }

  if (state === "sent") {
    return (
      <div
        style={{
          background: "var(--success-bg)",
          border: "1px solid var(--success)",
          borderRadius: "var(--radius)",
          padding: "12px 16px",
          fontSize: 13,
          color: "var(--success)",
          textAlign: "center",
        }}
      >
        ✓ Check your email for a sign-in link
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8 }}>
      <input
        type="email"
        required
        className="input"
        placeholder="your@email.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={{ flex: 1 }}
      />
      <button
        type="submit"
        className="btn btn-secondary"
        disabled={state === "loading"}
        style={{ whiteSpace: "nowrap", flexShrink: 0 }}
      >
        {state === "loading" ? "…" : "Send link"}
      </button>
    </form>
  );
}

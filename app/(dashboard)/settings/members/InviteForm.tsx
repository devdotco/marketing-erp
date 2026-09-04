"use client";

import { useState, useTransition } from "react";
import { apiFetch } from "@/lib/base-path";

export function InviteForm({ workspaceId }: { workspaceId: string }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("OPERATOR");
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await apiFetch("/api/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, email, role }),
      });
      if (res.ok) {
        setSuccess(true);
        setEmail("");
        setTimeout(() => setSuccess(false), 3000);
      } else {
        const d = await res.json();
        setError(d.error ?? "Failed to send invite");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="colleague@company.com"
        className="input"
        style={{ flex: "1 1 220px" }}
      />
      <select
        value={role}
        onChange={(e) => setRole(e.target.value)}
        className="input"
        style={{ flex: "0 0 140px" }}
      >
        <option value="VIEWER">Viewer</option>
        <option value="OPERATOR">Operator</option>
        <option value="WORKSPACE_ADMIN">Admin</option>
      </select>
      <button type="submit" disabled={pending} className="btn btn-primary btn-sm" style={{ opacity: pending ? 0.6 : 1 }}>
        {pending ? "Sending…" : "Send invite"}
      </button>
      {success && <p style={{ width: "100%", fontSize: 12, color: "var(--success)", margin: 0 }}>Invite sent!</p>}
      {error && <p style={{ width: "100%", fontSize: 12, color: "var(--danger)", margin: 0 }}>{error}</p>}
    </form>
  );
}

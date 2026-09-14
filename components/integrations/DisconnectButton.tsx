"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/base-path";

export function DisconnectButton({ provider, name }: { provider: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function disconnect() {
    if (!confirm(`Disconnect ${name}? Agents that use it will stop getting live data.`)) return;
    setBusy(true);
    setError("");
    const res = await apiFetch(`/api/integrations/connect?provider=${provider}`, { method: "DELETE" });
    if (res.ok) {
      router.refresh();
    } else {
      const data = await res.json().catch(() => ({}));
      setError((data as { error?: string }).error ?? `Failed: ${res.status}`);
    }
    setBusy(false);
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      {error && <span style={{ fontSize: 11, color: "var(--danger)" }}>{error}</span>}
      <button className="btn btn-ghost btn-sm" style={{ color: "var(--danger)" }} onClick={disconnect} disabled={busy}>
        {busy ? "Disconnecting…" : "Disconnect"}
      </button>
    </span>
  );
}

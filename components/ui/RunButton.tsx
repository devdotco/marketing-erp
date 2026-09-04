"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/base-path";

interface RunButtonProps {
  workspaceId: string;
  agentSlug: string;
  agentConfigId?: string;
}

export function RunButton({ workspaceId, agentSlug, agentConfigId }: RunButtonProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function handleRun() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await apiFetch("/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId, agentSlug, agentConfigId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to start run");
        router.push(`/runs/${data.runId}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Error starting run");
      }
    });
  }

  return (
    <div>
      <button
        onClick={handleRun}
        disabled={pending}
        className="btn btn-primary btn-sm"
        style={{ opacity: pending ? 0.6 : 1 }}
      >
        {pending ? "Starting…" : "Run now"}
      </button>
      {error && (
        <p style={{ fontSize: 11, color: "var(--danger)", marginTop: 4 }}>{error}</p>
      )}
    </div>
  );
}

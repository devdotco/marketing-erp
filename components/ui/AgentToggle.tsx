"use client";

import { useState, useTransition } from "react";
import { toggleAgent } from "@/lib/actions/agents";

interface AgentToggleProps {
  workspaceId: string;
  agentSlug: string;
  enabled: boolean;
  agentConfigId?: string;
  showLabel?: boolean;
}

export function AgentToggle({ workspaceId, agentSlug, enabled, agentConfigId, showLabel }: AgentToggleProps) {
  const [optimistic, setOptimistic] = useState(enabled);
  const [pending, startTransition] = useTransition();

  function handleToggle() {
    const next = !optimistic;
    setOptimistic(next);
    startTransition(async () => {
      try {
        await toggleAgent(workspaceId, agentSlug, next, agentConfigId);
      } catch {
        setOptimistic(!next);
      }
    });
  }

  return (
    <button
      onClick={handleToggle}
      disabled={pending}
      className={`btn btn-sm ${optimistic ? "btn-danger" : "btn-secondary"}`}
      style={{ opacity: pending ? 0.6 : 1 }}
    >
      {showLabel
        ? optimistic ? "Disable" : "Enable agent"
        : optimistic ? "Enabled ✓" : "Enable"}
    </button>
  );
}

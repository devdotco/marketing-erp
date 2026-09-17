"use client";

import { useMemo, useState, useTransition } from "react";
import { setAgentSchedule } from "@/lib/actions/agents";
import { CRON_PRESETS, describeCron, isValidCron, nextRunAt } from "@/lib/cron";

interface ScheduleEditorProps {
  workspaceId: string;
  agentSlug: string;
  agentConfigId?: string;
  schedule: string | null;
  enabled: boolean;
  defaultSchedule?: string;
}

/**
 * Lets a workspace admin see and set how often an agent runs itself, via
 * lib/scheduler.ts. Shown on the agent detail page next to "Saved defaults" —
 * same permission level (OPERATOR, enforced server-side in setAgentSchedule)
 * and the same save-a-field-then-redirect-free pattern as ConfigureForm, just
 * small enough not to need its own page.
 *
 * The preview (describeCron/nextRunAt) recomputes from whatever is currently
 * typed, before saving — lib/cron.ts is pure and dependency-free specifically
 * so it's safe to run here in the browser.
 */
export function ScheduleEditor({
  workspaceId,
  agentSlug,
  agentConfigId,
  schedule,
  enabled,
  defaultSchedule,
}: ScheduleEditorProps) {
  const [value, setValue] = useState(schedule ?? "");
  const [savedSchedule, setSavedSchedule] = useState(schedule);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const trimmed = value.trim();
  const valid = trimmed === "" || isValidCron(trimmed);
  const dirty = trimmed !== (savedSchedule ?? "");

  const preview = useMemo(() => {
    if (trimmed === "" || !valid) return null;
    const next = nextRunAt(trimmed, new Date());
    return {
      description: describeCron(trimmed),
      nextRun: next ? next.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) : null,
    };
  }, [trimmed, valid]);

  function handleSave() {
    setError(null);
    const toSave = trimmed === "" ? null : trimmed;
    startTransition(async () => {
      try {
        await setAgentSchedule(workspaceId, agentSlug, toSave, agentConfigId);
        setSavedSchedule(toSave);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save schedule");
      }
    });
  }

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600 }}>Schedule</h2>
        {savedSchedule && (
          <span className="badge badge-completed">
            {enabled ? "Running automatically" : "Set, but agent is disabled"}
          </span>
        )}
      </div>

      <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14, lineHeight: 1.6 }}>
        Run this agent on its own, on a schedule, using its saved defaults as input — no
        button press needed. Leave blank to keep it manual (&ldquo;Run now&rdquo; only).
        Times are UTC.
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {CRON_PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => setValue(preset.value)}
            className={`btn btn-sm ${trimmed === preset.value ? "btn-primary" : "btn-secondary"}`}
          >
            {preset.label}
          </button>
        ))}
        {defaultSchedule && (
          <button
            type="button"
            onClick={() => setValue(defaultSchedule)}
            className={`btn btn-sm ${trimmed === defaultSchedule ? "btn-primary" : "btn-secondary"}`}
          >
            Suggested for this agent
          </button>
        )}
      </div>

      <label className="input-label" htmlFor="schedule-cron">
        Cron expression (minute hour day-of-month month day-of-week)
      </label>
      <input
        id="schedule-cron"
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="0 13 * * 1-5"
        className="input"
        style={{ fontFamily: "monospace" }}
      />

      {trimmed !== "" && !valid && (
        <p style={{ fontSize: 12, color: "var(--danger)", marginTop: 6 }}>Not a valid 5-field cron expression.</p>
      )}
      {preview && (
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
          {preview.description}
          {preview.nextRun && enabled && <> — next run at {preview.nextRun} UTC</>}
          {preview.nextRun && !enabled && <> — won&rsquo;t fire until this agent is enabled</>}
        </p>
      )}
      {trimmed === "" && savedSchedule && (
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>Saving with this field empty turns scheduling off.</p>
      )}

      {error && <p style={{ fontSize: 12, color: "var(--danger)", marginTop: 6 }}>{error}</p>}

      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={pending || !valid || !dirty}
          className="btn btn-secondary btn-sm"
          style={{ opacity: pending || !valid || !dirty ? 0.6 : 1 }}
        >
          {pending ? "Saving…" : trimmed === "" ? "Turn off schedule" : "Save schedule"}
        </button>
      </div>
    </div>
  );
}

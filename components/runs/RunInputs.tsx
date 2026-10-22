import { AGENT_META } from "@/lib/agent-metadata";

/**
 * What this run was given. Without it a reviewer cannot tell whether an odd
 * output came from the agent or from the brief, and nobody can reproduce a run
 * (QA audit 2026-10-21, every agent).
 */
export function RunInputs({ agentSlug, input }: { agentSlug: string; input: Record<string, unknown> | null }) {
  const entries = Object.entries(input ?? {}).filter(
    ([key, value]) => !key.startsWith("_") && value !== null && value !== undefined && String(value).trim() !== "",
  );

  const labels = new Map((AGENT_META[agentSlug]?.inputs ?? []).map((i) => [i.key, i.label]));

  return (
    <details className="card">
      <summary style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-dim)", cursor: "pointer" }}>
        Inputs ({entries.length})
      </summary>
      {entries.length === 0 ? (
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 12 }}>
          Nothing was entered on the run form; the agent used its saved configuration and defaults.
        </p>
      ) : (
        <dl style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
          {entries.map(([key, value]) => (
            <div key={key}>
              <dt style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 2 }}>{labels.get(key) ?? key}</dt>
              <dd style={{ fontSize: 12, color: "var(--text)", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 160, overflow: "auto" }}>
                {typeof value === "object" ? JSON.stringify(value) : String(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </details>
  );
}

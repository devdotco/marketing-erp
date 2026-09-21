import { readProvenance, sourceName } from "@/lib/agents/provenance";
import { groundingFor } from "@/lib/agents/grounding";

/**
 * Where a run's figures came from, shown above the output.
 *
 * An observation and a draft used to render identically — a JSON panel — and
 * the most damaging case was an estimate that looked like a measurement. This
 * is the one place that distinction is made visible, so it is deliberately
 * loud when a number is not measured and quiet when it is.
 *
 * Drafts get nothing. An article does not need a provenance banner; saying
 * "estimated" over a piece of writing is noise, and noise is what makes people
 * stop reading warnings that matter.
 */
export function ProvenanceBanner({
  output,
  agentSlug,
}: {
  output: unknown;
  agentSlug: string;
}) {
  const p = readProvenance(output, agentSlug);
  if (!p) return null;
  if (p.kind === "artifact") return null;

  const { canRead } = groundingFor(agentSlug);

  if (p.kind === "action") {
    if (p.evidence.length === 0) return null;
    return (
      <Frame tone="info" title="Delivered">
        <ul style={listStyle}>
          {p.evidence.map((e, i) => (
            <li key={i} style={itemStyle}>
              <strong style={{ fontWeight: 600 }}>{sourceName(e.source)}</strong> — {e.detail}
            </li>
          ))}
        </ul>
      </Frame>
    );
  }

  if (p.estimated) {
    const connectable = canRead.filter((s) => s !== "WEB_SEARCH");
    return (
      <Frame tone="warning" title="Estimated — not measured">
        <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6, margin: 0 }}>
          {p.note ??
            "No live source was connected for this run, so the figures below are the model's judgement rather than readings from a system. Treat them as a starting point, not as data."}
        </p>
        {connectable.length > 0 && (
          <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6, margin: "8px 0 0" }}>
            Connect {connectable.map(sourceName).join(" or ")} under Settings → Integrations and run it again to
            get measured figures.
          </p>
        )}
      </Frame>
    );
  }

  return (
    <Frame tone="success" title="Measured">
      <ul style={listStyle}>
        {p.evidence.map((e, i) => (
          <li key={i} style={itemStyle}>
            <strong style={{ fontWeight: 600 }}>{sourceName(e.source)}</strong> — {e.detail}
            {typeof e.rows === "number" && (
              <span style={{ color: "var(--text-dim)" }}> · {e.rows.toLocaleString()} rows</span>
            )}
          </li>
        ))}
      </ul>
      {p.note && (
        <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6, margin: "8px 0 0" }}>{p.note}</p>
      )}
    </Frame>
  );
}

const listStyle: React.CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const itemStyle: React.CSSProperties = {
  fontSize: 13,
  color: "var(--text-muted)",
  lineHeight: 1.6,
};

const TONES = {
  warning: { fg: "var(--warning)", bg: "var(--warning-bg)" },
  success: { fg: "var(--success)", bg: "var(--success-bg)" },
  info: { fg: "var(--info)", bg: "var(--info-bg)" },
} as const;

function Frame({
  tone,
  title,
  children,
}: {
  tone: keyof typeof TONES;
  title: string;
  children: React.ReactNode;
}) {
  const { fg, bg } = TONES[tone];
  return (
    <div
      style={{
        background: bg,
        border: `1px solid ${fg}`,
        borderRadius: "var(--radius)",
        padding: "12px 16px",
        marginBottom: 16,
      }}
    >
      <p
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: fg,
          margin: "0 0 6px",
        }}
      >
        {title}
      </p>
      {children}
    </div>
  );
}

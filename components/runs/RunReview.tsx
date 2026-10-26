import type { ReviewFindings } from "@/lib/agents/integrity";

/**
 * What a reviewer should check before approving — for every agent, not only
 * Blog Writer. Until this existed the only thing above Approve was a generic
 * "Review required" banner, whether the output was clean, cut off, simulated,
 * or full of invented testimonials. See lib/agents/integrity.ts.
 */
export function RunReview({ findings }: { findings: ReviewFindings }) {
  const { blocking, warnings } = findings;
  if (blocking.length === 0 && warnings.length === 0) return null;

  return (
    <div className="card" style={{ borderColor: blocking.length ? "var(--danger)" : "var(--warning)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600 }}>
          {blocking.length ? "This output can't be approved" : "Check before approving"}
        </h2>
        <span className={`badge ${blocking.length ? "badge-failed" : "badge-awaiting"}`}>
          {blocking.length ? `${blocking.length} blocking` : `${warnings.length} to review`}
        </span>
      </div>

      {blocking.length > 0 && (
        <>
          <ul style={{ display: "flex", flexDirection: "column", gap: 6, margin: "0 0 12px", paddingLeft: 18 }}>
            {blocking.map((issue, i) => (
              <li key={i} style={{ fontSize: 12, color: "var(--text)" }}>{issue}</li>
            ))}
          </ul>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 12px" }}>
            Reject this run and run the agent again.
          </p>
        </>
      )}

      {warnings.length > 0 && (
        <>
          {blocking.length > 0 && <p style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Also worth a look</p>}
          <ul style={{ display: "flex", flexDirection: "column", gap: 6, margin: 0, paddingLeft: 18 }}>
            {warnings.map((warning, i) => (
              <li key={i} style={{ fontSize: 12, color: "var(--text-muted)" }}>{warning}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * One headline figure, with its move.
 *
 * A stat tile is the right form when the number IS the answer and a plot would
 * add nothing — but only for measured figures. Nothing estimated gets this
 * treatment; that is the whole distinction lib/agents/grounding.ts draws.
 */
export function StatTile({
  label,
  value,
  unit = "",
  change,
  changeSuffix = "",
  /** true when a FALL is the good direction, e.g. mean rank. */
  lowerIsBetter = false,
  hint,
}: {
  label: string;
  value: number | null;
  unit?: string;
  change?: number | null;
  changeSuffix?: string;
  lowerIsBetter?: boolean;
  hint?: string;
}) {
  const hasValue = value !== null && Number.isFinite(value);
  const improved = typeof change === "number" ? (lowerIsBetter ? change < 0 : change > 0) : null;
  const flat = typeof change === "number" && Math.abs(change) < 0.05;

  return (
    <div className="stat-card">
      <p className="stat-label">{label}</p>
      <p className="stat-value">
        {hasValue ? `${Math.round((value as number) * 10) / 10}${unit}` : "—"}
      </p>
      {typeof change === "number" && !flat ? (
        <p
          className="stat-delta"
          style={{ color: improved ? "var(--success)" : "var(--danger)" }}
        >
          {change > 0 ? "+" : ""}
          {Math.round(change * 10) / 10}
          {unit}
          {changeSuffix ? ` ${changeSuffix}` : ""}
        </p>
      ) : (
        <p className="stat-delta" style={{ color: "var(--text-dim)" }}>
          {hint ?? (hasValue ? "No change yet" : "Not measured yet")}
        </p>
      )}
    </div>
  );
}

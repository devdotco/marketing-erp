export interface BarItem {
  label: string;
  value: number;
  /** Renders in the accent rather than the recessive fill. Use for "you". */
  emphasis?: boolean;
  /** Shown after the value, e.g. "4 citations". */
  detail?: string;
}

/**
 * Magnitude across a handful of named things — share of voice, visibility by
 * engine, citation counts by domain.
 *
 * One hue, not a categorical palette: these are amounts of the same measure,
 * and giving each row its own colour would encode identity that is already
 * carried by the label beside it. The only second colour is emphasis, which
 * marks one row as "you" — a status job, not a series.
 *
 * Every bar carries its value as text. The chart hue sits below 3:1 against
 * the surface, and a visible label is the relief that makes that legible.
 */
export function BarList({
  items,
  unit = "%",
  max,
  emptyLabel = "Nothing recorded yet.",
}: {
  items: BarItem[];
  unit?: string;
  max?: number;
  emptyLabel?: string;
}) {
  if (items.length === 0) {
    return <p style={{ fontSize: 13, color: "var(--text-dim)", margin: 0 }}>{emptyLabel}</p>;
  }

  const top = max ?? Math.max(...items.map((i) => i.value), 1);

  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
      {items.map((item) => {
        const width = top === 0 ? 0 : Math.max((item.value / top) * 100, item.value > 0 ? 1.5 : 0);
        return (
          <li key={item.label} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 10, alignItems: "center" }}>
            <div style={{ minWidth: 0 }}>
              <p
                style={{
                  fontSize: 12.5,
                  color: item.emphasis ? "var(--text)" : "var(--text-muted)",
                  fontWeight: item.emphasis ? 600 : 400,
                  margin: "0 0 4px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={item.label}
              >
                {item.label}
              </p>
              {/* 6px bar, 3px radius on the data end only, anchored to the
                  baseline at left. The track is the surface gap that keeps
                  adjacent bars from reading as one shape. */}
              <div style={{ height: 6, background: "var(--surface-2)", borderRadius: 3, overflow: "hidden" }}>
                <div
                  style={{
                    width: `${width}%`,
                    height: "100%",
                    background: item.emphasis ? "var(--info)" : "var(--border-strong)",
                    borderRadius: 3,
                  }}
                />
              </div>
            </div>
            <p
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: "var(--text)",
                margin: 0,
                whiteSpace: "nowrap",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {unit === "%" ? `${Math.round(item.value * 10) / 10}%` : `${item.value}${unit}`}
              {item.detail && (
                <span style={{ color: "var(--text-dim)", fontWeight: 400 }}> {item.detail}</span>
              )}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

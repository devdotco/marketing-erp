"use client";

import { useId, useState } from "react";

export interface TrendPoint {
  day: string;
  value: number;
}

/**
 * One measure over time. A single series, so there is no legend — the title
 * names it.
 *
 * Fixed viewBox, fluid width: text inside an SVG scaled with
 * preserveAspectRatio="none" shears, and a chart whose labels are unreadable at
 * phone width is not a responsive chart. Height follows the aspect ratio.
 *
 * Deliberately not a dual axis. Two measures on two scales go in two charts.
 */
export function TrendChart({
  points,
  unit = "%",
  max,
  label,
  height = 200,
}: {
  points: TrendPoint[];
  unit?: string;
  /** Upper bound of the scale. Defaults to the data's own max, rounded up. */
  max?: number;
  label: string;
  height?: number;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);

  if (points.length === 0) {
    return <Empty label={`No ${label.toLowerCase()} recorded yet.`} height={height} />;
  }

  const W = 720;
  const H = 220;
  const PAD = { top: 16, right: 18, bottom: 28, left: 44 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const dataMax = Math.max(...points.map((p) => p.value), 0);
  const dataMin = Math.min(...points.map((p) => p.value), 0);
  const top = max ?? niceCeil(dataMax);
  const bottom = dataMin < 0 ? niceFloor(dataMin) : 0;
  const span = top - bottom || 1;

  const x = (i: number) => (points.length === 1 ? PAD.left + plotW / 2 : PAD.left + (i / (points.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - ((v - bottom) / span) * plotH;

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${y(bottom).toFixed(1)} L${x(0).toFixed(1)},${y(bottom).toFixed(1)} Z`;

  // Four gridlines including the bounds, each labelled with a value the chart
  // actually reaches.
  const ticks = [0, 1, 2, 3].map((i) => bottom + (span * i) / 3);
  const last = points[points.length - 1];
  const active = hover !== null ? points[hover] : null;

  return (
    <div style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", maxWidth: "100%", display: "block" }}
        role="img"
        aria-label={`${label} from ${points[0].day} to ${last.day}. Latest ${format(last.value, unit)}.`}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--info)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--info)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {ticks.map((t, i) => (
          <g key={i}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--border)"
              strokeWidth="1"
              fill="none"
            />
            <text
              x={PAD.left - 8}
              y={y(t) + 4}
              textAnchor="end"
              fontSize="11"
              fill="var(--text-dim)"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {format(t, unit)}
            </text>
          </g>
        ))}

        <path d={area} fill={`url(#${id}-fill)`} stroke="none" />
        <path d={line} fill="none" stroke="var(--info)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {/* The endpoint is the number people came for, so it is always marked. */}
        <circle cx={x(points.length - 1)} cy={y(last.value)} r="4.5" fill="var(--info)" stroke="var(--bg)" strokeWidth="2" />

        {active && hover !== null && (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke="var(--border-strong)"
              strokeWidth="1"
              fill="none"
            />
            <circle cx={x(hover)} cy={y(active.value)} r="5" fill="var(--info)" stroke="var(--bg)" strokeWidth="2" />
          </g>
        )}

        {/* Hit targets, wider than the marks. */}
        {points.map((p, i) => (
          <rect
            key={p.day}
            x={x(i) - plotW / Math.max(points.length, 1) / 2}
            y={PAD.top}
            width={Math.max(plotW / Math.max(points.length, 1), 8)}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          >
            <title>{`${p.day}: ${format(p.value, unit)}`}</title>
          </rect>
        ))}

        <text x={PAD.left} y={H - 8} fontSize="11" fill="var(--text-dim)" style={{ fontVariantNumeric: "tabular-nums" }}>
          {points[0].day}
        </text>
        {points.length > 1 && (
          <text
            x={W - PAD.right}
            y={H - 8}
            textAnchor="end"
            fontSize="11"
            fill="var(--text-dim)"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {last.day}
          </text>
        )}
      </svg>

      {active && (
        <p
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            margin: "4px 0 0",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {active.day} · <strong style={{ color: "var(--text)" }}>{format(active.value, unit)}</strong>
        </p>
      )}
    </div>
  );
}

function format(value: number, unit: string): string {
  const rounded = Math.round(value * 10) / 10;
  return unit === "%" ? `${rounded}%` : `${rounded}${unit}`;
}

function niceCeil(value: number): number {
  if (value <= 0) return 10;
  if (value <= 10) return 10;
  if (value <= 25) return 25;
  if (value <= 50) return 50;
  return 100;
}

function niceFloor(value: number): number {
  return value >= -1 ? -1 : Math.floor(value);
}

function Empty({ label, height }: { label: string; height: number }) {
  return (
    <div
      style={{
        height,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px dashed var(--border)",
        borderRadius: "var(--radius)",
        fontSize: 13,
        color: "var(--text-dim)",
        textAlign: "center",
        padding: 16,
      }}
    >
      {label}
    </div>
  );
}

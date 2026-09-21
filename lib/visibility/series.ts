import { prisma } from "@/lib/prisma";
import { dimensionKeyFor, METRICS } from "./observations";

export interface SeriesPoint {
  day: string;
  value: number;
}

export interface Series {
  subject: string;
  metric: string;
  points: SeriesPoint[];
}

/** A figure with the change against the start of the window. */
export interface Delta {
  latest: number | null;
  previous: number | null;
  change: number | null;
  /** Days with a figure in them. A trend over two points is not a trend. */
  samples: number;
}

/**
 * Read one metric over time.
 *
 * Every dashboard read goes through here rather than touching Observation
 * directly, so the "which slice" question is answered in one place: an empty
 * dimensions object means the overall figure, NOT "any slice", and getting
 * that wrong silently mixes per-engine rows into the headline number.
 */
export async function readSeries(
  workspaceId: string,
  opts: {
    subject: string;
    metric: string;
    dimensions?: Record<string, string>;
    days?: number;
  },
): Promise<Series> {
  const since = dayOffset(opts.days ?? 30);
  const rows = await prisma.observation.findMany({
    where: {
      workspaceId,
      subject: opts.subject,
      metric: opts.metric,
      dimensionKey: dimensionKeyFor(opts.dimensions ?? {}),
      observedOn: { gte: since },
    },
    orderBy: { observedOn: "asc" },
    select: { observedOn: true, value: true },
  });

  return {
    subject: opts.subject,
    metric: opts.metric,
    points: rows.map((r) => ({ day: r.observedOn, value: r.value })),
  };
}

/** Latest value and the move since the first point in the window. */
export function deltaOf(series: Series): Delta {
  const points = series.points;
  if (points.length === 0) return { latest: null, previous: null, change: null, samples: 0 };
  const latest = points[points.length - 1].value;
  if (points.length === 1) return { latest, previous: null, change: null, samples: 1 };
  const previous = points[0].value;
  return {
    latest,
    previous,
    change: Math.round((latest - previous) * 10) / 10,
    samples: points.length,
  };
}

/** Share of voice: us against every tracked competitor, on the latest day. */
export async function shareOfVoice(
  workspaceId: string,
  days = 30,
): Promise<Array<{ subject: string; value: number; isBrand: boolean }>> {
  const since = dayOffset(days);
  const rows = await prisma.observation.findMany({
    where: { workspaceId, metric: METRICS.VISIBILITY, dimensionKey: "", observedOn: { gte: since } },
    orderBy: { observedOn: "desc" },
    select: { subject: true, value: true, observedOn: true },
  });
  if (rows.length === 0) return [];

  // Only the most recent day that has figures, so a competitor added midway
  // through the window does not read as having zero visibility before that.
  const latestDay = rows[0].observedOn;
  return rows
    .filter((r) => r.observedOn === latestDay)
    .map((r) => ({ subject: r.subject, value: r.value, isBrand: r.subject === "brand" }))
    .sort((a, b) => b.value - a.value);
}

/** The domains answers about us lean on, most-cited first. */
export async function citationAuthority(
  workspaceId: string,
  opts: { days?: number; limit?: number } = {},
): Promise<Array<{ domain: string; citations: number; isOwned: boolean }>> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (opts.days ?? 30));

  const grouped = await prisma.citation.groupBy({
    by: ["domain"],
    where: { workspaceId, capturedAt: { gte: since } },
    _count: { _all: true },
    _max: { isOwned: true },
    orderBy: { _count: { domain: "desc" } },
    take: opts.limit ?? 20,
  });

  return grouped.map((g) => ({
    domain: g.domain,
    citations: g._count._all,
    isOwned: Boolean(g._max.isOwned),
  }));
}

/** Per-engine visibility on the latest day that has figures. */
export async function visibilityByEngine(
  workspaceId: string,
  days = 30,
): Promise<Array<{ engine: string; value: number }>> {
  const since = dayOffset(days);
  const rows = await prisma.observation.findMany({
    where: {
      workspaceId,
      subject: "brand",
      metric: METRICS.VISIBILITY,
      dimensionKey: { startsWith: "engine=" },
      observedOn: { gte: since },
    },
    orderBy: { observedOn: "desc" },
    select: { dimensionKey: true, value: true, observedOn: true },
  });
  if (rows.length === 0) return [];
  const latestDay = rows[0].observedOn;
  return rows
    .filter((r) => r.observedOn === latestDay)
    .map((r) => ({ engine: r.dimensionKey.replace("engine=", ""), value: r.value }))
    .sort((a, b) => b.value - a.value);
}

function dayOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

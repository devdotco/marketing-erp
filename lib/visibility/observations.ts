import { prisma } from "@/lib/prisma";

export interface ObservationInput {
  subject: string;
  metric: string;
  dimensions?: Record<string, string>;
  value: number;
  source: string;
  observedOn: string;
}

/**
 * The stable string form of a slice.
 *
 * Postgres cannot put a JSON column in a unique index, so without this a
 * recompute APPENDS a second row for the same day rather than correcting the
 * first — and a trend line that silently doubles is worse than no trend line,
 * because it looks like growth. Keys are sorted so { engine, topic } and
 * { topic, engine } are the same slice.
 */
export function dimensionKeyFor(dimensions: Record<string, string> = {}): string {
  return Object.keys(dimensions)
    .sort()
    .map((k) => `${k}=${dimensions[k]}`)
    .join(";");
}

/**
 * Write derived figures for a day, correcting any already there.
 *
 * Upsert rather than insert, because a capture can be re-run: a retry after a
 * partial failure, a manual re-run, a backfill. Each of those recomputes the
 * same day and must land on the same rows.
 */
export async function recordObservations(workspaceId: string, rows: ObservationInput[]): Promise<number> {
  for (const row of rows) {
    const dimensions = row.dimensions ?? {};
    const dimensionKey = dimensionKeyFor(dimensions);
    await prisma.observation.upsert({
      where: {
        workspaceId_subject_metric_dimensionKey_observedOn: {
          workspaceId,
          subject: row.subject,
          metric: row.metric,
          dimensionKey,
          observedOn: row.observedOn,
        },
      },
      create: {
        workspaceId,
        subject: row.subject,
        metric: row.metric,
        dimensions,
        dimensionKey,
        value: row.value,
        source: row.source,
        observedOn: row.observedOn,
      },
      update: { value: row.value, dimensions, source: row.source, observedAt: new Date() },
    });
  }
  return rows.length;
}

/** The UTC day a figure describes, as YYYY-MM-DD. */
export function dayKey(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export const METRICS = {
  /** Share of captures in which the subject was mentioned at all, 0-100. */
  VISIBILITY: "visibility",
  /** Mean position of the subject among brands named in an answer. Lower is better. */
  BRAND_RANK: "brand_rank",
  /** Mean of POSITIVE=1 / NEUTRAL=0 / NEGATIVE=-1, over captures that named us. */
  SENTIMENT: "sentiment_score",
  /** Share of all citations pointing at a domain, 0-100. */
  CITATION_SHARE: "citation_share",
  /** How many captures named the subject. The count behind VISIBILITY. */
  MENTIONS: "answer_mentions",
  /** How many captures were taken. The denominator, stored so a chart can show thin days. */
  CAPTURES: "captures",
} as const;

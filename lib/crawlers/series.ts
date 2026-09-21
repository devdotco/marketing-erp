import { prisma } from "@/lib/prisma";

/**
 * Reads for the crawler and AI-referral views.
 *
 * Kept separate from lib/visibility/series.ts because these come from a
 * different source with a different trust level. Visibility figures are
 * derived from answers we captured ourselves; these are counts of what a CDN
 * saw, which is stronger evidence but a narrower question. Mixing the two
 * behind one module would make it easy to chart them as if they were the same
 * kind of number.
 */

function dayOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export interface BotTotal {
  bot: string;
  hits: number;
  verifiedHits: number;
  errorHits: number;
  pages: number;
}

/** Which AI crawlers came, and how much of that we could verify. */
export async function botTotals(workspaceId: string, days = 30): Promise<BotTotal[]> {
  const rows = await prisma.crawlerDaily.groupBy({
    by: ["bot"],
    where: { workspaceId, day: { gte: dayOffset(days) } },
    _sum: { hits: true, verifiedHits: true, errorHits: true },
    _count: { _all: true },
  });

  return rows
    .map((r) => ({
      bot: r.bot,
      hits: r._sum.hits ?? 0,
      verifiedHits: r._sum.verifiedHits ?? 0,
      errorHits: r._sum.errorHits ?? 0,
      pages: r._count._all,
    }))
    .sort((a, b) => b.hits - a.hits);
}

/** Crawl volume by day, for the trend. */
export async function crawlTrend(workspaceId: string, days = 30): Promise<Array<{ day: string; value: number }>> {
  const rows = await prisma.crawlerDaily.groupBy({
    by: ["day"],
    where: { workspaceId, day: { gte: dayOffset(days) } },
    _sum: { hits: true },
    orderBy: { day: "asc" },
  });
  return rows.map((r) => ({ day: r.day, value: r._sum.hits ?? 0 }));
}

/** The pages AI crawlers read most. */
export async function topCrawledPages(
  workspaceId: string,
  opts: { days?: number; limit?: number } = {},
): Promise<Array<{ path: string; hits: number; errorHits: number }>> {
  const rows = await prisma.crawlerDaily.groupBy({
    by: ["path"],
    where: { workspaceId, day: { gte: dayOffset(opts.days ?? 30) } },
    _sum: { hits: true, errorHits: true },
  });
  return rows
    .map((r) => ({ path: r.path, hits: r._sum.hits ?? 0, errorHits: r._sum.errorHits ?? 0 }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, opts.limit ?? 15);
}

/**
 * Pages an AI crawler was served an error on.
 *
 * The most actionable thing in this whole module, and invisible to tag-based
 * analytics because the page never rendered to run the tag. A crawler being
 * handed 404s or 500s is a visibility problem with a cause you can fix today.
 */
export async function crawlErrors(
  workspaceId: string,
  opts: { days?: number; limit?: number } = {},
): Promise<Array<{ path: string; bot: string; errorHits: number; hits: number }>> {
  const rows = await prisma.crawlerDaily.findMany({
    where: { workspaceId, day: { gte: dayOffset(opts.days ?? 30) }, errorHits: { gt: 0 } },
    select: { path: true, bot: true, errorHits: true, hits: true },
  });

  const merged = new Map<string, { path: string; bot: string; errorHits: number; hits: number }>();
  for (const row of rows) {
    const key = `${row.bot}|${row.path}`;
    const existing = merged.get(key);
    if (existing) {
      existing.errorHits += row.errorHits;
      existing.hits += row.hits;
    } else {
      merged.set(key, { ...row });
    }
  }
  return [...merged.values()].sort((a, b) => b.errorHits - a.errorHits).slice(0, opts.limit ?? 10);
}

/** Humans arriving from each AI surface. */
export async function referralTotals(
  workspaceId: string,
  days = 30,
): Promise<Array<{ source: string; visits: number }>> {
  const rows = await prisma.referralDaily.groupBy({
    by: ["source"],
    where: { workspaceId, day: { gte: dayOffset(days) } },
    _sum: { visits: true },
  });
  return rows
    .map((r) => ({ source: r.source, visits: r._sum.visits ?? 0 }))
    .sort((a, b) => b.visits - a.visits);
}

/** The pages AI answers actually send people to. */
export async function topReferredPages(
  workspaceId: string,
  opts: { days?: number; limit?: number } = {},
): Promise<Array<{ path: string; visits: number }>> {
  const rows = await prisma.referralDaily.groupBy({
    by: ["path"],
    where: { workspaceId, day: { gte: dayOffset(opts.days ?? 30) } },
    _sum: { visits: true },
  });
  return rows
    .map((r) => ({ path: r.path, visits: r._sum.visits ?? 0 }))
    .sort((a, b) => b.visits - a.visits)
    .slice(0, opts.limit ?? 15);
}

/** Has anything ever arrived? Decides between the empty state and the data. */
export async function hasCrawlData(workspaceId: string): Promise<boolean> {
  const row = await prisma.crawlerDaily.findFirst({ where: { workspaceId }, select: { id: true } });
  if (row) return true;
  const ref = await prisma.referralDaily.findFirst({ where: { workspaceId }, select: { id: true } });
  return Boolean(ref);
}

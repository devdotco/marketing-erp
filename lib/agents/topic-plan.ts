/**
 * Pure helpers for the Topic Planner: the things the model must not be trusted
 * with (dates, source lists, CSV) and the deterministic checks on what it returns.
 * No network, no database, so test/topic-plan.test.ts can cover all of it.
 */

export interface NearRankRow {
  query: string;
  page: string;
  position: number;
  impressions: number;
  clicks: number;
}

const BLOG_FORMATS = ["pillar", "cluster post", "listicle", "comparison", "tutorial", "case study", "benchmark report"];

/**
 * The closed list of contentFormat values for a `contentFormats` setting. Open-ended
 * labels drifted from the titles ("SEO Benchmark Report" tagged listicle), so the
 * prompt and the post-check share this one list.
 */
export function allowedFormats(setting: string): string[] {
  if (setting === "Blog posts only") return BLOG_FORMATS;
  if (setting === "Blog + landing pages") return [...BLOG_FORMATS, "landing page"];
  return [...BLOG_FORMATS, "landing page", "guide", "tool", "video"];
}

/**
 * Week start dates: the next Monday on or after today, then +7 days each. Done in
 * UTC so the result doesn't shift with the server's timezone.
 */
export function weekStartDates(today: Date, weeks: number): string[] {
  const base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const dow = new Date(base).getUTCDay(); // 0 = Sunday
  const untilMonday = (8 - dow) % 7;
  return Array.from({ length: weeks }, (_, i) =>
    new Date(base + (untilMonday + i * 7) * 86_400_000).toISOString().slice(0, 10),
  );
}

/** RFC 4180: quote any field containing a comma, quote, CR or LF; double embedded quotes. */
export function toCsv(rows: NearRankRow[]): string {
  const cols: Array<keyof NearRankRow> = ["query", "page", "position", "impressions", "clicks"];
  const cell = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n");
}

/** Titles naming a year before the current one ("2025" on a 2026 run). */
export function staleYearTitles(titles: string[], currentYear: number): string[] {
  return titles.filter((t) =>
    (t.match(/\b(?:19|20)\d{2}\b/g) ?? []).some((y) => Number(y) < currentYear),
  );
}

type Rec = Record<string, unknown>;

export interface PlanCheckInput {
  gscPages: string[];
  seoToolRead: boolean;
  formats: string[];
  currentYear: number;
  weekStarts: string[];
}

/**
 * Normalise the parsed plan in place and return the warnings a reviewer should see.
 * Overwrites weekStarting with the computed dates, and nulls traffic/KD the model
 * invented when no SEO tool was read.
 */
export function checkTopicPlan(plan: Rec, input: PlanCheckInput): string[] {
  const warnings: string[] = [];
  const weeks = Array.isArray(plan.weeklyCalendar) ? (plan.weeklyCalendar as Rec[]) : [];
  weeks.forEach((w, i) => {
    if (w && typeof w === "object") w.weekStarting = input.weekStarts[i] ?? null;
  });

  const topics = weeks.flatMap((w) => (Array.isArray(w?.topics) ? (w.topics as Rec[]) : []));
  const label = (t: Rec) => `"${String(t.title ?? t.id ?? "untitled")}"`;

  const stale = staleYearTitles(topics.map((t) => String(t.title ?? "")), input.currentYear);
  if (stale.length) warnings.push(`${stale.length} title(s) name a past year, so they read as out of date: ${stale.map((t) => `"${t}"`).join("; ")}.`);

  const pages = new Set(input.gscPages);
  const allowed = new Set(input.formats);
  for (const t of topics) {
    const action = t.action;
    if ((action === "refresh" || action === "consolidate") && !(typeof t.existingUrl === "string" && pages.has(t.existingUrl))) {
      warnings.push(`${label(t)} is marked ${action} but its existingUrl isn't a page from the Search Console rows, so check it for cannibalization before assigning.`);
    }
    if (action === "consolidate") {
      const merge = Array.isArray(t.mergeUrls) ? (t.mergeUrls as unknown[]) : [];
      const unknown = merge.filter((u) => typeof u !== "string" || !pages.has(u));
      if (merge.length === 0 || unknown.length) warnings.push(`${label(t)} consolidates pages, but mergeUrls is empty or includes URLs not in the Search Console rows.`);
    }
    const fmt = String(t.contentFormat ?? "").toLowerCase();
    if (!allowed.has(fmt)) warnings.push(`${label(t)} has contentFormat "${String(t.contentFormat ?? "")}", which isn't one of: ${input.formats.join(", ")}.`);
  }

  if (!input.seoToolRead) {
    let nulled = 0;
    for (const t of topics) {
      if (t.keywordDifficulty != null) { t.keywordDifficulty = null; nulled++; }
    }
    const gaps = Array.isArray(plan.competitorGapInsights) ? (plan.competitorGapInsights as Rec[]) : [];
    for (const g of gaps) {
      if (g && g.estimatedMonthlyTraffic != null) { g.estimatedMonthlyTraffic = null; nulled++; }
    }
    if (nulled) warnings.push(`No SEO tool data was read, so ${nulled} keyword difficulty / competitor traffic figure(s) the model supplied were removed as invented.`);
  }
  return warnings;
}

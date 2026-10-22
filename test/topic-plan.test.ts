/**
 * Checks for the Topic Planner's deterministic layer (2026-10-21 QA findings).
 * Pure: no network, no database.
 */
import { allowedFormats, checkTopicPlan, staleYearTitles, toCsv, weekStartDates } from "@/lib/agents/topic-plan";

let failures = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!cond) failures += 1;
};

// Stale years
const stale = staleYearTitles(["SEO Benchmarks 2025", "Plan for 2026", "Trends 2027", "No year here", "Top 10 tools"], 2026);
check("staleYearTitles: only the past year is flagged", stale.length === 1 && stale[0].includes("2025"), stale);

// Week dates (2026-10-22 is a Thursday; next Monday is 10-26)
const w = weekStartDates(new Date("2026-10-22T15:00:00Z"), 3);
check("weekStartDates: next Monday then +7", w.join() === "2026-10-26,2026-11-02,2026-11-09", w);
check("weekStartDates: a Monday is its own start", weekStartDates(new Date("2026-10-26T00:00:00Z"), 1)[0] === "2026-10-26");
check("weekStartDates: a Sunday rolls to the next day", weekStartDates(new Date("2026-10-25T23:00:00Z"), 1)[0] === "2026-10-26");

// CSV
const csv = toCsv([{ query: 'best "seo", agency', page: "https://x.com/a", position: 8.2, impressions: 576, clicks: 0 }]);
check("toCsv: header first", csv.startsWith("query,page,position,impressions,clicks\r\n"), csv);
check("toCsv: quotes and commas are RFC4180-escaped", csv.includes('"best ""seo"", agency",https://x.com/a,8.2,576,0'), csv);

// Format allow-list
check("allowedFormats: blog only excludes landing page", !allowedFormats("Blog posts only").includes("landing page") && allowedFormats("Blog posts only").includes("benchmark report"));
check("allowedFormats: blog + landing adds landing page only", allowedFormats("Blog + landing pages").includes("landing page") && !allowedFormats("Blog + landing pages").includes("video"));
check("allowedFormats: all adds guide, tool, video", ["guide", "tool", "video"].every((f) => allowedFormats("All formats").includes(f)));

const mk = (topic: Record<string, unknown>) => ({
  weeklyCalendar: [{ week: 1, topics: [{ title: "T", contentFormat: "listicle", action: "new", ...topic }] }],
  competitorGapInsights: [{ competitorUrl: "c.com", estimatedMonthlyTraffic: "800K" }],
});
const base = { gscPages: ["https://x.com/a"], seoToolRead: true, formats: allowedFormats("Blog posts only"), currentYear: 2026, weekStarts: ["2026-10-26"] };

// Format warning
const f = checkTopicPlan(mk({ contentFormat: "webinar" }), base);
check("format outside the set warns", f.some((m) => m.includes("webinar")), f);
check("format inside the set is quiet", checkTopicPlan(mk({}), base).length === 0);

// existingUrl
const r1 = checkTopicPlan(mk({ action: "refresh", existingUrl: "https://x.com/other" }), base);
check("refresh with a URL not in GSC warns", r1.some((m) => m.includes("existingUrl")), r1);
const r2 = checkTopicPlan(mk({ action: "refresh", existingUrl: "https://x.com/a" }), base);
check("refresh with a GSC URL is quiet", r2.length === 0, r2);
const r3 = checkTopicPlan(mk({ action: "consolidate", existingUrl: "https://x.com/a", mergeUrls: [] }), base);
check("consolidate without mergeUrls warns", r3.some((m) => m.includes("mergeUrls")), r3);

// weekStarting overwrite
const plan = mk({});
(plan.weeklyCalendar[0] as Record<string, unknown>).weekStarting = "1999-01-01";
checkTopicPlan(plan, base);
check("weekStarting is overwritten with the computed date", (plan.weeklyCalendar[0] as Record<string, unknown>).weekStarting === "2026-10-26");

// Invented traffic / KD
const inv = mk({ keywordDifficulty: 42 });
const wn = checkTopicPlan(inv, { ...base, seoToolRead: false });
const t0 = (inv.weeklyCalendar[0].topics as Array<Record<string, unknown>>)[0];
check("KD nulled when no SEO tool was read", t0.keywordDifficulty === null);
check("competitor traffic nulled when no SEO tool was read", inv.competitorGapInsights[0].estimatedMonthlyTraffic === null);
check("a warning says so", wn.some((m) => m.includes("No SEO tool data")), wn);
const keep = mk({ keywordDifficulty: 42 });
checkTopicPlan(keep, base);
check("live SEO data keeps its figures", (keep.weeklyCalendar[0].topics as Array<Record<string, unknown>>)[0].keywordDifficulty === 42);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

/**
 * AI visibility against a real Postgres. Needs DATABASE_URL pointing at a
 * throwaway database — these tests WRITE. Run with `npm run test:visibility:db`.
 *
 * These cover what test/visibility.test.ts cannot: the queries themselves.
 * Relation filters inside groupBy, a compound unique used as an upsert key, and
 * a startsWith over a slice key are all things that typecheck perfectly and
 * then throw — or worse, quietly return the wrong rows — only when a database
 * is on the other end.
 *
 * deriveDay is called with an explicit brand rather than letting it resolve one.
 * That is a harness accommodation, not a shortcut: resolveBrand issues two
 * queries through Promise.all, and the PGlite socket server used for local runs
 * serves one at a time. Every query this file is actually testing still runs.
 */
import { PrismaClient } from "@prisma/client";
import { deriveDay } from "@/lib/visibility/capture";
import type { BrandIdentity } from "@/lib/visibility/brand";
import { recordObservations } from "@/lib/visibility/observations";
import { citationAuthority, readSeries, shareOfVoice, visibilityByEngine } from "@/lib/visibility/series";

const prisma = new PrismaClient();

let failures = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!cond) failures += 1;
};

const DAY = "2026-09-20";
const DAY2 = "2026-09-21";

async function main() {
  // Two workspaces on purpose: every assertion about A is also an assertion
  // that B cannot see it.
  const a = await prisma.workspace.create({ data: { name: "Acme QA", slug: `acme-${Date.now()}` } });
  const b = await prisma.workspace.create({ data: { name: "Other QA", slug: `other-${Date.now()}` } });

  await prisma.businessProfile.create({
    data: { workspaceId: a.id, businessName: "Acme", websiteUrl: "https://acme.com", competitors: ["Globex"] },
  });
  await prisma.businessProfile.create({
    data: { workspaceId: b.id, businessName: "Other", websiteUrl: "https://other.com", competitors: [] },
  });
  await prisma.competitor.create({ data: { workspaceId: a.id, name: "Globex", domain: "globex.com" } });

  const p1 = await prisma.trackedPrompt.create({ data: { workspaceId: a.id, text: "best crm?", topic: "discovery" } });
  const p2 = await prisma.trackedPrompt.create({ data: { workspaceId: a.id, text: "crm alternatives?", topic: "alts" } });
  const pb = await prisma.trackedPrompt.create({ data: { workspaceId: b.id, text: "best crm?" } });

  // Same prompt text in two workspaces must be allowed — the unique is scoped.
  check("the same prompt text can exist in two workspaces", pb.id !== p1.id);

  const mk = async (
    workspaceId: string,
    promptId: string,
    engine: "CLAUDE" | "OPENAI",
    day: string,
    opts: { mentioned: boolean; rank?: number; sentiment?: string; competitors?: string[] },
  ) =>
    prisma.answerCapture.create({
      data: {
        workspaceId,
        promptId,
        engine,
        model: "test-model",
        answerText: "…",
        capturedOn: day,
        brandMentioned: opts.mentioned,
        brandRank: opts.rank ?? null,
        sentiment: opts.sentiment ?? null,
        competitors: opts.competitors ?? [],
      },
    });

  // Workspace A, day 1: 4 captures, brand named in 2 → 50%.
  const c1 = await mk(a.id, p1.id, "CLAUDE", DAY, { mentioned: true, rank: 1, sentiment: "POSITIVE", competitors: ["Globex"] });
  await mk(a.id, p1.id, "OPENAI", DAY, { mentioned: false, competitors: ["Globex"] });
  const c3 = await mk(a.id, p2.id, "CLAUDE", DAY, { mentioned: true, rank: 2, sentiment: "NEUTRAL", competitors: ["Globex"] });
  await mk(a.id, p2.id, "OPENAI", DAY, { mentioned: false });

  // Workspace B, same day, brand always named. If isolation leaks, A's
  // visibility rises towards B's.
  await mk(b.id, pb.id, "CLAUDE", DAY, { mentioned: true, rank: 1 });

  await prisma.citation.createMany({
    data: [
      { captureId: c1.id, workspaceId: a.id, domain: "acme.com", url: "https://acme.com/x", position: 1, isOwned: true },
      { captureId: c1.id, workspaceId: a.id, domain: "g2.com", url: "https://g2.com/y", position: 2, isOwned: false },
      { captureId: c3.id, workspaceId: a.id, domain: "g2.com", url: "https://g2.com/z", position: 1, isOwned: false },
    ],
  });

  // ── The query that only fails with a database attached ────────────────────
  const brand: BrandIdentity = {
    name: "Acme",
    terms: ["acme", "acme.com"],
    domain: "acme.com",
    competitors: [{ name: "Globex", terms: ["globex"], domain: "globex.com" }],
  };

  const rows = await deriveDay(a.id, DAY, brand);
  check("deriveDay runs the groupBy with a relation filter without throwing", rows > 0, rows);

  const vis = await readSeries(a.id, { subject: "brand", metric: "visibility", days: 3650 });
  check("visibility is 50% — 2 of 4 captures named the brand", vis.points.at(-1)?.value === 50, vis.points);

  const visB = await readSeries(b.id, { subject: "brand", metric: "visibility", days: 3650 });
  check("workspace B is unaffected by A's captures", visB.points.length === 0, visB.points);

  const rank = await readSeries(a.id, { subject: "brand", metric: "brand_rank", days: 3650 });
  check("mean rank averages only the captures that named us", rank.points.at(-1)?.value === 1.5, rank.points);

  const sent = await readSeries(a.id, { subject: "brand", metric: "sentiment_score", days: 3650 });
  check("sentiment averages POSITIVE(1) and NEUTRAL(0) to 0.5", sent.points.at(-1)?.value === 0.5, sent.points);

  const competitor = await readSeries(a.id, { subject: "Globex", metric: "visibility", days: 3650 });
  check("a competitor named in 3 of 4 answers reads 75%", competitor.points.at(-1)?.value === 75, competitor.points);

  const engines = await visibilityByEngine(a.id, 3650);
  const claude = engines.find((e) => e.engine === "CLAUDE");
  const openai = engines.find((e) => e.engine === "OPENAI");
  check("per-engine slices split correctly (Claude 100%, OpenAI 0%)", claude?.value === 100 && openai?.value === 0, engines);

  const voice = await shareOfVoice(a.id, 3650);
  check("share of voice lists the brand and the competitor", voice.length === 2, voice);
  check("share of voice is sorted with the leader first", voice[0].subject === "Globex", voice);

  const authority = await citationAuthority(a.id, { days: 3650 });
  check("citation authority counts a domain once per link", authority.find((x) => x.domain === "g2.com")?.citations === 2, authority);
  check("the workspace's own site is flagged", authority.find((x) => x.domain === "acme.com")?.isOwned === true, authority);

  const authorityB = await citationAuthority(b.id, { days: 3650 });
  check("citation authority does not leak across workspaces", authorityB.length === 0, authorityB);

  // ── Idempotency: the property that makes a retry safe ─────────────────────
  const before = await prisma.observation.count({ where: { workspaceId: a.id } });
  await deriveDay(a.id, DAY, brand);
  const after = await prisma.observation.count({ where: { workspaceId: a.id } });
  check("re-deriving the same day corrects rows rather than appending", before === after, { before, after });

  // A changed reading must overwrite, not sit beside the old one.
  await recordObservations(a.id, [
    { subject: "brand", metric: "visibility", value: 99, source: "TEST", observedOn: DAY },
  ]);
  const overwritten = await readSeries(a.id, { subject: "brand", metric: "visibility", days: 3650 });
  check("an overwrite replaces the day's value", overwritten.points.at(-1)?.value === 99, overwritten.points);
  check("an overwrite does not add a second point for the day", overwritten.points.length === 1, overwritten.points);

  // Per-day capture uniqueness: the constraint a retry depends on.
  let duplicateRejected = false;
  try {
    await mk(a.id, p1.id, "CLAUDE", DAY, { mentioned: true });
  } catch {
    duplicateRejected = true;
  }
  check("a second capture for the same prompt/engine/day is rejected", duplicateRejected);

  // ── Two days, so the delta has something to measure ──────────────────────
  await mk(a.id, p1.id, "CLAUDE", DAY2, { mentioned: true, rank: 1, sentiment: "POSITIVE" });
  await mk(a.id, p2.id, "CLAUDE", DAY2, { mentioned: true, rank: 1, sentiment: "POSITIVE" });
  await deriveDay(a.id, DAY2, brand);
  const twoDays = await readSeries(a.id, { subject: "brand", metric: "visibility", days: 3650 });
  check("a second day appends a second point", twoDays.points.length === 2, twoDays.points);
  check("points come back oldest first", twoDays.points[0].day === DAY, twoDays.points);

  // Cleanup so a re-run starts clean.
  await prisma.workspace.deleteMany({ where: { id: { in: [a.id, b.id] } } });
  const orphans = await prisma.observation.count({ where: { workspaceId: a.id } });
  check("deleting a workspace cascades its observations away", orphans === 0, orphans);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error("\nTHREW:", err);
    await prisma.$disconnect();
    process.exit(1);
  });

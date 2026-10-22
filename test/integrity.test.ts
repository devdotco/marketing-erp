/**
 * The output gate between an agent and the Approve button. No network, no database.
 * Run with `npm run test:integrity`.
 *
 * Fixtures are shaped like the runs in the 2026-10-21 QA audit: Topic Planner,
 * Repurposer and Newsletter all stopped mid-string, were stored as
 * { result: "<escaped half-JSON>" }, and sat in AWAITING_APPROVAL with nothing
 * on the page to say so.
 */
import Anthropic from "@anthropic-ai/sdk";
import { addReview, checkOutput, normalizeOutput, OutputIncompleteError } from "@/lib/agents/integrity";
import { dateContext, OutputTruncatedError } from "@/lib/ai/messages";
import { describeRunError } from "@/lib/ai/errors";

let failures = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!cond) failures += 1;
};

const meta = { generatedAt: "2026-10-21T19:49:25.078Z", workspaceId: "cmtooalog000113mx5yqwjb5i" };

// Topic Planner run 1: cut off inside topic 8's title.
{
  const truncated = {
    result: '{"calendarOverview":{"period":"4 weeks","totalTopics":8},"weeklyCalendar":[{"week":4,"topics":[{"id":"t8","title":"Programmatic Media Buying Services: The Complete',
    source: "live",
    ...meta,
  };
  const f = checkOutput(normalizeOutput(truncated));
  check("a cut-off JSON answer is blocking", f.blocking.length === 1 && /cut off/.test(f.blocking[0]), f);
}

// Repurposer: cut off mid-sentence, no source field at all.
{
  const truncated = { result: '{"sourceTitle":"AI Killed White Label","videoScript":{"scenes":[{"broll":"Shot of a developer reviewing code on a', ...meta };
  check("Repurposer's cut-off is blocking too", checkOutput(truncated).blocking.length === 1, checkOutput(truncated));
}

// A handler's regex parse can fail on output that IS valid (fenced). Don't punish that.
{
  const fenced = { result: '```json\n{"variants":[{"name":"pain-led"}]}\n```', ...meta };
  const n = normalizeOutput(fenced);
  check("valid fenced JSON under result is unwrapped", Array.isArray(n["variants"]) && !("result" in n), n);
  check("and is not blocking", checkOutput(n).blocking.length === 0, checkOutput(n));
  check("and the bookkeeping fields survive", n["workspaceId"] === meta.workspaceId, n);
}

// Prose answers are legitimate for some agents.
{
  const prose = { result: "Here are three ideas for this week's posts…", ...meta };
  check("a prose result is not mistaken for broken JSON", checkOutput(prose).blocking.length === 0, checkOutput(prose));
}

// Blog Writer, audit of 2026-09-11: an empty draft marked APPROVED.
{
  const empty = { title: "x", content: "", ...meta };
  check("an empty draft body is blocking", checkOutput(empty).blocking.some((b) => /empty/.test(b)), checkOutput(empty));
  check("bookkeeping alone is blocking", checkOutput({ ...meta, source: "live" }).blocking.length === 1, checkOutput(meta));
}

// Newsletter: simulated, with an unsourced story.
{
  const sim = { subjectLine: "x", stories: [{ headline: "a", sourceUrl: null }, { headline: "b", sourceUrl: "https://x.test" }], source: "simulation", ...meta };
  const f = checkOutput(sim);
  check("simulation is approvable but warned", f.blocking.length === 0 && f.warnings.some((w) => /No live data/.test(w)), f);
  check("unsourced items are counted", f.warnings.some((w) => /^1 item has no source/.test(w)), f.warnings);
}

// Landing Page Copy: nine testimonials with sourceUrl null.
{
  const lp = { variants: [0, 1, 2].map(() => ({ socialProof: [0, 1, 2].map(() => ({ quote: "q", sourceUrl: null })) })), ...meta };
  check("nested null sources are all counted", checkOutput(lp).warnings.some((w) => /^9 items/.test(w)), checkOutput(lp).warnings);
}

// Handler-supplied findings merge with the generic ones.
{
  const o: Record<string, unknown> = { body: "x", ...meta };
  addReview(o, { warnings: ["one"] });
  addReview(o, { warnings: ["two"], blocking: ["broken"] });
  const f = checkOutput(o);
  check("addReview accumulates", f.warnings.join() === "one,two" && f.blocking.join() === "broken", f);
}

// Error classification for both new failure modes.
{
  const t = describeRunError(new OutputTruncatedError('{"a":"cut', 0.09));
  check("truncation is its own error code", t.code === "output_truncated", t.code);
  check("and is not retried — the same prompt truncates again", t.retryable === false, t.retryable);
  check("and the hint suggests a smaller scope", /smaller scope/.test(t.hint), t.hint);
  const i = describeRunError(new OutputIncompleteError(["The draft body is empty."]));
  check("an incomplete output is its own code", i.code === "output_incomplete", i.code);
  check("and says what was wrong", /draft body is empty/.test(i.hint), i.hint);
  check("an SDK error still classifies as before", describeRunError(new Anthropic.APIConnectionError({ message: "x" })).code === "connection_failed");
}

// The date the model is told.
{
  const d = dateContext(new Date("2026-10-21T19:49:25Z"));
  check("date context names today", d.includes("2026-10-21"), d);
  check("and forbids earlier years in titles", /never an earlier year/.test(d), d);
}

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall passing");

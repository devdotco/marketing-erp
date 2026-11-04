/**
 * Email Marketing campaign types: locked templates, the pre-approval checks,
 * and the monthly Nth-weekday calendar. No network, no database. Run with
 * `npm run test:email-campaigns`.
 *
 * Runs against the real Digital.Marketing masters (test/fixtures), marked up
 * exactly as they are loaded into the template library, so a marker or
 * renderer change that would break a real send fails here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  handlebarsTags,
  hrefsOf,
  isEditable,
  lockedSkeleton,
  parseTemplate,
  renderTemplate,
  swapUnsubscribeLinks,
  type SectionValues,
} from "@/lib/email-campaigns/template";
import { findPrice, htmlProblem, runChecks, type CheckInput } from "@/lib/email-campaigns/checks";
import { draftDueAt, nextOccurrence, nthWeekdayOf, occurrenceOn, upcomingOccurrences } from "@/lib/email-campaigns/schedule";
import { storedDraftProblems } from "@/lib/email-campaigns/approve";

let failures = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!cond) failures += 1;
};

const fixture = (name: string) => readFileSync(join(process.cwd(), "test", "fixtures", name), "utf8");
const dashboard = fixture("dm-dashboard-master.html");
const press = fixture("dm-press-release-master.html");

// ── Parsing the real masters ──────────────────────────────────────────────

const dash = parseTemplate(dashboard);
check("dashboard master parses with no marker errors", dash.errors.length === 0, dash.errors);
check(
  "dashboard sections are the spec's",
  dash.sections.map((s) => s.key).join(",") === "title,preheader,eyebrow,headline,intro.1,intro.2,spotlight.blurb,talk",
  dash.sections.map((s) => s.key),
);
check("dashboard headline original", dash.sections.find((s) => s.key === "headline")?.original === "Pick up where you left off.");
check("title marker wraps the element, original is its text", dash.sections.find((s) => s.key === "title")?.original === "Pick up where you left off");

const pr = parseTemplate(press);
check("press release master parses with no marker errors", pr.errors.length === 0, pr.errors);
const intro = pr.sections.find((s) => s.key === "intro");
check("press release intro is 3 paragraphs, greeting excluded", Array.isArray(intro?.original) && intro.original.length === 3, intro?.original);
check("rich original keeps bare <strong>", pr.sections.find((s) => s.key === "reach.check.1")?.original === "<strong>Be the answer.</strong> AI models lean on trusted news. Your release puts you in the source set they cite.");
check("entities decoded in what the model sees", pr.sections.find((s) => s.key === "stats.1.label")?.original === "news outlets & wire endpoints");

check("Handlebars inside a marker is refused", parseTemplate('<!--edit:x text-->{{first_name}}<!--/edit:x-->').errors.length > 0);
check("an unclosed marker is refused", parseTemplate("<!--edit:x text-->hello").errors.length > 0);
check("a template with no markers is refused", parseTemplate("<html><body>hi</body></html>").errors.length > 0);

// ── Rendering ─────────────────────────────────────────────────────────────

check("rendering with no values reproduces the master byte for byte", renderTemplate(dashboard, {}) === dashboard);
check("…for the press release too", renderTemplate(press, {}) === press);

const goodDash: SectionValues = {
  title: "Your account is right where you left it",
  preheader: "Everything you started is still there, and your AI agent is ready too.",
  headline: "Your account is right where you left it.",
  "intro.2": "What should we move forward next? Reply and tell us, and we'll help you get it working.",
  "spotlight.blurb": "Hand the day-to-day to an AI agent so campaigns keep moving between check-ins.",
};
const rendered = renderTemplate(dashboard, goodDash);
check("headline replaced", rendered.includes("Your account is right where you left it.\n"));
check("title replaced inside <title>", rendered.includes("<title>Your account is right where you left it</title>"));
check("locked skeleton identical after a fill", lockedSkeleton(rendered) === lockedSkeleton(dashboard));
check("greeting Handlebars untouched", handlebarsTags(rendered).join(" ") === "{{#if first_name}} {{first_name}} {{else}} {{/if}}", handlebarsTags(rendered));
check("apostrophe in new copy is not mangled", rendered.includes("we'll help you get it working."));

const prRendered = renderTemplate(press, {
  intro: ["First paragraph.", "Second paragraph.", "Third, closing paragraph."],
  "reach.check.1": "<strong>Be cited.</strong> AI answers lean on trusted news.",
});
check("paragraphs: all but last take the first master <p> tag", (prRendered.match(/margin:0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size:17px; line-height:1.65; color:#26303B;">First paragraph\./g) ?? []).length === 1);
check("paragraphs: last takes the closing margin:0 tag", prRendered.includes('<p class="dm-body-text" style="margin:0; font-family: Arial, Helvetica, sans-serif; font-size:17px; line-height:1.65; color:#26303B;">Third, closing paragraph.</p>'));
check("rich <strong> reuses the master's styled tag", prRendered.includes('<strong style="color:#0B1220;">Be cited.</strong>'));
check("press release skeleton identical after a fill", lockedSkeleton(prRendered) === lockedSkeleton(press));
check("model-written style/script tags are stripped", !renderTemplate(dashboard, { "intro.2": 'Hi <script>x()</script><span style="color:red">there</span>' }).includes("<script"));
check("a javascript: link is dropped to text", !renderTemplate(dashboard, { talk: 'Rather <a href="javascript:alert(1)">call</a>' }).includes("javascript:"));

// ── Unsubscribe swap ─────────────────────────────────────────────────────

const swapped = swapUnsubscribeLinks(rendered);
check("unsubscribe link swapped", swapped.includes('class="Unsubscribe--unsubscribeLink" href="{{{unsubscribe}}}"'));
check("preferences link swapped", swapped.includes('href="{{{unsubscribe_preferences}}}" target="_blank" class="Unsubscribe--unsubscribePreferences"'));
check("no href=\"#\" left", !swapped.includes('href="#"'));

// ── Checks ───────────────────────────────────────────────────────────────

function inputFor(values: SectionValues, over: Partial<CheckInput> = {}): CheckInput {
  const r = renderTemplate(dashboard, values);
  return {
    master: dashboard,
    rendered: r,
    final: swapUnsubscribeLinks(r),
    subjects: ["Your account is right where you left it", "Ready when you are", "One login, all your marketing"],
    values,
    parsed: dash,
    editableKeys: dash.sections.filter((s) => isEditable(s.key, ["title", "preheader", "headline", "intro.2", "spotlight.blurb", "talk"])).map((s) => s.key),
    recentSubjects: ["Pick up where you left off with Digital.Marketing"],
    recentHeadlines: ["Pick up where you left off."],
    allowEmDash: false,
    bannedWords: ["leverage"],
    bannedPhrases: ["in today's fast-paced"],
    maxLengths: { headline: 60, "intro.2": 200, "spotlight.blurb": 200, title: 60, preheader: 120 },
    ...over,
  };
}
const failed = (r: ReturnType<typeof runChecks>) => r.results.filter((x) => !x.passed).map((x) => x.name);

const ok = runChecks(inputFor(goodDash));
check("a good Dashboard fill passes every check", ok.passed, ok.failures);

check("'$' in copy fails", failed(runChecks(inputFor({ ...goodDash, "intro.2": "Plans from $99." }))).includes("No prices or $"));
check("'per month' price fails", failed(runChecks(inputFor({ ...goodDash, "intro.2": "Only 99 per month." }))).includes("No prices or $"));
check("price in a subject fails", failed(runChecks(inputFor(goodDash, { subjects: ["Save 20% off today"] }))).includes("No prices or $"));
check("em dash fails", failed(runChecks(inputFor({ ...goodDash, headline: "Ready — when you are." }))).includes("No em dashes"));
check("injected Handlebars fails", failed(runChecks(inputFor({ ...goodDash, "intro.2": "Hi {{last_name}}" }))).includes("Handlebars intact"));
check("reused subject fails", failed(runChecks(inputFor(goodDash, { subjects: ["Pick up where you left off with Digital.Marketing!"] }))).includes("Subject not reused"));
check("reused headline fails", failed(runChecks(inputFor({ ...goodDash, headline: "Pick up where you left off" }))).includes("Headline not reused"));
check(
  "changed link in the talk line fails",
  failed(runChecks(inputFor({ ...goodDash, talk: 'Rather talk? <a href="https://example.com/call">Book a call</a> or <a href="mailto:hello@digital.marketing">reply</a>.' }))).includes("Links and CTAs unchanged"),
);
check(
  "talk line with both links kept passes",
  runChecks(inputFor({ ...goodDash, talk: 'Prefer a person? <a href="https://api.marketer.co/widget/bookings/timothycarter">Book a quick call</a> or <a href="mailto:hello@digital.marketing">just reply</a>.' })).passed,
);
check("a section not allowed by the campaign fails", failed(runChecks(inputFor({ ...goodDash, eyebrow: "HELLO" }))).includes("Only allowed sections changed"));
check("an unclosed <strong> fails HTML", failed(runChecks(inputFor({ ...goodDash, "intro.2": "<strong>Hey there" }))).includes("Valid HTML"));
check("banned word fails", failed(runChecks(inputFor({ ...goodDash, "intro.2": "We leverage your account." }))).includes("No banned words"));
check("overlong section fails", failed(runChecks(inputFor({ ...goodDash, headline: "x".repeat(80) }))).includes("Sections within length"));
check("a missing unsubscribe swap fails", failed(runChecks(inputFor(goodDash, { final: renderTemplate(dashboard, goodDash) }))).includes("Unsubscribe tags swapped"));
check("tampering outside the markers fails", failed(runChecks(inputFor(goodDash, { rendered: rendered.replace("#0B1220", "#FF0000") }))).includes("Locked template unchanged"));

check("both masters' own HTML is well formed", htmlProblem(dashboard) === null && htmlProblem(press) === null, [htmlProblem(dashboard), htmlProblem(press)]);
for (const phrase of ["500+ news outlets", "97% search engine pickup", "5.9B+ potential monthly audience", "88% major newsdesk coverage", "sign in to see pricing and options", "4 steps, from 1 brief"]) {
  check(`no false price on "${phrase}"`, findPrice(phrase) === null, findPrice(phrase));
}
check("the press release master's own copy has no price", findPrice(press.replace(/<[^>]+>/g, " ")) === null, findPrice(press.replace(/<[^>]+>/g, " ")));
check("links in master and swapped master are the same set", hrefsOf(swapUnsubscribeLinks(press)).length === hrefsOf(press).length);

check("isEditable: exact key", isEditable("intro.2", ["intro.2"]) && !isEditable("intro.1", ["intro.2"]));
check("isEditable: group", isEditable("stats.1.value", ["stats"]));

// ── Calendar ─────────────────────────────────────────────────────────────

const DASH = { sendWeekday: 4, sendNth: 3, sendTime: "09:00", timezone: "America/Denver", draftWeekday: 1, draftTime: "17:47" };
const PRESS = { ...DASH, sendWeekday: 3, sendNth: 1 };

const nextDash = nextOccurrence(DASH, new Date("2026-11-04T18:00:00Z"));
check("next Dashboard send is Thu Nov 19", nextDash?.sendDate === "2026-11-19", nextDash);
check("…at 9:00 MST = 16:00Z", nextDash?.sendAt.toISOString() === "2026-11-19T16:00:00.000Z", nextDash?.sendAt);
check("…drafted Mon Nov 16 17:47 MST = 00:47Z Nov 17", nextDash?.draftAt.toISOString() === "2026-11-17T00:47:00.000Z", nextDash?.draftAt);

const spec = upcomingOccurrences(PRESS, new Date("2026-11-05T00:00:00Z"), 2).map((o) => o.sendDate);
check("Press Release sends Dec 2 then Jan 6", spec.join(",") === "2026-12-02,2027-01-06", spec);
const dec2 = occurrenceOn(PRESS, { year: 2026, month: 12, day: 2 });
check("Dec 2 send is drafted Mon Nov 30 (across the month boundary)", dec2.draftAt.toISOString() === "2026-12-01T00:47:00.000Z", dec2.draftAt);
check("Dec 17 Dashboard drafted Dec 14", occurrenceOn(DASH, { year: 2026, month: 12, day: 17 }).draftAt.toISOString() === "2026-12-15T00:47:00.000Z");
check("DST: 9:00 MDT in April is 15:00Z", occurrenceOn(PRESS, { year: 2027, month: 4, day: 7 }).sendAt.toISOString() === "2027-04-07T15:00:00.000Z");
check("first Wednesday always falls on day 1-7", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].every((m) => (nthWeekdayOf(2027, m, 3, 1)?.day ?? 99) <= 7));
check("third Thursday always falls on day 15-21", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].every((m) => { const d = nthWeekdayOf(2027, m, 4, 3)?.day ?? 0; return d >= 15 && d <= 21; }));
check("no fifth Monday in Feb 2027", nthWeekdayOf(2027, 2, 1, 5) === null);
check("last Friday of Nov 2026 is the 27th", nthWeekdayOf(2026, 11, 5, -1)?.day === 27);

check("draft is due at its exact minute", draftDueAt(DASH, new Date("2026-11-17T00:47:00Z"))?.sendDate === "2026-11-19");
check("…and not the minute after", draftDueAt(DASH, new Date("2026-11-17T00:48:00Z")) === null);
check("…and not on an ordinary Monday", draftDueAt(DASH, new Date("2026-11-10T00:47:00Z")) === null);

// ── Approval guard ───────────────────────────────────────────────────────

const stored = { campaignId: "c", chosenSubject: "Ready when you are", html: swapped, checks: [{ name: "x", passed: true }], sendAt: "2026-11-19T16:00:00.000Z" };
check("a good stored draft may be scheduled before the send", storedDraftProblems(stored, new Date("2026-11-17T12:00:00Z")).length === 0, storedDraftProblems(stored, new Date("2026-11-17T12:00:00Z")));
check("…but not once the send time has passed", storedDraftProblems(stored, new Date("2026-11-19T15:55:00Z")).length === 1);
check("a stored price is refused at approval", storedDraftProblems({ ...stored, chosenSubject: "Plans from $5" }, new Date("2026-11-17T12:00:00Z")).length > 0);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll email campaign checks passed");

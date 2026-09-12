/**
 * Regression checks for the two defects the 2026-09-11 QA audit surfaced, and
 * for the quality gate that replaced the Blog Writer's single prompt call.
 *
 * No network and no database: everything here is pure. Run with `npm test`.
 */
import { resolveInputs, missingRequiredInputs } from "@/lib/agents/inputs";
import { textFrom, jsonFrom } from "@/lib/ai/extract";
import { runQc } from "@/lib/content/qc";
import { buildBrief } from "@/lib/content/brief";
import { getPreset, resolveProfile, NEUTRAL_PROFILE } from "@/lib/content/editorial";
import { isDesignatedForPlatformKey, platformKeyEligibility } from "@/lib/ai/client";
import { normaliseArticle, renderHtml } from "@/lib/content/article";

let failures = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!cond) failures += 1;
};

// 1. The exact production defect: form answers must reach the handler.
const run = {
  input: { topicBrief: "A real brief", targetKeyword: "widgets", wordCount: "900" },
  agentConfig: { agentSlug: "blog-writer", config: { wordCount: 2000, cmsTarget: "WordPress" } },
} as never;
const inputs = resolveInputs(run);
check("run.input beats saved config", inputs.wordCount === 900, inputs.wordCount);
check("saved config fills what the run omitted", inputs.cmsTarget === "WordPress", inputs.cmsTarget);
check("metadata defaults apply", inputs.maxRepairRounds === 2, inputs.maxRepairRounds);
check("booleans coerce from strings", inputs.webResearch === true, inputs.webResearch);

// 2. A blank brief is refused before any spend.
const blank = resolveInputs({ input: {}, agentConfig: { agentSlug: "blog-writer", config: {} } } as never);
check("blank brief is caught", missingRequiredInputs("blog-writer", blank).length === 2, missingRequiredInputs("blog-writer", blank));

// 3. An empty-string form field must not beat a saved default.
const empty = resolveInputs({
  input: { targetKeyword: "   " },
  agentConfig: { agentSlug: "blog-writer", config: { targetKeyword: "saved keyword" } },
} as never);
check("whitespace does not override a saved value", empty.targetKeyword === "saved keyword", empty.targetKeyword);

// 4. The Run 2 bug: text must be read past a thinking block.
const message = {
  content: [
    { type: "thinking", thinking: "…" },
    { type: "text", text: '{"ok":true}' },
  ],
  stop_reason: "end_turn",
} as never;
check("textFrom reads past a thinking block", textFrom(message) === '{"ok":true}', textFrom(message));
check("jsonFrom parses fenced json", jsonFrom<{ ok: boolean }>("```json\n{\"ok\":true}\n```")?.ok === true);

// 5. QC catches what the audit-era handler shipped blind.
const devco = getPreset("devco-house");
const brief = buildBrief(
  { topicBrief: "x", targetKeyword: "widgets", wordCount: 1000, externalLinkCount: 0, webResearch: false },
  null,
  devco,
  "seed",
);
const bad = normaliseArticle({
  title: "Widgets: What You Should Actually Know",
  slug: "widgets",
  meta_description: "Short.",
  intro_blocks: [{ type: "paragraph", runs: [{ text: "Widgets matter. In today's world, 42% of firms use them." }] }],
  sections: [
    { heading: "Understanding Widgets:", blocks: [{ type: "paragraph", runs: [{ text: "Because they are useful." }] }] },
    { heading: "Understanding Costs", blocks: [{ type: "paragraph", runs: [{ text: "Costs vary. They don't." }] }] },
    { heading: "The Bottom Line", blocks: [{ type: "paragraph", runs: [{ text: "There is a gap here." }] }] },
  ],
  links_used: "not an array" as never,
  word_count: 10,
  qc_notes: "",
}, { focusKeyword: "widgets" });

const qc = runQc(bad, brief);
const found = (needle: string) => qc.defects.some((d) => d.toLowerCase().includes(needle));
check("catches a banned word, in the title as much as the body", found("words this profile bans"), qc.defects);
check("catches banned phrasing", found("phrasing this profile bans"));
check("catches an uncited figure", found("uncited figure"));
check("catches heading punctuation", found("ends in punctuation"));
check("catches a banned heading", found("banned by this editorial profile"));
check("catches a heading leaning on its section", found('opens with "because"'));
check("catches the negation flip", found("negation flip"));
check('catches the banned word "gap"', found('"gap"'));
check("catches a short meta description", found("meta description is"));
check("catches an under-length draft", found("below the"));
check("survives links_used arriving as a string", Array.isArray(bad.linksUsed));
check("renders html without a stray h1", !renderHtml(bad).includes("<h1"));

// 6. The editorial profile is the tenant's, not ours. Same article, different rules.
const neutralBrief = buildBrief(
  { topicBrief: "x", targetKeyword: "widgets", wordCount: 1000, externalLinkCount: 0, webResearch: false },
  null,
  NEUTRAL_PROFILE,
  "seed",
);
const neutralQc = runQc(bad, neutralBrief);
check(
  'the DEV.co profile bans "gap" and the neutral one does not',
  qc.defects.some((d) => d.includes('"gap"')) && !neutralQc.defects.some((d) => d.includes('"gap"')),
);
check(
  "em-dashes fail only where the profile forbids them",
  !devco.allowEmDash && NEUTRAL_PROFILE.allowEmDash,
);
check("the neutral default carries none of our house bans", !NEUTRAL_PROFILE.bannedWords.includes("gap"));

// 7. A workspace's overrides layer onto a preset without replacing it.
const customised = resolveProfile("neutral-professional", {
  bannedWords: ["synergy"],
  maxParagraphSentences: 3,
  name: "ignored",
});
check("overrides apply", customised.bannedWords.includes("synergy") && customised.maxParagraphSentences === 3);
check("unoverridden fields are inherited", customised.bannedPhrases.length === NEUTRAL_PROFILE.bannedPhrases.length);
check("an edited profile is marked custom", customised.key === "custom");
check(
  "a junk override is ignored rather than trusted",
  resolveProfile("neutral-professional", { maxParagraphSentences: "lots", nonsense: true }).maxParagraphSentences ===
    NEUTRAL_PROFILE.maxParagraphSentences,
);

// 8. The brief's own delivery requirements are enforced.
const promoBrief = buildBrief(
  {
    topicBrief: "x",
    targetKeyword: "widgets",
    wordCount: 1000,
    externalLinkCount: 0,
    webResearch: false,
    productToFeature: "Widgetron",
    promotionLevel: "Mention only where genuinely relevant",
    requiredDisclaimers: "Results are not guaranteed.",
    keyQuestions: "How much does a widget cost to run?",
    includeFaq: "true",
  },
  null,
  NEUTRAL_PROFILE,
  "seed",
);
const promoArticle = normaliseArticle({
  title: "Widgets",
  slug: "widgets",
  meta_description: "d".repeat(155),
  intro_blocks: [{ type: "paragraph", runs: [{ text: "Widgetron is great. Widgetron helps. Widgetron wins. Widgetron again." }] }],
  sections: [
    { heading: "One", blocks: [{ type: "paragraph", runs: [{ text: "Widgetron is everywhere." }] }] },
    { heading: "Two", blocks: [{ type: "paragraph", runs: [{ text: "A second point stands here." }] }] },
    { heading: "Three", blocks: [{ type: "paragraph", runs: [{ text: "A third point stands here." }] }] },
  ],
  word_count: 40,
  qc_notes: "",
}, { focusKeyword: "widgets" });
const promoQc = runQc(promoArticle, promoBrief);
const promoFound = (needle: string) => promoQc.defects.some((d) => d.toLowerCase().includes(needle));
check("catches over-promotion", promoFound("asks for \"mention only where genuinely relevant\""), promoQc.defects);
check("catches a missing required disclaimer", promoFound("required disclaimer is missing"));
check(
  "flags an unanswered key question as a warning, not a defect",
  promoQc.warnings.some((w) => w.includes("may go unanswered")) && !promoFound("unanswered"),
);
check("catches a missing FAQ", promoFound("asks for an faq"));

// 9. The universal-scope check looks for a place, not for a capital letter.
const geoBrief = buildBrief(
  { topicBrief: "x", targetKeyword: "audit", wordCount: 1000, externalLinkCount: 0, webResearch: false },
  null,
  NEUTRAL_PROFILE,
  "seed",
);
const geoArticle = (heading: string) =>
  normaliseArticle({
    title: "Running an Audit",
    slug: "a",
    meta_description: "d".repeat(155),
    intro_blocks: [{ type: "paragraph", runs: [{ text: "An audit begins with the data you already hold." }] }],
    sections: [
      { heading, blocks: [{ type: "paragraph", runs: [{ text: "A point stands here on its own." }] }] },
      { heading: "Check Ownership Early", blocks: [{ type: "paragraph", runs: [{ text: "Ownership is decided up front." }] }] },
      { heading: "Budget for Cleanup", blocks: [{ type: "paragraph", runs: [{ text: "Cleanup takes longer than planned." }] }] },
    ],
    word_count: 40,
    qc_notes: "",
  }, { focusKeyword: "audit" });

const geoWarns = (heading: string) =>
  runQc(geoArticle(heading), geoBrief).warnings.some((w) => w.includes("scopes the piece to one place"));

check('"in Three Passes" is not a place', !geoWarns("Run the Audit in Three Passes"));
check('"in Practice" is not a place', !geoWarns("What This Looks Like in Practice"));
check('"in Texas" is a place', geoWarns("What Changes in Texas"));
check('"California" is a place', geoWarns("California Rules Are Different"));

// 10. The platform key needs two gates, and the env one is not reachable from data.
process.env.PLATFORM_KEY_WORKSPACES = "ours, another-of-ours, wsid_abc123";
const ws = (slug: string, allowPlatformKey: boolean) => ({ id: `id-${slug}`, slug, allowPlatformKey });

check("designated + toggled on is eligible", platformKeyEligibility(ws("ours", true)).eligible);
check(
  "a stray flag alone grants nothing",
  !platformKeyEligibility(ws("someone-else", true)).eligible,
);
check(
  "and the reason says why",
  (platformKeyEligibility(ws("someone-else", true)) as { reason: string }).reason === "not_designated",
);
check("designated but toggled off is refused", !platformKeyEligibility(ws("ours", false)).eligible);
check("matching is case-insensitive", isDesignatedForPlatformKey(ws("OURS", true)));
check("ids work as well as slugs", isDesignatedForPlatformKey({ id: "wsid_abc123", slug: "unrelated" }));

process.env.PLATFORM_KEY_WORKSPACES = "";
check(
  "an empty allowlist grants nobody, whatever the flag says",
  !platformKeyEligibility(ws("ours", true)).eligible,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

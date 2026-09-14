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
import { buildResearchAsk } from "@/lib/content/research";
import { domainList } from "@/lib/content/domains";
import { isPrivateAddress } from "@/lib/integrations/public-url";
import { payloadPostUrl, rankInternalLinkCandidates } from "@/lib/integrations/payload";
import { getPreset, resolveProfile, NEUTRAL_PROFILE } from "@/lib/content/editorial";
import { isDesignatedForPlatformKey, platformKeyEligibility } from "@/lib/ai/client";
import { normaliseArticle, renderHtml, SUBMIT_ARTICLE_TOOL, submittedFields } from "@/lib/content/article";
import { AGENTS } from "@/lib/agents";
import { AGENT_META } from "@/lib/agent-metadata";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { emailSequenceToSteps, isChannelActivated, parseAudienceEmails } from "@/lib/agent-handlers/email-marketing-channels";
import {
  isRoleEmail,
  filterProspectsForOutreach,
  sequenceStepsFromSubmission,
  coerceSendDay,
  resolveSendWindow,
  activateProspectorInstantlyChannel,
  SUBMIT_OUTREACH_SEQUENCE_TOOL,
} from "@/lib/agent-handlers/prospector-outreach";
import { buildInstantlyCampaignPayload } from "@/lib/integrations/instantly";
import { buildApolloSequencePayload } from "@/lib/integrations/apollo";
import {
  isApolloDataStale,
  planApolloLookups,
  firmographicFitNotes,
  type ApolloLookupCandidate,
} from "@/lib/agent-handlers/outbound-strategist";
import {
  buildOutboundEmailLeadBody,
  activateOutboundEmailDelivery,
  type OutboundEmailDelivery,
} from "@/lib/agent-handlers/outbound-email-delivery";
import {
  buildAimfoxAudienceBody,
  activateOutboundLinkedinDelivery,
  type OutboundLinkedinDelivery,
} from "@/lib/agent-handlers/outbound-linkedin-delivery";
import {
  buildGhlContactBody,
  buildGhlOpportunityBody,
  activateOutboundRevenueDelivery,
  type OutboundRevenueDelivery,
} from "@/lib/agent-handlers/outbound-revenue-delivery";
import { CONNECT_METHODS } from "@/lib/integrations/catalog";
import { SETUP_GUIDES } from "@/lib/integrations/guides";

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

// 9. Free text in the domain fields must never reach web_search's filters.
// Production run cmu1ilt6r000bqhc2gae1232d died in 1s on exactly these inputs:
// the API 400s the whole request on one non-hostname entry.
const prose = buildBrief(
  {
    topicBrief: "AI virtual data rooms",
    preferredSources: "High authority sites like hbr.org etc. ",
    blockedDomains: "intralinks.com, https://www.DealNexus.com/about, other competitors of vdr.ai ",
  },
  null,
  NEUTRAL_PROFILE,
  "seed",
);
const hostOnly = (d: string) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d);
check("a sentence in preferred sources is not an allowlist", prose.preferredSources.length === 0, prose.preferredSources);
check("…it is kept as guidance instead", prose.preferredSourceNotes[0] === "High authority sites like hbr.org etc.", prose.preferredSourceNotes);
check("real blocked domains are normalised to bare hosts", ["intralinks.com", "dealnexus.com"].every((d) => prose.blockedDomains.includes(d)), prose.blockedDomains);
check("every filter entry is a plain hostname", [...prose.preferredSources, ...prose.blockedDomains].every(hostOnly), prose.blockedDomains);
check("a domain named inside prose is NOT blocked (vdr.ai is the client)", !prose.blockedDomains.includes("vdr.ai"), prose.blockedDomains);
check("the prose blocked entry reaches the research ask", buildResearchAsk(prose).includes("other competitors of vdr.ai"));
check("domainList dedupes and drops junk", JSON.stringify(domainList(["a.com", "https://www.a.com/x", "not a domain", "*.b.com"])) === '["a.com"]', domainList(["a.com", "https://www.a.com/x", "not a domain", "*.b.com"]));

// 9b. The article schema must not admit an empty article. Strict mode enforces
// minItems 0/1 and nothing else, so the body nodes carry minItems 1.
{
  const schema = SUBMIT_ARTICLE_TOOL.input_schema as unknown as {
    properties: { intro_blocks: { minItems?: number }; sections: { minItems?: number; items: { properties: { blocks: { minItems?: number } } } } };
    definitions: { paragraph: { minItems?: number }; block: { properties: { items: { minItems?: number } } } };
  };
  check("sections requires at least one", schema.properties.sections.minItems === 1);
  check("a section requires at least one block", schema.properties.sections.items.properties.blocks.minItems === 1);
  check("intro requires at least one block", schema.properties.intro_blocks.minItems === 1);
  check("a paragraph requires at least one run", schema.definitions.paragraph.minItems === 1);
  check("a list requires at least one item", schema.definitions.block.properties.items.minItems === 1);
  const walkBad = (n: unknown): boolean =>
    Array.isArray(n) ? n.some(walkBad) : !!n && typeof n === "object" &&
      (("minItems" in (n as object) && ![0, 1].includes((n as { minItems: number }).minItems)) || ["maxItems", "minLength", "maxLength", "minimum", "maximum"].some((k) => k in (n as object)) || Object.values(n as object).some(walkBad));
  check("no constraint strict mode rejects", !walkBad(SUBMIT_ARTICLE_TOOL.input_schema));
  check("empty-submission diagnostics show block counts", submittedFields({ title: "x", sections: [{ heading: "h", blocks: [] }] }).includes("blocks per section: 0 item(s)"));
}

// 10. A customer-typed site URL must never let the server fetch inward.
for (const ip of ["127.0.0.1", "10.0.0.5", "172.20.1.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
  check(`private address refused: ${ip}`, isPrivateAddress(ip));
}
for (const ip of ["8.8.8.8", "172.32.0.1", "104.16.0.1", "2606:4700::1111"]) {
  check(`public address allowed: ${ip}`, !isPrivateAddress(ip));
}

// 11. Payload internal linking: URL building and candidate ranking, no network.
check(
  "fullPath resolves against the configured site URL",
  payloadPostUrl("https://dev.co", { fullPath: "/chatbots" }) === "https://dev.co/chatbots",
);
check(
  "slug falls back to /blog/<slug> when there is no fullPath",
  payloadPostUrl("https://example.com", { slug: "widgets-101" }) === "https://example.com/blog/widgets-101",
);
check(
  "a trailing slash on the site URL doesn't produce a double slash",
  payloadPostUrl("https://example.com/", { fullPath: "/guide" }) === "https://example.com/guide",
);
check(
  "a post with neither fullPath nor slug has no URL",
  payloadPostUrl("https://example.com", {}) === null,
);

const widgetPost = { id: "1", title: "The Complete Widget Buying Guide", slug: "widget-buying-guide", excerpt: "Everything to know before buying widgets for your shop.", url: "https://example.com/blog/widget-buying-guide" };
const unrelatedPost = { id: "2", title: "Our Company Holiday Party Recap", slug: "holiday-party", excerpt: "Photos from the team's December get-together.", url: "https://example.com/blog/holiday-party" };
const alreadyLinkedPost = { id: "3", title: "Widget Pricing Explained", slug: "widget-pricing", excerpt: "How widget pricing tiers work.", url: "https://example.com/blog/widget-pricing" };
const untitledPost = { id: "4", title: "", slug: "untitled", excerpt: "", url: "https://example.com/blog/untitled" };

const rankBrief = {
  targetKeyword: "widgets",
  secondaryKeywords: ["widget buying guide"],
  topicBrief: "A guide to buying the right widgets for a small shop.",
  workingTitle: "How to Buy Widgets",
};

const ranked = rankInternalLinkCandidates(
  rankBrief,
  [unrelatedPost, widgetPost, alreadyLinkedPost, untitledPost],
  ["https://example.com/blog/widget-pricing"],
  3,
);
check("the relevant post is picked", ranked.some((p) => p.url === widgetPost.url), ranked);
check("an unrelated post is not picked", !ranked.some((p) => p.url === unrelatedPost.url), ranked);
check("a post already in the brief's internal links is excluded", !ranked.some((p) => p.url === alreadyLinkedPost.url), ranked);
check("an untitled post is never a candidate", !ranked.some((p) => p.url === untitledPost.url), ranked);

const manyRelevant = Array.from({ length: 10 }, (_, i) => ({
  id: String(10 + i),
  title: `Widget Guide Part ${i}`,
  slug: `widget-guide-${i}`,
  excerpt: "Widgets, widgets, buying widgets.",
  url: `https://example.com/blog/widget-guide-${i}`,
}));
check(
  "the candidate count is capped at the requested limit",
  rankInternalLinkCandidates(rankBrief, manyRelevant, [], 3).length === 3,
);
check(
  "an empty brief (no keyword signal) yields no candidates rather than a random pick",
  rankInternalLinkCandidates({ targetKeyword: "", secondaryKeywords: [], topicBrief: "", workingTitle: "" }, manyRelevant, []).length === 0,
);

// 12. Fleet-wide guard: a handler's `resolveInputs(run)` result only ever
// carries what lib/agent-metadata.ts declares as that agent's form inputs
// (plus whatever a saved config or another agent's queued run happens to
// pass through — see resolveInputs' own doc comment). If the handler reads
// a config key the form never collects, that value can only ever be the
// metadata default — nothing a person types reaches it. If the form
// collects a key the handler never reads, it's a control with no effect.
// Static and file-local: this greps each handler file's own source for
// `resolveInputs(run)` reads (`config.key`, `config["key"]`, and the
// str/num/bool/lines(config, "key") helpers) and diffs them against that
// agent's declared input keys. It cannot see through a handler that hands
// its config off to a shared builder (Blog Writer passes `inputs` into
// lib/content/brief.ts's buildBrief(), which does the real key-by-key
// reads) — that shows up as a false "every field is unused" positive below,
// which is why blog-writer is in the allowlist with a note rather than "no
// mismatch found".
{
  const HANDLERS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../lib/agent-handlers");
  const INTERNAL_KEYS = new Set(["requireApproval"]); // injected by ConfigureForm's fallback, not declared per-agent

  function extractHandlerKeys(slug: string): Set<string> | null {
    const file = path.join(HANDLERS_DIR, `${slug}.ts`);
    if (!existsSync(file)) return null;
    const src = readFileSync(file, "utf8");
    const bound = src.match(/const\s+(\w+)\s*=\s*resolveInputs\(run\)/);
    if (!bound) return null; // doesn't use resolveInputs at all — nothing to check
    const v = bound[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const keys = new Set<string>();
    for (const m of src.matchAll(new RegExp(`\\b${v}\\.([A-Za-z_][A-Za-z0-9_]*)`, "g"))) keys.add(m[1]);
    for (const m of src.matchAll(new RegExp(`\\b${v}\\[["']([A-Za-z0-9_]+)["']\\]`, "g"))) keys.add(m[1]);
    for (const m of src.matchAll(new RegExp(`\\b(?:str|num|bool|lines)\\(\\s*${v}\\s*,\\s*["']([A-Za-z0-9_]+)["']`, "g"))) keys.add(m[1]);
    return keys;
  }

  // Agents already known to mismatch before this guard existed. Every entry
  // here was ACTIVE with a real handler/form key gap on 2026-09-14 — see the
  // task report for the per-agent breakdown. Not this pass's job to fix;
  // tracked so the guard can still fail on anything NEW instead of asking to
  // silence 44 pre-existing agents on faith. Remove a slug once its agent's
  // handler and metadata are reconciled.
  const KNOWN_MISMATCHES = new Set([
    "ad-creative", "ai-search-visibility", "attribution",
    "blog-writer", // false positive: reads flow through lib/content/brief.ts's buildBrief(), not inline — see doc comment above.
    "captions-clips", "community", "competitor-watch", "content-refresh", "cro-experiments",
    "digital-pr", "email-marketing", // owned by a concurrent edit — do not touch per task instructions.
    "google-ads", "inbox-responder", "internal-linking", "keyword-research", "landing-page-copy",
    "lead-enrichment", "linkedin-ads", "linkedin-engager", "linkedin-poster", "local-seo-gbp",
    "meta-ads", "meta-poster", "newsletter", "on-site-publisher", "onboarder", "operator",
    "outreach", "placement", "podcast", "proposal", "prospector",
    "repurposer", "review-engine", "schema", "short-form", "technical-audit", "topic-planner",
    "video-script", "weekly-report", "x-engager", "x-poster", "youtube",
  ]);

  let scanned = 0;
  for (const agent of AGENTS) {
    const meta = AGENT_META[agent.slug];
    if (!meta) continue;
    const handlerKeys = extractHandlerKeys(agent.slug);
    if (!handlerKeys) continue;
    scanned += 1;
    const metaKeys = new Set(meta.inputs.map((i) => i.key));
    const handlerOnly = [...handlerKeys].filter((k) => !metaKeys.has(k) && !INTERNAL_KEYS.has(k));
    const formOnly = [...metaKeys].filter((k) => !handlerKeys.has(k));
    const clean = handlerOnly.length === 0 && formOnly.length === 0;

    if (agent.status === "ACTIVE" && !KNOWN_MISMATCHES.has(agent.slug)) {
      check(
        `${agent.slug}: handler reads match declared form inputs`,
        clean,
        { handlerOnly, formOnly },
      );
    } else if (!clean) {
      // Informational only — COMING_SOON agents and documented known
      // mismatches are reported but never fail the build.
      console.log(`INFO  ${agent.slug} (${agent.status}) has undeclared/unused config keys — handlerOnly: ${JSON.stringify(handlerOnly)} formOnly: ${JSON.stringify(formOnly)}`);
    }
  }
  check("the fleet-wide guard actually scanned agents", scanned > 40, scanned);
  // The four newly-activated SEO/analytics agents must be genuinely clean,
  // not just absent from KNOWN_MISMATCHES by omission.
  for (const slug of ["rank-tracker", "gsc-analyst", "backlink-monitor", "anomaly-watch"]) {
    check(`${slug} is not on the known-mismatch list`, !KNOWN_MISMATCHES.has(slug));
  }
}

// ---------------------------------------------------------------------------
// Email Marketing's Instantly / Apollo / erp.io CRM channels (2026-09-14).
//
// Only the pure logic — payload shapes and the approval idempotency check —
// is testable without a live key or database; the staging/activation
// functions themselves make real HTTP calls and are exercised manually.
// ---------------------------------------------------------------------------
{
  // emailSequenceToSteps: the generator's vocabulary → {subject, body, delayDays}.
  const sequence = [
    { subjectLine: "Welcome", bodyHtml: "<p>Hi there</p>", sendDelay: "Immediately" },
    { subjectLine: "Follow up", bodyHtml: "<p>Checking in</p>", sendDelay: "Day 3" },
    { subjectLine: "  ", bodyHtml: "   ", sendDelay: "Day 7" }, // blank — must be dropped, not staged empty
  ];
  const steps = emailSequenceToSteps(sequence);
  check("emailSequenceToSteps keeps only steps with a real body", steps.length === 2, steps);
  check("first step defaults to same-day", steps[0]?.delayDays === 0, steps[0]);
  check("'Day 3' parses to 3", steps[1]?.delayDays === 3, steps[1]);
  check("emailSequenceToSteps on garbage input returns []", emailSequenceToSteps("not an array").length === 0);

  const noDelayGiven = emailSequenceToSteps([
    { subjectLine: "A", bodyHtml: "<p>a</p>" },
    { subjectLine: "B", bodyHtml: "<p>b</p>" },
  ]);
  check("a step after the first floors to 1 day when sendDelay is missing", noDelayGiven[1]?.delayDays === 1, noDelayGiven);

  // parseAudienceEmails: the Apollo audience field.
  const emails = parseAudienceEmails("a@x.com\nB@X.com, c@x.com\n\nnot-an-email\n a@x.com ");
  check("parseAudienceEmails splits on newlines and commas", emails.includes("a@x.com") && emails.includes("c@x.com"), emails);
  check("parseAudienceEmails lowercases and dedupes", emails.filter((e) => e === "a@x.com" || e === "b@x.com").length === 2, emails);
  check("parseAudienceEmails drops anything that isn't a plausible email", !emails.includes("not-an-email"), emails);
  check("parseAudienceEmails on empty/undefined input returns []", parseAudienceEmails("").length === 0 && parseAudienceEmails(undefined).length === 0);

  // isChannelActivated: the approval-idempotency guard every activate*() checks first.
  check("a freshly staged channel is not activated", isChannelActivated({ status: "staged" }) === false);
  check("a channel with activatedAt IS activated", isChannelActivated({ status: "activated", activatedAt: new Date().toISOString() }) === true);
  check("null/undefined channel output is not activated", isChannelActivated(null) === false && isChannelActivated(undefined) === false);

  // buildInstantlyCampaignPayload — POST /campaigns body shape.
  const instantlyPayload = buildInstantlyCampaignPayload({
    name: "Q3 Nurture",
    steps: [{ subject: "Hi {{firstName}}", body: "<p>body</p>", delayDays: 0 }],
    sendDayOfWeek: "Tuesday",
  }) as {
    name: string;
    campaign_schedule: { schedules: Array<{ days: Record<string, boolean> }> };
    sequences: Array<{ steps: Array<{ type: string; variants: Array<{ subject: string }> }> }>;
  };
  check("Instantly payload carries the campaign name", instantlyPayload.name === "Q3 Nurture");
  check(
    "a preferred send day narrows the schedule to that single day",
    instantlyPayload.campaign_schedule.schedules[0].days["2"] === true &&
      Object.entries(instantlyPayload.campaign_schedule.schedules[0].days).every(([day, on]) => day === "2" || on === false),
    instantlyPayload.campaign_schedule.schedules[0].days,
  );
  check(
    "every generated step becomes one Instantly email step with the same subject",
    instantlyPayload.sequences[0].steps.length === 1 && instantlyPayload.sequences[0].steps[0].variants[0].subject === "Hi {{firstName}}",
  );
  const instantlyNoDay = buildInstantlyCampaignPayload({ name: "x", steps: [] }) as {
    campaign_schedule: { schedules: Array<{ days: Record<string, boolean> }> };
  };
  check(
    "no preferred day defaults to every weekday, not weekends",
    instantlyNoDay.campaign_schedule.schedules[0].days["1"] === true && instantlyNoDay.campaign_schedule.schedules[0].days["0"] === false,
    instantlyNoDay.campaign_schedule.schedules[0].days,
  );

  // buildApolloSequencePayload — POST /sequences body shape.
  const apolloPayload = buildApolloSequencePayload("Outbound Q3", [
    { subject: "Hi", bodyHtml: "<p>body</p>", waitDays: 2 },
  ]) as { name: string; active: boolean; emailer_steps: Array<{ wait_time: number; emailer_touches: Array<{ emailer_template: { subject: string; body_html: string } }> }> };
  check("Apollo sequence is staged inactive — never auto-launches contacts into a send", apolloPayload.active === false, apolloPayload.active);
  check("Apollo step carries the generated subject/body", apolloPayload.emailer_steps[0].emailer_touches[0].emailer_template.subject === "Hi");
  check("Apollo step's wait_time matches the generated delay", apolloPayload.emailer_steps[0].wait_time === 2);

  // email-marketing's own metadata lists all five delivery platforms (this agent is exempted
  // from the fleet-wide handler/metadata guard above, so it needs its own direct check).
  const platformInput = AGENT_META["email-marketing"].inputs.find((i) => i.key === "platform");
  check(
    "Email Marketing's platform select offers all five channels",
    ["Mailchimp", "Klaviyo", "Instantly", "Apollo", "erp.io CRM"].every((p) => platformInput?.options?.includes(p)),
    platformInput?.options,
  );
  check(
    "Email Marketing declares senderAccountId (Apollo's required sender mailbox)",
    AGENT_META["email-marketing"].inputs.some((i) => i.key === "senderAccountId"),
  );
}

// ---------------------------------------------------------------------------
// Prospector's Outreach via Instantly step (2026-09-14).
//
// Same split as Email Marketing above: only the pure logic — lead
// filtering/dedupe/cap, the tool-call schema, and the approval hook's
// idempotency — is testable without a live key; stageProspectorInstantlyCampaign
// and the network half of activateProspectorInstantlyChannel make real HTTP
// calls and are exercised manually.
// ---------------------------------------------------------------------------
{
  // isRoleEmail — the always-skip list.
  check("isRoleEmail flags info@", isRoleEmail("info@example.com"));
  check("isRoleEmail flags noreply@", isRoleEmail("noreply@example.com"));
  check("isRoleEmail flags NoReply@ case-insensitively", isRoleEmail("NoReply@Example.com"));
  check("isRoleEmail does not flag a named contact", !isRoleEmail("jane.doe@example.com"));

  // filterProspectsForOutreach — the whole staging decision, in one pure function.
  const prospects = [
    { domain: "good.com", pageUrl: "https://good.com/resources", contactEmail: "Jane@Good.com", contactName: "Jane Doe", linkPlacementOpportunity: "cite our guide" },
    { domain: "role.com", contactEmail: "info@role.com" }, // role address — always skipped
    { domain: "bad.com", contactEmail: "not-an-email" }, // malformed
    { domain: "none.com" }, // no email at all
    { domain: "dupe.com", contactEmail: "jane@good.com" }, // duplicate of the first, case-insensitive
  ];
  const { leads, skipped } = filterProspectsForOutreach(prospects, 100);
  check("filterProspectsForOutreach keeps exactly the one real, named-contact lead", leads.length === 1, leads);
  check("the kept lead's email is lowercased", leads[0]?.email === "jane@good.com", leads[0]);
  check("the kept lead's first name comes from contactName", leads[0]?.firstName === "Jane", leads[0]);
  check("the kept lead's targetPage custom variable is the prospect's pageUrl", leads[0]?.customVariables.targetPage === "https://good.com/resources", leads[0]);
  check("the kept lead's reason custom variable comes from linkPlacementOpportunity", leads[0]?.customVariables.reason === "cite our guide", leads[0]);
  check("filterProspectsForOutreach skips the other four with reasons, not silently", skipped.length === 4, skipped);
  check("role address is skipped with a role-specific reason", skipped.some((s) => s.email === "info@role.com" && /role|generic/i.test(s.reason)), skipped);
  check("malformed email is skipped", skipped.some((s) => s.domain === "bad.com" && /malformed/i.test(s.reason)), skipped);
  check("no-email prospect is skipped", skipped.some((s) => s.domain === "none.com" && /no contact email/i.test(s.reason)), skipped);
  check("case-insensitive duplicate is skipped, not double-counted", skipped.some((s) => s.domain === "dupe.com" && /duplicate/i.test(s.reason)), skipped);
  check("filterProspectsForOutreach on garbage input returns no leads and no skips", filterProspectsForOutreach("not an array").leads.length === 0);

  // The cap: with 3 eligible prospects and a cap of 2, only 2 become leads.
  const manyProspects = [
    { domain: "a.com", contactEmail: "a@a.com" },
    { domain: "b.com", contactEmail: "b@b.com" },
    { domain: "c.com", contactEmail: "c@c.com" },
  ];
  const capped = filterProspectsForOutreach(manyProspects, 2);
  check("the lead cap is enforced", capped.leads.length === 2, capped.leads);
  check("the prospect over the cap is skipped with a cap-specific reason", capped.skipped.some((s) => /cap/i.test(s.reason)), capped.skipped);

  // sequenceStepsFromSubmission — the tool call's raw input, normalised.
  const submitted = sequenceStepsFromSubmission([
    { subject: " Hi {{firstName}} ", body: " body one " },
    { subject: "  ", body: "blank subject — must be dropped" },
    { subject: "Follow up", body: "  " }, // blank body — must be dropped
  ]);
  check("sequenceStepsFromSubmission keeps only steps with both a subject and a body", submitted.length === 1, submitted);
  check("sequenceStepsFromSubmission trims whitespace", submitted[0]?.subject === "Hi {{firstName}}" && submitted[0]?.body === "body one", submitted[0]);
  check("sequenceStepsFromSubmission on undefined returns []", sequenceStepsFromSubmission(undefined).length === 0);

  // The strict tool schema itself — every nested object must refuse unknown keys once strictSchema
  // has walked it, or the live call 400s.
  const seqSchema = SUBMIT_OUTREACH_SEQUENCE_TOOL.input_schema as { additionalProperties?: boolean; properties: { steps: { items: { additionalProperties?: boolean } } } };
  check("submit_outreach_sequence's top-level schema refuses unknown keys", seqSchema.additionalProperties === false);
  check("submit_outreach_sequence's step schema refuses unknown keys", seqSchema.properties.steps.items.additionalProperties === false);
  check("submit_outreach_sequence is marked strict", SUBMIT_OUTREACH_SEQUENCE_TOOL.strict === true);

  // coerceSendDay / resolveSendWindow — the Preferred Send Day and Send Window selects.
  check("coerceSendDay accepts a real weekday", coerceSendDay("Tuesday") === "Tuesday");
  check("coerceSendDay rejects the placeholder option", coerceSendDay("Any weekday (default)") === undefined);
  check("coerceSendDay rejects garbage", coerceSendDay("Someday") === undefined);
  check("resolveSendWindow maps a known label", JSON.stringify(resolveSendWindow("8am–6pm")) === JSON.stringify({ from: "08:00", to: "18:00" }));
  check("resolveSendWindow falls back to the default window for an unknown label", JSON.stringify(resolveSendWindow("nonsense")) === JSON.stringify({ from: "09:00", to: "17:00" }));

  // Approval hook idempotency: an already-activated channel must short-circuit before making any
  // network call — the same guarantee isChannelActivated gives Email Marketing's channels above.
  const alreadyActivated = {
    campaignId: "camp_123",
    status: "activated" as const,
    leadCount: 1,
    addedLeads: [],
    skipped: [],
    sendingAccounts: [],
    sequence: [],
    activatedAt: "2026-09-14T00:00:00.000Z",
  };
  check("an already-staged (not activated) channel is not activated", isChannelActivated({ ...alreadyActivated, status: "staged", activatedAt: undefined }) === false);
  check("a channel with activatedAt IS activated", isChannelActivated(alreadyActivated) === true);
  const reactivated = await activateProspectorInstantlyChannel("fake-key-never-used", alreadyActivated);
  check(
    "activateProspectorInstantlyChannel no-ops (and never calls Instantly) once activatedAt is set",
    reactivated === alreadyActivated,
    reactivated,
  );
}

// ---------------------------------------------------------------------------
// Outbound Email / LinkedIn / Revenue approve-to-send gating (2026-09-14).
//
// Owner decision: these three agents STAGE their work and only EXECUTE the live Instantly/
// Aimfox/GoHighLevel write once a workspace admin approves the run — same model as Email
// Marketing and Prospector above. Only the pure body-builders and the injectable activate*
// functions are testable without a live key/database; the handlers themselves (Claude calls,
// Prisma reads, read-only campaign/pipeline lookups) are exercised manually. The
// activate*Delivery tests below are the "re-running after a partial success skips completed
// items" and "staging never calls the network" checks: every network call is injected, so a
// completed delivery is provably never re-sent.
// ---------------------------------------------------------------------------
{
  // --- Outbound Email / Instantly -------------------------------------------------------

  const emailDelivery: OutboundEmailDelivery = {
    status: "staged",
    prospectId: "prospect_1",
    firstName: "Jane",
    company: "Acme",
    email: "jane@acme.com",
    campaignName: "DEV-01-SAAS-V1",
    campaignId: "camp_abc",
    connected: true,
    personalization: { pain_signal: "hiring freeze", trigger: "new CTO", offer_angle: "", company_context: "", proof_point: "" },
  };
  const leadBody = buildOutboundEmailLeadBody(emailDelivery);
  check("outbound email lead body targets the resolved campaign id", leadBody.campaign === "camp_abc", leadBody);
  check(
    "outbound email lead body sets skip_if_in_campaign so a duplicate approval can't double-enrol",
    leadBody.skip_if_in_campaign === true,
    leadBody,
  );
  check("outbound email lead body carries every personalisation variable", leadBody.custom_variables === emailDelivery.personalization, leadBody);

  // Idempotency: an already-activated delivery must short-circuit before calling addLead at all.
  let emailAddCallsOnActivated = 0;
  const activatedEmail: OutboundEmailDelivery = { ...emailDelivery, status: "activated", activatedAt: "2026-09-14T00:00:00.000Z", instantlyLeadId: "lead_1" };
  const emailReturned = await activateOutboundEmailDelivery(activatedEmail, {
    apiKey: "fake",
    addLead: async () => { emailAddCallsOnActivated++; return { id: "should-not-happen" }; },
  });
  check(
    "activateOutboundEmailDelivery skips an already-activated delivery — no network call (re-approval can't double-add)",
    emailAddCallsOnActivated === 0 && emailReturned === activatedEmail,
    emailReturned,
  );

  // A staged delivery calls addLead exactly once and records the result.
  let addLeadCallCount = 0;
  const firstEmailActivation = await activateOutboundEmailDelivery(emailDelivery, {
    apiKey: "fake",
    addLead: async () => { addLeadCallCount++; return { id: "lead_new" }; },
  });
  check("activateOutboundEmailDelivery calls addLead exactly once for a staged delivery", addLeadCallCount === 1, addLeadCallCount);
  check(
    "activateOutboundEmailDelivery records the returned lead id and flips to activated",
    firstEmailActivation.status === "activated" && firstEmailActivation.instantlyLeadId === "lead_new",
    firstEmailActivation,
  );

  // No Instantly integration connected → simulate, still no network call.
  let simEmailCalls = 0;
  const simulatedEmail = await activateOutboundEmailDelivery(
    { ...emailDelivery, connected: false },
    { addLead: async () => { simEmailCalls++; return { id: "x" }; } },
  );
  check(
    "activateOutboundEmailDelivery simulates (no network call) when Instantly isn't connected",
    simEmailCalls === 0 && simulatedEmail.source === "simulation" && simulatedEmail.status === "activated",
    simulatedEmail,
  );

  // --- Outbound LinkedIn / Aimfox --------------------------------------------------------

  const liDelivery: OutboundLinkedinDelivery = {
    status: "staged",
    prospectId: "prospect_2",
    firstName: "Sam",
    company: "Beta Co",
    linkedInUrl: "https://linkedin.com/in/sam",
    campaignName: "DEV-01-LI-V1",
    campaignId: "li_camp_1",
    connected: true,
    connectionNote: "note",
    message1: "m1",
    message2: "m2",
  };
  const audienceBody = buildAimfoxAudienceBody(liDelivery);
  check("Aimfox audience body targets the resolved campaign id", audienceBody.campaign_id === "li_camp_1", audienceBody);
  check("Aimfox audience body carries the LinkedIn URL", audienceBody.profile_url === "https://linkedin.com/in/sam", audienceBody);

  let liAddCallsOnActivated = 0;
  const activatedLi: OutboundLinkedinDelivery = { ...liDelivery, status: "activated", activatedAt: "2026-09-14T00:00:00.000Z", aimfoxLeadId: "li_lead_1" };
  const liReturned = await activateOutboundLinkedinDelivery(activatedLi, {
    apiKey: "fake",
    addProfile: async () => { liAddCallsOnActivated++; return {}; },
  });
  check(
    "activateOutboundLinkedinDelivery skips an already-activated delivery — no network call (re-approval can't double-add)",
    liAddCallsOnActivated === 0 && liReturned === activatedLi,
    liReturned,
  );

  let liFirstCalls = 0;
  const liFirstActivation = await activateOutboundLinkedinDelivery(liDelivery, {
    apiKey: "fake",
    addProfile: async () => { liFirstCalls++; return { id: "li_lead_new" }; },
  });
  check("activateOutboundLinkedinDelivery calls addProfile exactly once for a staged delivery", liFirstCalls === 1, liFirstCalls);
  check(
    "activateOutboundLinkedinDelivery records the returned lead id and flips to activated",
    liFirstActivation.aimfoxLeadId === "li_lead_new" && liFirstActivation.status === "activated",
    liFirstActivation,
  );

  let simLiCalls = 0;
  const simulatedLi = await activateOutboundLinkedinDelivery(
    { ...liDelivery, connected: false },
    { addProfile: async () => { simLiCalls++; return {}; } },
  );
  check(
    "activateOutboundLinkedinDelivery simulates (no network call) when Aimfox isn't connected",
    simLiCalls === 0 && simulatedLi.source === "simulation" && simulatedLi.status === "activated",
    simulatedLi,
  );

  // --- Outbound Revenue / GoHighLevel -----------------------------------------------------

  const revDelivery: OutboundRevenueDelivery = {
    status: "staged",
    prospectId: "prospect_3",
    event: "meeting_booked",
    connected: true,
    locationId: "loc_1",
    contact: { firstName: "Sam", lastName: "Lee", email: "sam@beta.com", companyName: "Beta Co", tags: ["outbound"] },
    wantsOpportunity: true,
    opportunity: { name: "Dev.co — Beta Co", source: "Outbound — meeting_booked" },
    pipelineId: "pipe_1",
    pipelineStageId: "stage_1",
    ghlOpportunityId: null,
  };
  const contactBody = buildGhlContactBody(revDelivery);
  check("GHL contact body carries the locationId and email", contactBody.locationId === "loc_1" && contactBody.email === "sam@beta.com", contactBody);
  const oppBody = buildGhlOpportunityBody(revDelivery, "contact_1");
  check("GHL opportunity body targets the resolved pipeline/stage", oppBody.pipelineId === "pipe_1" && oppBody.pipelineStageId === "stage_1", oppBody);
  check("GHL opportunity body carries the resolved contact id", oppBody.contactId === "contact_1", oppBody);

  // Contact upsert always runs (idempotent on GHL's side); opportunity creation is skipped, and
  // the existing id reused, when one already exists for this prospect — this is the guard
  // against GHL's non-idempotent create-opportunity call firing twice on a re-approval or a
  // second webhook for the same prospect.
  let contactCallsExisting = 0;
  let oppCallsExisting = 0;
  const withExistingOpp = await activateOutboundRevenueDelivery(revDelivery, "existing_opp_1", {
    apiKey: "fake",
    locationId: "loc_1",
    upsertContact: async () => { contactCallsExisting++; return "contact_new"; },
    createOpportunity: async () => { oppCallsExisting++; return "should-not-happen"; },
  });
  check("activateOutboundRevenueDelivery still upserts the contact (idempotent on GHL's side)", contactCallsExisting === 1, contactCallsExisting);
  check(
    "activateOutboundRevenueDelivery does NOT create a second opportunity when one already exists",
    oppCallsExisting === 0,
    oppCallsExisting,
  );
  check("activateOutboundRevenueDelivery reuses the existing opportunity id instead", withExistingOpp.ghlOpportunityId === "existing_opp_1", withExistingOpp);

  let oppCallsNew = 0;
  const withNoExistingOpp = await activateOutboundRevenueDelivery(revDelivery, null, {
    apiKey: "fake",
    locationId: "loc_1",
    upsertContact: async () => "contact_new",
    createOpportunity: async () => { oppCallsNew++; return "opp_new"; },
  });
  check(
    "activateOutboundRevenueDelivery creates an opportunity when none exists yet",
    oppCallsNew === 1 && withNoExistingOpp.ghlOpportunityId === "opp_new",
    withNoExistingOpp,
  );

  // Already-activated deliveries short-circuit entirely — no contact or opportunity call, even
  // if an (incorrect) existingOpportunityId is passed in.
  let contactCallsActivated = 0;
  let oppCallsActivated = 0;
  const activatedRev: OutboundRevenueDelivery = {
    ...revDelivery,
    status: "activated",
    activatedAt: "2026-09-14T00:00:00.000Z",
    ghlContactId: "contact_x",
    ghlOpportunityId: "opp_x",
  };
  const revReturned = await activateOutboundRevenueDelivery(activatedRev, "opp_x", {
    apiKey: "fake",
    locationId: "loc_1",
    upsertContact: async () => { contactCallsActivated++; return "x"; },
    createOpportunity: async () => { oppCallsActivated++; return "x"; },
  });
  check(
    "activateOutboundRevenueDelivery skips an already-activated delivery entirely — no contact or opportunity call",
    contactCallsActivated === 0 && oppCallsActivated === 0 && revReturned === activatedRev,
    revReturned,
  );

  // No GoHighLevel integration connected → simulate, no network calls.
  let simGhlCalls = 0;
  const simulatedRev = await activateOutboundRevenueDelivery({ ...revDelivery, connected: false }, null, {
    upsertContact: async () => { simGhlCalls++; return "x"; },
  });
  check(
    "activateOutboundRevenueDelivery simulates (no network call) when GoHighLevel isn't connected",
    simGhlCalls === 0 && simulatedRev.source === "simulation" && simulatedRev.status === "activated",
    simulatedRev,
  );

  // --- No escape hatch: sending is never optional for these three, unlike e.g. Outbound Scout ---
  for (const slug of ["outbound-email", "outbound-linkedin", "outbound-revenue"]) {
    const meta = AGENT_META[slug];
    check(
      `${slug} declares no requireApproval input — approval is mandatory, not a config toggle`,
      !meta.inputs.some((i) => i.key === "requireApproval"),
      meta.inputs,
    );
  }
}

// ---------------------------------------------------------------------------
// Every CONNECT_METHODS provider needs a customer-facing setup guide
// (lib/integrations/guides — merges oauth-cms.ts and keys.ts) with real
// content, so a new integration can't ship a Connect button with nothing
// behind it. Fails loudly and names the gap rather than skipping it, since
// this is exactly the kind of thing that's easy to forget when adding a
// provider to catalog.ts.
// ---------------------------------------------------------------------------
{
  const providers = Object.keys(CONNECT_METHODS);
  const missing = providers.filter((p) => !SETUP_GUIDES[p]);
  check(
    `every CONNECT_METHODS provider has a setup guide (missing: ${missing.length ? missing.join(", ") : "none"})`,
    missing.length === 0,
    missing,
  );

  for (const provider of providers) {
    const guide = SETUP_GUIDES[provider];
    if (!guide) continue; // already reported as missing above
    check(`${provider} guide has at least 3 steps`, guide.steps.length >= 3, guide.steps.length);
    check(
      `${provider} guide has at least 2 troubleshooting entries`,
      guide.troubleshooting.length >= 2,
      guide.troubleshooting.length,
    );
    check(`${provider} guide has a privacy note`, typeof guide.privacy === "string" && guide.privacy.trim().length > 0);
    check(`${provider} guide has at least 1 docs URL`, guide.docs.length >= 1, guide.docs);
    check(`${provider} guide's provider field matches its CONNECT_METHODS key`, guide.provider === provider, guide.provider);
  }

  const allDocUrls = providers.flatMap((p) => SETUP_GUIDES[p]?.docs.map((d) => d.url) ?? []);
  const nonHttps = allDocUrls.filter((u) => !u.startsWith("https://"));
  check("every setup guide docs URL is https", nonHttps.length === 0, nonHttps);
}

// ---------------------------------------------------------------------------
// Outbound Strategist's Apollo enrichment planning — pure: freshness window,
// per-domain dedupe, per-run cap, and the "not connected" short-circuit that
// must never produce a fetch plan (see lib/agent-handlers/outbound-strategist.ts).
// ---------------------------------------------------------------------------
{
  const NOW = new Date("2026-09-14T12:00:00.000Z");
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

  check("isApolloDataStale: missing fetchedAt is stale", isApolloDataStale(undefined, 30, NOW) === true);
  check("isApolloDataStale: null fetchedAt is stale", isApolloDataStale(null, 30, NOW) === true);
  check("isApolloDataStale: unparseable fetchedAt is stale", isApolloDataStale("not-a-date", 30, NOW) === true);
  check("isApolloDataStale: 10 days old within a 30-day window is fresh", isApolloDataStale(daysAgo(10), 30, NOW) === false);
  check("isApolloDataStale: 31 days old outside a 30-day window is stale", isApolloDataStale(daysAgo(31), 30, NOW) === true);
  check("isApolloDataStale: exactly the window boundary is not yet stale", isApolloDataStale(daysAgo(30), 30, NOW) === false);

  // Not connected: every candidate is skipped, and nothing is ever queued to fetch — this is the
  // guarantee that a disconnected workspace never calls Apollo, live or otherwise.
  const disconnectedCandidates: ApolloLookupCandidate[] = [
    { email: "a@acme.com", domain: "acme.com" },
    { email: "b@other.com", domain: "other.com" },
  ];
  const disconnectedPlan = planApolloLookups(disconnectedCandidates, { connected: false, freshnessDays: 30, maxLookups: 25, now: NOW });
  check("not connected: no domains queued", disconnectedPlan.domainsToFetch.length === 0, disconnectedPlan);
  check("not connected: no emails queued", disconnectedPlan.emailsToFetch.length === 0, disconnectedPlan);
  check(
    "not connected: every candidate is skipped with reason not_connected",
    disconnectedPlan.skipped.every((s) => s.reason === "not_connected") && disconnectedPlan.skipped.length === 2,
    disconnectedPlan.skipped,
  );

  // Dedupe: two prospects at the same domain only queue that domain once.
  const sameDomainCandidates: ApolloLookupCandidate[] = [
    { email: "a@acme.com", domain: "acme.com" },
    { email: "b@acme.com", domain: "acme.com" },
    { email: "c@other.com", domain: "other.com" },
  ];
  const dedupePlan = planApolloLookups(sameDomainCandidates, { connected: true, freshnessDays: 30, maxLookups: 25, now: NOW });
  check("dedupe: acme.com queued exactly once despite two prospects", dedupePlan.domainsToFetch.filter((d) => d === "acme.com").length === 1, dedupePlan);
  check("dedupe: both distinct domains are present", dedupePlan.domainsToFetch.includes("acme.com") && dedupePlan.domainsToFetch.includes("other.com"), dedupePlan);
  check("dedupe: every candidate's email is still queued for person enrichment", dedupePlan.emailsToFetch.length === 3, dedupePlan);

  // Freshness: a candidate with recent org+person data needs neither call.
  const freshCandidates: ApolloLookupCandidate[] = [
    { email: "fresh@acme.com", domain: "acme.com", orgFetchedAt: daysAgo(5), personFetchedAt: daysAgo(5) },
    { email: "stale@other.com", domain: "other.com", orgFetchedAt: daysAgo(90), personFetchedAt: daysAgo(90) },
  ];
  const freshnessPlan = planApolloLookups(freshCandidates, { connected: true, freshnessDays: 30, maxLookups: 25, now: NOW });
  check("freshness: a recently-fetched domain is not re-queued", !freshnessPlan.domainsToFetch.includes("acme.com"), freshnessPlan);
  check("freshness: a recently-fetched email is not re-queued", !freshnessPlan.emailsToFetch.includes("fresh@acme.com"), freshnessPlan);
  check("freshness: the fresh candidate is reported skipped as fresh", freshnessPlan.skipped.some((s) => s.email === "fresh@acme.com" && s.reason === "fresh"), freshnessPlan.skipped);
  check("freshness: a stale domain and email are both queued", freshnessPlan.domainsToFetch.includes("other.com") && freshnessPlan.emailsToFetch.includes("stale@other.com"), freshnessPlan);

  // Cap: 3 candidates each needing an org+person lookup (6 calls' worth of demand) capped at 2
  // total calls — only the first candidate's org lookup fits the budget.
  const capCandidates: ApolloLookupCandidate[] = [
    { email: "a@one.com", domain: "one.com" },
    { email: "b@two.com", domain: "two.com" },
    { email: "c@three.com", domain: "three.com" },
  ];
  const capPlan = planApolloLookups(capCandidates, { connected: true, freshnessDays: 30, maxLookups: 2, now: NOW });
  check("cap: total queued calls never exceed maxLookups", capPlan.domainsToFetch.length + capPlan.emailsToFetch.length <= 2, capPlan);
  check("cap: at least one candidate is skipped for the cap once budget runs out", capPlan.skipped.some((s) => s.reason === "cap_reached"), capPlan.skipped);

  // Cap of 0: connected, but no budget — behaves like nothing is queued (though skip reason is
  // cap_reached, not not_connected, since Apollo IS connected here).
  const zeroBudgetPlan = planApolloLookups(capCandidates, { connected: true, freshnessDays: 30, maxLookups: 0, now: NOW });
  check("cap of 0: nothing is queued", zeroBudgetPlan.domainsToFetch.length === 0 && zeroBudgetPlan.emailsToFetch.length === 0, zeroBudgetPlan);
  check("cap of 0: every candidate is reported cap_reached, not not_connected", zeroBudgetPlan.skipped.every((s) => s.reason === "cap_reached"), zeroBudgetPlan.skipped);

  // ICP-fit mapping: firmographicFitNotes turns Apollo org data into scoring-prompt notes without
  // ever inventing a figure Apollo didn't return.
  check("firmographicFitNotes: no org data yields a single no-data note", firmographicFitNotes("DEV-01", null).length === 1 && /no apollo firmographic data/i.test(firmographicFitNotes("DEV-01", null)[0] ?? ""));
  const withinBand = firmographicFitNotes("DEV-01", { employeeCount: 120, industry: "Software" });
  check("firmographicFitNotes: employee count within DEV-01's 50-500 band is noted as within band", withinBand.some((n) => /within this play/i.test(n)), withinBand);
  const belowBand = firmographicFitNotes("DEV-01", { employeeCount: 5, industry: null });
  check("firmographicFitNotes: employee count below DEV-01's band is noted as below", belowBand.some((n) => /below this play/i.test(n)), belowBand);
  const aboveBandDev03 = firmographicFitNotes("DEV-03", { employeeCount: 5000, industry: null });
  check("firmographicFitNotes: DEV-03 uses its own 100-2000 band, not DEV-01's", aboveBandDev03.some((n) => /above this play.*100-2000/i.test(n)), aboveBandDev03);
  const unknownPlay = firmographicFitNotes("NOT-A-PLAY", { employeeCount: 120, industry: null });
  check("firmographicFitNotes: an unrecognised play slug falls back to DEV-01's band", unknownPlay.some((n) => /50-500/.test(n)), unknownPlay);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

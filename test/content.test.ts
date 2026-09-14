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
import { normaliseArticle, renderHtml, replaceImageSrc, SUBMIT_ARTICLE_TOOL, submittedFields } from "@/lib/content/article";
import { lengthBand } from "@/lib/content/brief";
import { underLength } from "@/lib/content/draft";
import { isBetterDraft } from "@/lib/content/pipeline";
import { AGENTS } from "@/lib/agents";
import { AGENT_META } from "@/lib/agent-metadata";
import { readFileSync, existsSync, readdirSync } from "node:fs";
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
  parsePlayConfig,
  buildApolloPeopleSearchFilters,
  matchesExclusion,
  firmographicBandFromIcp,
  routeByScore,
  planCampaignResolution,
  selectPeopleToReveal,
  dedupeNewProspects,
} from "@/lib/agent-handlers/outbound-play-config";
import { planScoutChaining, planStrategistChaining } from "@/lib/agent-handlers/outbound-chain-plan";
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
import {
  computeScheduledTimes,
  validateSocialAccount,
  postsStillToCreate,
} from "@/lib/agent-handlers/social-poster-shared";
import { publishMetaBatch, isMetaBatchSettled, type MetaStagedPost } from "@/lib/agent-handlers/meta-poster-delivery";
import {
  enforceDailyCap,
  isActionExecuted,
  buildConnectionNoteBody,
  buildMessageBody,
  executeLinkedinEngagerBatch,
  summarizeBatch,
  type EngagementAction,
  type LinkedinEngagerDelivery,
} from "@/lib/agent-handlers/linkedin-engager-delivery";
import { AimfoxApiError } from "@/lib/integrations/aimfox";
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
    "lead-enrichment", "linkedin-ads", "local-seo-gbp",
    "meta-ads", "newsletter", "on-site-publisher", "onboarder", "operator",
    "outreach", "placement", "podcast", "proposal", "prospector",
    "repurposer", "review-engine", "schema", "short-form", "technical-audit", "topic-planner",
    "video-script", "weekly-report", "x-engager", "youtube",
    // linkedin-poster, x-poster, meta-poster: reconciled 2026-09-14 (Social module rebuild) — see
    // the "no requireApproval escape hatch" check below and social-poster-shared.test coverage.
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
    campaignName: "ACME-SAAS-V1",
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
    campaignName: "ACME-LI-V1",
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

  // --- No escape hatch: sending is never optional for these, unlike e.g. Outbound Scout ---
  for (const slug of [
    "outbound-email",
    "outbound-linkedin",
    "outbound-revenue",
    "linkedin-engager",
    "linkedin-poster",
    "x-poster",
    "meta-poster",
  ]) {
    const meta = AGENT_META[slug];
    check(
      `${slug} declares no requireApproval input — approval is mandatory, not a config toggle`,
      !meta.inputs.some((i) => i.key === "requireApproval"),
      meta.inputs,
    );
  }
}

// ---------------------------------------------------------------------------
// LinkedIn Engager / Aimfox (2026-09-14). Only the pure staging/execution logic is testable
// without a live key or database — see lib/agent-handlers/linkedin-engager-delivery.ts's module
// docstring for why executeLinkedinEngagerBatch never throws and always returns the accumulated
// state instead.
// ---------------------------------------------------------------------------
{
  const connectionAction: EngagementAction = {
    id: "a1",
    type: "connectionNote",
    targetName: "Jane Doe",
    targetProfileUrl: "https://linkedin.com/in/janedoe",
    text: "Loved your take on X — would love to connect.",
    status: "pending",
  };
  const messageAction: EngagementAction = {
    id: "a2",
    type: "message",
    targetName: "John Smith",
    targetProfileUrl: "https://linkedin.com/in/johnsmith",
    text: "Following up on your post about Y — curious how that turned out?",
    status: "pending",
  };
  const commentAction: EngagementAction = {
    id: "a3",
    type: "comment",
    targetName: "https://linkedin.com/posts/123",
    targetPostUrl: "https://linkedin.com/posts/123",
    text: "Strong point on Z — worth adding that...",
    status: "manual",
  };

  // enforceDailyCap: only automatable (connectionNote/message) actions compete for the cap;
  // comment actions are never sent automatically, so they're never trimmed by it.
  const overCap = [connectionAction, messageAction, { ...connectionAction, id: "a4" }, commentAction];
  const capped = enforceDailyCap(overCap, 2);
  check("enforceDailyCap keeps at most `cap` automatable actions", capped.filter((a) => a.type !== "comment").length === 2, capped);
  check("enforceDailyCap never drops a comment action", capped.some((a) => a.id === "a3"), capped);
  check("enforceDailyCap keeps automatable actions in their original order", capped[0]?.id === "a1" && capped[1]?.id === "a2", capped);

  // isActionExecuted: pending is the only status a later pass will still touch.
  check("a pending action is not executed", isActionExecuted(connectionAction) === false);
  check("an executed action IS executed", isActionExecuted({ ...connectionAction, status: "executed" }) === true);
  check("a manual (comment) action counts as settled — never picked up by the executor", isActionExecuted(commentAction) === true);
  check("a failed action counts as settled — not retried blindly on a later pass", isActionExecuted({ ...connectionAction, status: "failed" }) === true);

  // Pure body builders.
  const connBody = buildConnectionNoteBody(connectionAction, "camp_1");
  check("connection note body targets the resolved campaign id", connBody.campaign_id === "camp_1", connBody);
  check("connection note body carries the profile URL", connBody.profile_url === "https://linkedin.com/in/janedoe", connBody);
  const msgBody = buildMessageBody(messageAction);
  check("message body (no conversationUrn) carries the profile URL to start a new thread", msgBody.profile_url === "https://linkedin.com/in/johnsmith", msgBody);
  const replyBody = buildMessageBody({ ...messageAction, conversationUrn: "urn:conv:1" });
  check("message body (with conversationUrn) omits profile_url — it's replying into an existing thread", replyBody.profile_url === undefined, replyBody);

  const baseDelivery: LinkedinEngagerDelivery = {
    connected: true,
    accountId: "acct_1",
    campaignName: "LinkedIn Engager - Connections",
    campaignId: "camp_1",
    actions: [connectionAction, messageAction, commentAction],
    dailyCap: 15,
  };

  // Not connected → every automatable action simulates, comment stays untouched, no network call.
  let simCalls = 0;
  const simulated = await executeLinkedinEngagerBatch(
    { ...baseDelivery, connected: false },
    { addAudience: async () => { simCalls++; return {}; } },
  );
  check("executeLinkedinEngagerBatch simulates (no network call) when Aimfox isn't connected", simCalls === 0, simCalls);
  check(
    "simulated actions are marked executed with a synthetic id",
    simulated.actions.filter((a) => a.type !== "comment").every((a) => a.status === "executed" && a.source === "simulation"),
    simulated.actions,
  );
  check("the comment action is left exactly as staged — manual, never touched", simulated.actions.find((a) => a.id === "a3")?.status === "manual");

  // Connected: each pending automatable action gets exactly one call, routed by type.
  let addCalls = 0;
  let sendCalls = 0;
  const executed = await executeLinkedinEngagerBatch(baseDelivery, {
    apiKey: "fake",
    addAudience: async () => { addCalls++; return { id: "aimfox_conn_1" }; },
    startConversation: async () => { sendCalls++; return { id: "aimfox_msg_1" }; },
  });
  check("executeLinkedinEngagerBatch calls addAudience exactly once for the connectionNote action", addCalls === 1, addCalls);
  check("executeLinkedinEngagerBatch calls startConversation exactly once for the message action (no conversationUrn)", sendCalls === 1, sendCalls);
  check(
    "both automatable actions are recorded executed with Aimfox's returned id",
    executed.actions.find((a) => a.id === "a1")?.aimfoxId === "aimfox_conn_1" &&
      executed.actions.find((a) => a.id === "a2")?.aimfoxId === "aimfox_msg_1",
    executed.actions,
  );

  // Re-running the executor over its own output must not re-send anything already settled —
  // this is the idempotency guarantee a partial-failure retry depends on.
  let addCallsAgain = 0;
  const reRun = await executeLinkedinEngagerBatch(executed, { apiKey: "fake", addAudience: async () => { addCallsAgain++; return {}; } });
  check("a second pass over an already-executed batch makes no network call", addCallsAgain === 0, addCallsAgain);
  check("a second pass returns the same executed state", reRun.actions.every((a) => a.status !== "pending"), reRun.actions);

  // A per-item failure (e.g. an invalid profile) is recorded on THAT action and does not block
  // the rest of the queue.
  const twoConnections: LinkedinEngagerDelivery = {
    ...baseDelivery,
    actions: [connectionAction, { ...connectionAction, id: "a5", targetProfileUrl: "https://linkedin.com/in/bad" }],
  };
  let addAttempts = 0;
  const partialFail = await executeLinkedinEngagerBatch(twoConnections, {
    apiKey: "fake",
    addAudience: async (_key, _campaignId, body) => {
      addAttempts++;
      if (body.profile_url === "https://linkedin.com/in/bad") throw new AimfoxApiError(422, "invalid profile");
      return { id: "aimfox_ok" };
    },
  });
  check("a per-item failure doesn't stop the batch — both targets are attempted", addAttempts === 2, addAttempts);
  check("the failing action is recorded failed with a legible reason", partialFail.actions.find((a) => a.id === "a5")?.status === "failed", partialFail.actions);
  check("the other action still succeeds", partialFail.actions.find((a) => a.id === "a1")?.status === "executed", partialFail.actions);

  // A 429 stops the batch entirely — remaining actions stay pending rather than being attempted
  // and possibly failing louder, or silently retried past the limit.
  const threeConnections: LinkedinEngagerDelivery = {
    ...baseDelivery,
    actions: [connectionAction, { ...connectionAction, id: "a6" }, { ...connectionAction, id: "a7" }],
  };
  let rateLimitAttempts = 0;
  const rateLimited = await executeLinkedinEngagerBatch(threeConnections, {
    apiKey: "fake",
    addAudience: async () => {
      rateLimitAttempts++;
      if (rateLimitAttempts === 2) throw new AimfoxApiError(429, "rate limited");
      return { id: `aimfox_${rateLimitAttempts}` };
    },
  });
  check("a rate limit stops the loop — the third action is never attempted", rateLimitAttempts === 2, rateLimitAttempts);
  check("the first action (before the limit) is still recorded executed", rateLimited.actions.find((a) => a.id === "a1")?.status === "executed", rateLimited.actions);
  check("the third action (after the limit) stays pending, not failed", rateLimited.actions.find((a) => a.id === "a7")?.status === "pending", rateLimited.actions);
  check("rateLimitedAt is recorded on the delivery", typeof rateLimited.rateLimitedAt === "string", rateLimited.rateLimitedAt);
  check("summarizeBatch reports what's pending after a rate limit", summarizeBatch(rateLimited).includes("still pending"), summarizeBatch(rateLimited));
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
  // ever inventing a figure Apollo didn't return. Bands now come from a play's own config (via
  // firmographicBandFromIcp), not a hardcoded per-slug table — see outbound-play-config.ts.
  const bandA = { minEmployees: 50, maxEmployees: 500, industryHint: "B2B SaaS or software company" };
  const bandB = { minEmployees: 100, maxEmployees: 2000, industryHint: "PE-backed portfolio company" };
  const noBand = { minEmployees: null, maxEmployees: null, industryHint: "this play's target ICP" };

  check("firmographicFitNotes: no org data yields a single no-data note", firmographicFitNotes(bandA, null).length === 1 && /no apollo firmographic data/i.test(firmographicFitNotes(bandA, null)[0] ?? ""));
  const withinBand = firmographicFitNotes(bandA, { employeeCount: 120, industry: "Software" });
  check("firmographicFitNotes: employee count within a 50-500 band is noted as within band", withinBand.some((n) => /within this play/i.test(n)), withinBand);
  const belowBand = firmographicFitNotes(bandA, { employeeCount: 5, industry: null });
  check("firmographicFitNotes: employee count below the band is noted as below", belowBand.some((n) => /below this play/i.test(n)), belowBand);
  const aboveBandB = firmographicFitNotes(bandB, { employeeCount: 5000, industry: null });
  check("firmographicFitNotes: a different play's 100-2000 band is used, not the first play's", aboveBandB.some((n) => /above this play.*100-2000/i.test(n)), aboveBandB);
  const noBandNote = firmographicFitNotes(noBand, { employeeCount: 120, industry: null });
  check("firmographicFitNotes: a play with no employee-range ICP notes that instead of guessing a band", noBandNote.some((n) => /no employee-range ICP filter configured/i.test(n)), noBandNote);
}

// ---------------------------------------------------------------------------
// OutboundPlay.config — schema defaults, Apollo filter building, exclusion matching, the
// firmographic band derivation, and score-based routing (lib/agent-handlers/outbound-play-config.ts).
// ---------------------------------------------------------------------------
{
  const emptyConfig = parsePlayConfig({});
  check("parsePlayConfig: empty input gets full defaults", emptyConfig.routingThresholds.emailAndLinkedin === 80 && emptyConfig.dailySourcingCap === 30 && emptyConfig.autoAdvance === true, emptyConfig);
  check("parsePlayConfig: malformed input falls back to defaults instead of throwing", parsePlayConfig({ routingThresholds: "not an object" }).routingThresholds.emailOnly === 65);
  check("parsePlayConfig: null/undefined input is safe", parsePlayConfig(null).icp.titles.length === 0 && parsePlayConfig(undefined).icp.titles.length === 0);

  const partialConfig = parsePlayConfig({ icp: { titles: ["CTO"] }, dailySourcingCap: 10 });
  check("parsePlayConfig: a partial ICP still fills in the rest of the defaults", partialConfig.icp.titles.length === 1 && Array.isArray(partialConfig.icp.exclusions), partialConfig);
  check("parsePlayConfig: an explicit field overrides its default", partialConfig.dailySourcingCap === 10, partialConfig);

  const filters = buildApolloPeopleSearchFilters({
    titles: ["CTO", "VP Engineering"],
    seniorities: ["vp"],
    departments: ["engineering"],
    employeeRanges: ["51,500"],
    industries: ["fintech"],
    geographies: ["United States"],
    technologies: ["react"],
    exclusions: [],
  });
  const typedFilters = filters as { person_titles?: string[]; organization_num_employees_ranges?: string[]; q_organization_keyword_tags?: string[] };
  check("buildApolloPeopleSearchFilters: person_titles carries the ICP's titles", Array.isArray(typedFilters.person_titles) && typedFilters.person_titles.length === 2, filters);
  check("buildApolloPeopleSearchFilters: organization_num_employees_ranges carries the employee ranges", !!typedFilters.organization_num_employees_ranges?.includes("51,500"), filters);
  check("buildApolloPeopleSearchFilters: q_organization_keyword_tags carries the industries/keywords", !!typedFilters.q_organization_keyword_tags?.includes("fintech"), filters);
  check("buildApolloPeopleSearchFilters: departments are never sent (no verified Apollo param)", !("departments" in filters) && !("person_departments" in filters), filters);
  check("buildApolloPeopleSearchFilters: technologies are never sent (no verified Apollo param)", !("technologies" in filters) && !("currently_using_any_of_technology_uids" in filters), filters);

  const emptyFilters = buildApolloPeopleSearchFilters({ titles: [], seniorities: [], departments: [], employeeRanges: [], industries: [], geographies: [], technologies: [], exclusions: [] });
  check("buildApolloPeopleSearchFilters: an ICP with nothing set sends no filters at all", Object.keys(emptyFilters).length === 0, emptyFilters);

  check("matchesExclusion: matches a domain substring case-insensitively", matchesExclusion({ primary_domain: "Competitor.com" }, ["competitor.com"]) === true);
  check("matchesExclusion: matches a company name substring", matchesExclusion({ name: "Acme Competitor Inc" }, ["competitor"]) === true);
  check("matchesExclusion: no match returns false", matchesExclusion({ name: "Totally Different Co", primary_domain: "different.com" }, ["competitor.com"]) === false);
  check("matchesExclusion: an empty exclusion list always returns false", matchesExclusion({ name: "Anything" }, []) === false);
  check("matchesExclusion: null org returns false rather than throwing", matchesExclusion(null, ["x"]) === false);

  const band = firmographicBandFromIcp({ titles: [], seniorities: [], departments: [], employeeRanges: ["51,500", "10,1000"], industries: ["fintech"], geographies: [], technologies: [], exclusions: [] });
  check("firmographicBandFromIcp: takes the widest span across multiple ranges", band.minEmployees === 10 && band.maxEmployees === 1000, band);
  const noRangeBand = firmographicBandFromIcp({ titles: [], seniorities: [], departments: [], employeeRanges: [], industries: [], geographies: [], technologies: [], exclusions: [] });
  check("firmographicBandFromIcp: no employee ranges yields a null band, not a guessed one", noRangeBand.minEmployees === null && noRangeBand.maxEmployees === null, noRangeBand);

  const thresholds = { emailAndLinkedin: 80, emailOnly: 65, watchlist: 50 };
  check("routeByScore: 80+ routes to EMAIL_AND_LINKEDIN", routeByScore(80, thresholds) === "EMAIL_AND_LINKEDIN");
  check("routeByScore: 65-79 routes to EMAIL_ONLY", routeByScore(70, thresholds) === "EMAIL_ONLY");
  check("routeByScore: 50-64 routes to WATCHLIST", routeByScore(55, thresholds) === "WATCHLIST");
  check("routeByScore: below 50 routes to DISCARDED", routeByScore(10, thresholds) === "DISCARDED");
  const customThresholds = { emailAndLinkedin: 90, emailOnly: 75, watchlist: 60 };
  check("routeByScore: honours a play's own custom thresholds, not the 80/65/50 default", routeByScore(85, customThresholds) === "EMAIL_ONLY", routeByScore(85, customThresholds));
}

// ---------------------------------------------------------------------------
// Campaign resolution from a play's config — replaces outbound-email.ts's old CAMPAIGN_MAP and
// outbound-linkedin.ts's old AIMFOX_CAMPAIGN_MAP (both keyed by play slug). No slug-derived name
// convention anywhere in this decision.
// ---------------------------------------------------------------------------
{
  const withId = planCampaignResolution("camp_123", "My Campaign");
  check("planCampaignResolution: an id on file needs no lookup", withId.mode === "id" && withId.mode === "id" && withId.campaignId === "camp_123", withId);

  const idOnly = planCampaignResolution("camp_456", undefined);
  check("planCampaignResolution: an id with no name falls back to the id as the display name", idOnly.mode === "id" && idOnly.mode === "id" && idOnly.campaignName === "camp_456", idOnly);

  const nameOnly = planCampaignResolution(undefined, "Some Campaign Name");
  check("planCampaignResolution: a name with no id requires a lookup", nameOnly.mode === "lookup" && nameOnly.mode === "lookup" && nameOnly.targetName === "Some Campaign Name", nameOnly);

  const neither = planCampaignResolution(undefined, undefined);
  check("planCampaignResolution: neither set is unconfigured", neither.mode === "unconfigured", neither);

  const emptyStrings = planCampaignResolution("", "");
  check("planCampaignResolution: empty strings are treated as unset, not as a value to resolve", emptyStrings.mode === "unconfigured", emptyStrings);
}

// ---------------------------------------------------------------------------
// Scout's dedupe/reveal selection (lib/agent-handlers/outbound-play-config.ts, used by
// outbound-scout.ts) — pure, so the exclusion filter and per-run reveal cap can be checked without
// a live Apollo key.
// ---------------------------------------------------------------------------
{
  const people = [
    { id: "1", organization: { primary_domain: "acme.com", name: "Acme" } },
    { id: "2", organization: { primary_domain: "competitor.com", name: "Competitor Inc" } },
    { id: "3", organization: { primary_domain: "beta.com", name: "Beta Co" } },
    { id: "4", organization: { primary_domain: "gamma.com", name: "Gamma LLC" } },
  ];

  const noExclusions = selectPeopleToReveal(people, { exclusions: [], cap: 10 });
  check("selectPeopleToReveal: no exclusions keeps everyone", noExclusions.toReveal.length === 4 && noExclusions.excludedByRules === 0, noExclusions);

  const withExclusion = selectPeopleToReveal(people, { exclusions: ["competitor.com"], cap: 10 });
  check("selectPeopleToReveal: an excluded domain is dropped", withExclusion.toReveal.length === 3 && !withExclusion.toReveal.some((p) => p.id === "2"), withExclusion);
  check("selectPeopleToReveal: reports how many were excluded by the play's rules", withExclusion.excludedByRules === 1, withExclusion);

  const capped = selectPeopleToReveal(people, { exclusions: [], cap: 2 });
  check("selectPeopleToReveal: the reveal cap is applied after exclusions, preserving order", capped.toReveal.length === 2 && capped.toReveal[0].id === "1" && capped.toReveal[1].id === "2", capped);

  const zeroCap = selectPeopleToReveal(people, { exclusions: [], cap: 0 });
  check("selectPeopleToReveal: a zero cap reveals no one", zeroCap.toReveal.length === 0, zeroCap);

  const existingEmails = new Set(["existing@acme.com"]);
  const sourced = [
    { email: "existing@acme.com", firstName: "Already" },
    { email: "NEW@acme.com", firstName: "New" },
    { firstName: "No email at all" },
  ];
  const deduped = dedupeNewProspects(sourced, existingEmails);
  check("dedupeNewProspects: drops a prospect already in the pipeline", !deduped.some((p) => p.email === "existing@acme.com"), deduped);
  check("dedupeNewProspects: email comparison is case-insensitive", deduped.some((p) => p.email === "NEW@acme.com"), deduped);
  check("dedupeNewProspects: a prospect with no email at all is dropped, not kept", deduped.length === 1, deduped);
}

// ---------------------------------------------------------------------------
// Pipeline chaining decisions (lib/agent-handlers/chaining.ts) — pure: given a settled Scout or
// Strategist run's output and its play's config, what (if anything) gets enqueued next. The actual
// enqueueing and its cross-call idempotency guarantee (a real unique-constraint violation on
// AgentRun's (parentRunId, agentConfigId) index) needs a live database and can't be exercised in
// this no-network, no-DB test file — see chaining.ts's own doc comment for that half of the
// contract. What's checked here is the half that determines it: the same output always plans the
// same target(s), and never more than one target per downstream agent.
// ---------------------------------------------------------------------------
{
  const autoAdvanceOn = parsePlayConfig({ autoAdvance: true });
  const autoAdvanceOff = parsePlayConfig({ autoAdvance: false });

  const scoutOutput = { playSlug: "acme-icp", prospectIds: ["p1", "p2", "p3"] };
  const scoutPlan = planScoutChaining(scoutOutput, autoAdvanceOn);
  check("planScoutChaining: enqueues Strategist with exactly the new prospect ids", scoutPlan?.agentSlug === "outbound-strategist" && JSON.stringify(scoutPlan.input.prospectIds) === JSON.stringify(["p1", "p2", "p3"]), scoutPlan);
  check("planScoutChaining: is deterministic — calling it again with the same output plans the same thing", JSON.stringify(planScoutChaining(scoutOutput, autoAdvanceOn)) === JSON.stringify(scoutPlan));
  check("planScoutChaining: autoAdvance off plans nothing", planScoutChaining(scoutOutput, autoAdvanceOff) === null);
  check("planScoutChaining: no prospectIds plans nothing (e.g. a simulation run)", planScoutChaining({ playSlug: "acme-icp", prospectIds: [] }, autoAdvanceOn) === null);
  check("planScoutChaining: no playSlug plans nothing", planScoutChaining({ prospectIds: ["p1"] }, autoAdvanceOn) === null);

  const strategistOutput = {
    playSlug: "acme-icp",
    results: [
      { prospectId: "a1", routing: "EMAIL_AND_LINKEDIN" },
      { prospectId: "a2", routing: "EMAIL_ONLY" },
      { prospectId: "a3", routing: "WATCHLIST" },
      { prospectId: "a4", routing: "DISCARDED" },
      { prospectId: "a5", routing: "EMAIL_AND_LINKEDIN" },
    ],
  };
  const strategistPlan = planStrategistChaining(strategistOutput, autoAdvanceOn);
  check("planStrategistChaining: plans exactly one target per downstream agent", strategistPlan.length === 2, strategistPlan);
  check("planStrategistChaining: at most one outbound-email target", strategistPlan.filter((t) => t.agentSlug === "outbound-email").length === 1, strategistPlan);
  check("planStrategistChaining: at most one outbound-linkedin target", strategistPlan.filter((t) => t.agentSlug === "outbound-linkedin").length === 1, strategistPlan);

  const emailTarget = strategistPlan.find((t) => t.agentSlug === "outbound-email");
  const linkedinTarget = strategistPlan.find((t) => t.agentSlug === "outbound-linkedin");
  check(
    "planStrategistChaining: Email Outbound gets EMAIL_ONLY + EMAIL_AND_LINKEDIN prospects",
    JSON.stringify((emailTarget?.input.prospectIds as string[])?.slice().sort()) === JSON.stringify(["a1", "a2", "a5"].sort()),
    emailTarget,
  );
  check(
    "planStrategistChaining: LinkedIn Outbound gets only EMAIL_AND_LINKEDIN prospects",
    JSON.stringify((linkedinTarget?.input.prospectIds as string[])?.slice().sort()) === JSON.stringify(["a1", "a5"].sort()),
    linkedinTarget,
  );
  check(
    "planStrategistChaining: WATCHLIST/DISCARDED prospects are routed to neither",
    !(emailTarget?.input.prospectIds as string[])?.includes("a3") &&
      !(emailTarget?.input.prospectIds as string[])?.includes("a4") &&
      !(linkedinTarget?.input.prospectIds as string[])?.includes("a3"),
  );
  check("planStrategistChaining: autoAdvance off plans nothing", planStrategistChaining(strategistOutput, autoAdvanceOff).length === 0);

  const onlyWatchlist = { playSlug: "acme-icp", results: [{ prospectId: "w1", routing: "WATCHLIST" }] };
  check("planStrategistChaining: an all-WATCHLIST batch plans no children at all", planStrategistChaining(onlyWatchlist, autoAdvanceOn).length === 0, planStrategistChaining(onlyWatchlist, autoAdvanceOn));

  // Back-compat single-prospect shape (Strategist's own output surfaces top-level fields when
  // exactly one prospect was scored — see outbound-strategist.ts).
  const singleShape = { playSlug: "acme-icp", prospectId: "s1", routing: "EMAIL_AND_LINKEDIN" };
  const singlePlan = planStrategistChaining(singleShape, autoAdvanceOn);
  check(
    "planStrategistChaining: understands the single-prospect back-compat output shape too",
    singlePlan.some((t) => t.agentSlug === "outbound-email" && (t.input.prospectIds as string[]).includes("s1")) &&
      singlePlan.some((t) => t.agentSlug === "outbound-linkedin" && (t.input.prospectIds as string[]).includes("s1")),
    singlePlan,
  );
}

// ---------------------------------------------------------------------------
// Static check: no hardcoded Dev.co play slug (DEV-0<digit>) remains anywhere in the app's own
// source, other than the one script that deliberately seeds Dev.co's own three plays. This is the
// regression guard for the whole point of the Outbound Engine rebuild — every other workspace used
// to inherit Dev.co's plays because the slug was baked into agent handlers, metadata, and UI.
// ---------------------------------------------------------------------------
{
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js"]);
  const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".git", "coverage"]);
  // The one file allowed to name Dev.co's actual play slugs — it exists specifically to seed them
  // for the Dev.co workspace and nowhere else (see the script's own doc comment). This test file
  // is also excluded from its own scan — it necessarily names the pattern it's checking for, in
  // this very check's description and in the regex below.
  const ALLOWED_FILES = new Set([
    path.join(repoRoot, "scripts", "seed-devco-plays.mjs"),
    // Not fileURLToPath(import.meta.url) — esbuild bundles this file to dist/content.test.mjs, so
    // that would resolve to the build output (already excluded via SKIP_DIRS "dist"), not this
    // source file, which is what actually needs excluding from its own scan.
    path.join(repoRoot, "test", "content.test.ts"),
  ]);

  const offenders: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!SCAN_EXTENSIONS.has(path.extname(entry.name))) continue;
      if (ALLOWED_FILES.has(full)) continue;
      const text = readFileSync(full, "utf8");
      if (/DEV-0/.test(text)) offenders.push(path.relative(repoRoot, full));
    }
  }
  walk(repoRoot);

  check("no hardcoded DEV-0x play slug remains outside the Dev.co seed script", offenders.length === 0, offenders);
}

// ---------------------------------------------------------------------------
// Blog Writer visuals + word-count floor (2026-09-14). Pure only: schema
// shape, per-type block validation, the chart/stat honesty check, HTML
// escaping/markup, the CTA link-classification fix, and the word-count-floor
// tie-break. Image generation and CMS media upload themselves are network
// calls (lib/images/*, lib/agent-handlers/blog-writer.ts's publish* helpers)
// and are exercised manually, same split as every other integration in this
// file.
// ---------------------------------------------------------------------------
{
  // Schema-complexity regression guard. 2026-09-14: the first version of this
  // put every visual type's fields as OPTIONAL properties on the $ref'd
  // definitions.block, and the live API rejected it — 400 "Schema is too
  // complex" (req_011Cf3vfdtPDb472kHMna1jz), which would have failed every
  // Blog Writer run. The fix: definitions.block is restored to the exact
  // prose-only shape proven live before visuals existed, and visuals move to
  // a separate, flat, top-level `visuals` array whose item has ZERO optional
  // properties (strict-schema grammar cost scales with optional properties,
  // not simply with property count). These checks fail the build the moment
  // either guarantee regresses — a much cheaper way to catch it than another
  // live 400.
  type SchemaNode = {
    type?: string;
    properties?: Record<string, SchemaNode>;
    required?: string[];
    items?: SchemaNode | SchemaNode[];
    enum?: string[];
    definitions?: Record<string, SchemaNode>;
  };
  const schema = SUBMIT_ARTICLE_TOOL.input_schema as unknown as SchemaNode;

  // No unsupported keyword anywhere (same walk as the original schema test above).
  const walkBad = (n: unknown): boolean =>
    Array.isArray(n)
      ? n.some(walkBad)
      : !!n &&
        typeof n === "object" &&
        (("minItems" in (n as object) && ![0, 1].includes((n as { minItems: number }).minItems)) ||
          ["maxItems", "minLength", "maxLength", "minimum", "maximum"].some((k) => k in (n as object)) ||
          Object.values(n as object).some(walkBad));
  check("the restructured schema still has no keyword strict mode rejects", !walkBad(schema));

  // 1. definitions.block matches the OLD, live-proven, prose-only shape exactly.
  const blockDef = schema.definitions!.block;
  check("block's property set is exactly {type, runs, ordered, items} — no visual fields", JSON.stringify(Object.keys(blockDef.properties!).sort()) === JSON.stringify(["items", "ordered", "runs", "type"].sort()));
  check("block requires only \"type\"", JSON.stringify(blockDef.required) === JSON.stringify(["type"]));
  check("block's type enum is exactly paragraph|list — no visual types embedded inline", JSON.stringify(blockDef.properties!.type.enum) === JSON.stringify(["paragraph", "list"]));

  // 2. The top-level `visuals` array's item has ZERO optional properties.
  const visualsItem = (schema.properties!.visuals as SchemaNode).items as SchemaNode;
  const visualsProps = Object.keys(visualsItem.properties!).sort();
  const visualsRequired = [...(visualsItem.required ?? [])].sort();
  check("visuals is a top-level array field", schema.properties!.visuals.type === "array");
  check("every property on a visuals[] entry is required — none optional", JSON.stringify(visualsProps) === JSON.stringify(visualsRequired), { visualsProps, visualsRequired });
  check("visuals[] carries all sixteen flat fields the coordinator specified", visualsProps.length === 16, visualsProps);

  // 3. Total optional-property count across the WHOLE schema must not exceed
  // the old (pre-visuals) schema's count. That schema's only optional
  // properties were paragraph's items.link/items.bold (2) and
  // definitions.block's runs/ordered/items (3) = 5 total; every other object
  // in it required every one of its own properties. Recomputed here rather
  // than hand-counted so it can't silently drift.
  const OLD_SCHEMA_OPTIONAL_COUNT = 5;
  function countOptionalProperties(node: unknown): number {
    if (Array.isArray(node)) return node.reduce((sum: number, n) => sum + countOptionalProperties(n), 0);
    if (!node || typeof node !== "object") return 0;
    const obj = node as SchemaNode & Record<string, unknown>;
    let count = 0;
    if (obj.type === "object" && obj.properties) {
      const required = new Set(obj.required ?? []);
      for (const key of Object.keys(obj.properties)) if (!required.has(key)) count += 1;
    }
    for (const value of Object.values(obj)) count += countOptionalProperties(value);
    return count;
  }
  const optionalCount = countOptionalProperties(schema);
  check(
    `total optional properties across the schema (${optionalCount}) is no more than the old schema's (${OLD_SCHEMA_OPTIONAL_COUNT})`,
    optionalCount <= OLD_SCHEMA_OPTIONAL_COUNT,
    { optionalCount, OLD_SCHEMA_OPTIONAL_COUNT },
  );

  // A helper matching the flat, all-required `visuals[]` item shape — fills
  // every field with its "not applicable" default ("" / [] / "none" / -1) so
  // each test only has to name the fields that actually matter for it,
  // exactly as the writer is instructed to submit one.
  const emptyVisual = () => ({
    type: "table" as string,
    after_section_index: -1,
    title: "",
    caption: "",
    kind: "none",
    body: "",
    value: "",
    label: "",
    source_url: "",
    unit: "",
    headers: [] as string[],
    rows: [] as string[][],
    series: [] as Array<{ label: string; value: number }>,
    image_prompt: "",
    alt: "",
    slot: "none",
  });
  const mkVisual = (overrides: Partial<ReturnType<typeof emptyVisual>>) => ({ ...emptyVisual(), ...overrides });

  // normaliseArticle: per-type validation via the visuals array. One article,
  // one visual of each kind targeting the same section, one deliberately-
  // broken example of each so droppedVisuals records why rather than
  // rendering something malformed.
  const visualsArticle = normaliseArticle(
    {
      title: "Widgets and Their Discontents",
      slug: "widgets",
      meta_description: "d".repeat(155),
      intro_blocks: [{ type: "paragraph", runs: [{ text: "Widgets are everywhere in modern manufacturing." }] }],
      sections: [
        {
          heading: "The Data",
          blocks: [{ type: "paragraph", runs: [{ text: "Here is what the numbers say about widget adoption this year." }] }],
        },
      ],
      links_used: [],
      visuals: [
        mkVisual({ type: "table", after_section_index: 0, caption: "Widget types", headers: ["Type", "Cost"], rows: [["Basic", "$10"], ["Pro", "$25"]] }),
        mkVisual({ type: "table", after_section_index: 0, headers: ["A", "B"], rows: [["only-one"]] }), // row width mismatch — dropped
        mkVisual({ type: "callout", after_section_index: 0, kind: "key_takeaway", title: "Remember this", body: "Widgets pay for themselves within a year." }),
        mkVisual({ type: "callout", after_section_index: 0, kind: "not_a_real_kind", body: "x" }), // invalid kind — dropped
        mkVisual({ type: "stat", after_section_index: 0, value: "42%", label: "of firms use widgets", source_url: "https://example.com/widget-report" }),
        mkVisual({ type: "stat", after_section_index: 0, value: "10%" }), // no label — dropped
        mkVisual({ type: "chart", after_section_index: 0, kind: "bar", title: "Widget adoption by year", unit: "%", series: [{ label: "2024", value: 30 }, { label: "2025", value: 42 }], source_url: "https://example.com/widget-report" }),
        mkVisual({ type: "chart", after_section_index: 0, kind: "bar", title: "Empty chart", series: [] }), // no series — dropped
        mkVisual({ type: "image", after_section_index: 0, slot: "inline", image_prompt: "A close-up photo of a mechanical widget on a workbench.", alt: "A mechanical widget on a workbench" }),
        mkVisual({ type: "image", after_section_index: 0, slot: "inline", image_prompt: "Some other widget scene" }), // no alt text — dropped
      ],
      word_count: 0,
      qc_notes: "",
    },
    { focusKeyword: "widgets" },
  );

  check("a valid table survives normalisation and lands in the named section", visualsArticle.sections[0].blocks.some((b) => b.type === "table" && b.headers.length === 2), visualsArticle.sections[0].blocks);
  check("a row narrower than the headers is dropped, not rendered ragged", visualsArticle.sections[0].blocks.filter((b) => b.type === "table").length === 1);
  check("a valid callout survives normalisation", visualsArticle.sections[0].blocks.some((b) => b.type === "callout" && b.kind === "key_takeaway"));
  check("a callout's plain body text becomes a single run", visualsArticle.sections[0].blocks.some((b) => b.type === "callout" && b.runs.length === 1 && b.runs[0].text === "Widgets pay for themselves within a year."));
  check("an invalid callout kind is dropped", visualsArticle.sections[0].blocks.filter((b) => b.type === "callout").length === 1);
  check("a valid stat survives normalisation", visualsArticle.sections[0].blocks.some((b) => b.type === "stat" && b.value === "42%"));
  check("a stat missing its label is dropped", visualsArticle.sections[0].blocks.filter((b) => b.type === "stat").length === 1);
  check("a valid chart survives normalisation", visualsArticle.sections[0].blocks.some((b) => b.type === "chart" && b.series.length === 2));
  check("a chart with no series is dropped", visualsArticle.sections[0].blocks.filter((b) => b.type === "chart").length === 1);
  check("a valid image survives normalisation and gets an id", visualsArticle.sections[0].blocks.some((b) => b.type === "image" && b.id.startsWith("img-")));
  check("an image with no alt text is dropped", visualsArticle.sections[0].blocks.filter((b) => b.type === "image").length === 1);
  check(
    "every drop is recorded with a reason, not silently swallowed",
    visualsArticle.droppedVisuals.length === 5,
    visualsArticle.droppedVisuals,
  );

  // Placement: after_section_index -1 goes to the intro; an out-of-range index clamps to the last section.
  const placementArticle = normaliseArticle(
    {
      title: "Widgets",
      slug: "widgets",
      meta_description: "d".repeat(155),
      intro_blocks: [{ type: "paragraph", runs: [{ text: "Intro paragraph." }] }],
      sections: [
        { heading: "One", blocks: [{ type: "paragraph", runs: [{ text: "Section one body." }] }] },
        { heading: "Two", blocks: [{ type: "paragraph", runs: [{ text: "Section two body." }] }] },
      ],
      links_used: [],
      visuals: [
        mkVisual({ type: "stat", after_section_index: -1, value: "1", label: "in the intro" }),
        mkVisual({ type: "stat", after_section_index: 99, value: "2", label: "clamped to the last section" }),
      ],
      word_count: 0,
      qc_notes: "",
    },
    { focusKeyword: "widgets" },
  );
  check("after_section_index -1 places the visual in the intro", placementArticle.introBlocks.some((b) => b.type === "stat" && b.label === "in the intro"));
  check("an out-of-range after_section_index clamps to the last section rather than throwing", placementArticle.sections[1].blocks.some((b) => b.type === "stat" && b.label === "clamped to the last section"));

  // Word count excludes visuals entirely — only the two prose paragraphs count.
  const proseWords = "Widgets are everywhere in modern manufacturing.".split(/\s+/).length +
    "Here is what the numbers say about widget adoption this year.".split(/\s+/).length;
  check(
    "wordCount counts only prose (paragraph/list) blocks, never table/callout/stat/chart/image text",
    visualsArticle.wordCount === proseWords,
    { wordCount: visualsArticle.wordCount, proseWords },
  );

  // renderHtml: escaping, and valid table/SVG/callout/stat markup.
  const dangerousArticle = normaliseArticle(
    {
      title: "Widgets",
      slug: "widgets",
      meta_description: "d".repeat(155),
      intro_blocks: [{ type: "paragraph", runs: [{ text: "Intro." }] }],
      sections: [{ heading: "Data", blocks: [{ type: "paragraph", runs: [{ text: "Body." }] }] }],
      links_used: [],
      visuals: [
        mkVisual({ type: "table", after_section_index: 0, headers: ["<script>alert(1)</script>", "B"], rows: [["<img src=x onerror=alert(1)>", "ok"]] }),
        mkVisual({ type: "callout", after_section_index: 0, kind: "warning", body: "Never say \"always\" & never say \"never\"." }),
        mkVisual({ type: "chart", after_section_index: 0, kind: "bar", title: "Adoption <script>", series: [{ label: "A&B", value: 5 }], source_url: "https://example.com/x" }),
      ],
      word_count: 0,
      qc_notes: "",
    },
    { focusKeyword: "widgets" },
  );
  const dangerousHtml = renderHtml(dangerousArticle);
  check("renderHtml never emits a raw <script> tag from block content", !dangerousHtml.includes("<script>alert"));
  check("renderHtml escapes an angle-bracket attack in a table cell", dangerousHtml.includes("&lt;img src=x onerror=alert(1)&gt;"));
  check("renderHtml escapes & in prose", dangerousHtml.includes("&amp;"));
  check("table renders as figure>table with caption/thead/tbody", /<figure class="erp-table"><table>[\s\S]*<thead>[\s\S]*<tbody>/.test(dangerousHtml));
  check("callout renders as an aside with a kind class", dangerousHtml.includes('<aside class="erp-callout erp-callout--warning">'));
  check("chart renders inline SVG with role=img, a <title> and a <desc>", /<svg role="img" aria-labelledby="[^"]+"[^>]*><title id="[^"]+">/.test(dangerousHtml));
  check("chart carries an accessible data-table fallback in <details>", /<details class="erp-chart__data"><summary>Data table<\/summary>/.test(dangerousHtml));
  check("chart's SVG paints with currentColor, not a fixed hex, so it reads in both themes", dangerousHtml.includes('fill="currentColor"') && !/#[0-9a-fA-F]{3,6}/.test(dangerousHtml));

  // An image with no generated asset yet renders a safe placeholder, never an <img> with an empty/missing src.
  const imageOnlyArticle = normaliseArticle(
    {
      title: "Widgets",
      slug: "widgets",
      meta_description: "d".repeat(155),
      intro_blocks: [{ type: "paragraph", runs: [{ text: "Intro." }] }],
      sections: [{ heading: "Pictures", blocks: [{ type: "paragraph", runs: [{ text: "Body." }] }] }],
      links_used: [],
      visuals: [mkVisual({ type: "image", after_section_index: 0, slot: "hero", image_prompt: "A widget.", alt: "A widget on a table" })],
      word_count: 0,
      qc_notes: "",
    },
    { focusKeyword: "widgets" },
  );
  const pendingHtml = renderHtml(imageOnlyArticle);
  check("an ungenerated image never renders a bare <img> tag", !pendingHtml.includes("<img "));
  check("an ungenerated image is marked pending with its block id for later replacement", /data-image-id="img-1"/.test(pendingHtml));

  // Media URL replacement in the body — the exact mechanism the WordPress/Payload publish path
  // uses to swap our placeholder / preview src for the CMS's own uploaded media URL.
  const assets: Record<string, string> = {};
  const imgId = imageOnlyArticle.sections[0].blocks.find((b) => b.type === "image")!.id;
  assets[imgId] = "https://preview.example.com/api/assets/abc123";
  const previewHtml = renderHtml(imageOnlyArticle, assets);
  check("with an asset map, renderHtml embeds the real src", previewHtml.includes(`src="https://preview.example.com/api/assets/abc123"`));
  const publishedHtml = replaceImageSrc(previewHtml, imgId, "https://customer-site.com/wp-content/uploads/2026/09/widget.png");
  check("replaceImageSrc swaps only the matching image's src", publishedHtml.includes('src="https://customer-site.com/wp-content/uploads/2026/09/widget.png"'));
  check("replaceImageSrc leaves the data-image-id attribute intact", publishedHtml.includes(`data-image-id="${imgId}"`));
  check("replaceImageSrc on an id that isn't present changes nothing", replaceImageSrc(previewHtml, "img-does-not-exist", "https://x.com/y.png") === previewHtml);

  // Chart/stat honesty: values must trace to a verified research claim bound to the same source URL.
  const honestyBrief = buildBrief(
    { topicBrief: "x", targetKeyword: "widgets", wordCount: 1000, externalLinkCount: 1, webResearch: true, includeCharts: "true", includeAiImages: "false" },
    null,
    NEUTRAL_PROFILE,
    "seed",
  );
  const research = {
    sources: [{ url: "https://example.com/report", publisher: "Example", title: "Widget Report", supports: "adoption stats" }],
    claims: [{ claim: "42% of firms adopted widgets by 2025", sourceUrl: "https://example.com/report" }],
    angles: [],
    costUsd: 0,
    searched: true,
  };
  const tracedArticle = normaliseArticle(
    {
      title: "Widgets",
      slug: "widgets",
      meta_description: "d".repeat(155),
      intro_blocks: [{ type: "paragraph", runs: [{ text: "Widgets are everywhere now." }] }],
      sections: [{ heading: "Adoption", blocks: [{ type: "paragraph", runs: [{ text: "Adoption has grown steadily over the last two years for most firms." }] }] }],
      links_used: [],
      visuals: [
        mkVisual({ type: "stat", after_section_index: 0, value: "42%", label: "adoption rate", source_url: "https://example.com/report" }),
        mkVisual({ type: "chart", after_section_index: 0, kind: "bar", title: "Adoption", series: [{ label: "2025", value: 42 }], source_url: "https://example.com/report" }),
      ],
      word_count: 0,
      qc_notes: "",
    },
    { focusKeyword: "widgets" },
  );
  const tracedQc = runQc(tracedArticle, honestyBrief, research);
  check("a stat and chart whose values trace to a verified claim do NOT fail QC on that basis", !tracedQc.defects.some((d) => d.includes("does not trace")), tracedQc.defects);

  const untracedArticle = normaliseArticle(
    {
      title: "Widgets",
      slug: "widgets",
      meta_description: "d".repeat(155),
      intro_blocks: [{ type: "paragraph", runs: [{ text: "Widgets are everywhere now." }] }],
      sections: [{ heading: "Adoption", blocks: [{ type: "paragraph", runs: [{ text: "Adoption has grown steadily over the last two years for most firms." }] }] }],
      links_used: [],
      visuals: [
        // 99% appears nowhere in the claim set — invented.
        mkVisual({ type: "stat", after_section_index: 0, value: "99%", label: "adoption rate", source_url: "https://example.com/report" }),
        mkVisual({ type: "chart", after_section_index: 0, kind: "bar", title: "Adoption", series: [{ label: "2025", value: 99 }], source_url: "https://example.com/report" }),
      ],
      word_count: 0,
      qc_notes: "",
    },
    { focusKeyword: "widgets" },
  );
  const untracedQc = runQc(untracedArticle, honestyBrief, research);
  check("a stat with an invented value fails QC as untraced", untracedQc.defects.some((d) => d.includes('The stat "adoption rate: 99%"') && d.includes("does not trace")), untracedQc.defects);
  check("a chart with an invented data point fails QC as untraced", untracedQc.defects.some((d) => d.includes('The chart "Adoption"') && d.includes("not trace")), untracedQc.defects);

  const noSourceArticle = normaliseArticle(
    {
      title: "Widgets",
      slug: "widgets",
      meta_description: "d".repeat(155),
      intro_blocks: [{ type: "paragraph", runs: [{ text: "Widgets are everywhere now." }] }],
      sections: [{ heading: "Adoption", blocks: [{ type: "paragraph", runs: [{ text: "Adoption has grown steadily over the last two years for most firms." }] }] }],
      links_used: [],
      visuals: [mkVisual({ type: "stat", after_section_index: 0, value: "42%", label: "adoption rate" })],
      word_count: 0,
      qc_notes: "",
    },
    { focusKeyword: "widgets" },
  );
  check("a stat with no sourceUrl fails QC before the trace check even runs", runQc(noSourceArticle, honestyBrief, research).defects.some((d) => d.includes("no verified source URL")));
  check("without a research argument, the honesty check is skipped rather than failing closed (existing pure callers keep working)", runQc(untracedArticle, honestyBrief).defects.every((d) => !d.includes("does not trace")));

  // A comparison table's figures follow the same rule.
  const untracedTableArticle = normaliseArticle(
    {
      title: "Widgets",
      slug: "widgets",
      meta_description: "d".repeat(155),
      intro_blocks: [{ type: "paragraph", runs: [{ text: "Widgets come in several tiers for different budgets." }] }],
      sections: [{ heading: "Comparison", blocks: [{ type: "paragraph", runs: [{ text: "Here is how the tiers compare on price and support." }] }] }],
      links_used: [],
      visuals: [mkVisual({ type: "table", after_section_index: 0, headers: ["Tier", "Adoption"], rows: [["Basic", "99% adoption"], ["Pro", "qualitative only, no figure"]] })],
      word_count: 0,
      qc_notes: "",
    },
    { focusKeyword: "widgets" },
  );
  const untracedTableQc = runQc(untracedTableArticle, honestyBrief, research);
  check("an invented figure inside a table cell fails QC", untracedTableQc.defects.some((d) => d.includes("does not trace to a verified research claim") && d.includes("99% adoption")), untracedTableQc.defects);

  // Visual limits come from the brief: a type not requested, or over the count, is a defect.
  const noVisualsBrief = buildBrief({ topicBrief: "x", targetKeyword: "widgets", wordCount: 1000, externalLinkCount: 0, webResearch: false }, null, NEUTRAL_PROFILE, "seed");
  check("visualTypes defaults to all off", !noVisualsBrief.visualTypes.charts && !noVisualsBrief.visualTypes.tables && !noVisualsBrief.visualTypes.callouts && !noVisualsBrief.visualTypes.images);
  check("maxCharts/maxTables are 0 when the corresponding visual type is off", noVisualsBrief.maxCharts === 0 && noVisualsBrief.maxTables === 0);
  const unrequestedVisualQc = runQc(tracedArticle, noVisualsBrief, research);
  check("a chart present when the brief never asked for charts is a defect", unrequestedVisualQc.defects.some((d) => d.includes("did not ask for charts")), unrequestedVisualQc.defects);

  // Image cap: more image blocks than the brief's maxImages is a defect naming the excess.
  const imageCapBrief = { ...honestyBrief, visualTypes: { ...honestyBrief.visualTypes, images: true }, maxImages: 1 };
  const twoImagesArticle = normaliseArticle(
    {
      title: "Widgets",
      slug: "widgets",
      meta_description: "d".repeat(155),
      intro_blocks: [{ type: "paragraph", runs: [{ text: "Widgets come in several shapes and sizes for different uses." }] }],
      sections: [{ heading: "Gallery", blocks: [{ type: "paragraph", runs: [{ text: "A closer look at two common widget types side by side." }] }] }],
      links_used: [],
      visuals: [
        mkVisual({ type: "image", after_section_index: 0, slot: "hero", image_prompt: "A widget.", alt: "A widget" }),
        mkVisual({ type: "image", after_section_index: 0, slot: "inline", image_prompt: "Another widget.", alt: "Another widget" }),
      ],
      word_count: 0,
      qc_notes: "",
    },
    { focusKeyword: "widgets" },
  );
  const imageCapQc = runQc(twoImagesArticle, imageCapBrief);
  check("more image blocks than the brief's maxImages is a defect naming the cap", imageCapQc.defects.some((d) => d.includes("allows at most 1")), imageCapQc.defects);

  // The CTA/internal-domain link-classification fix: a link to the brief's own ctaUrl domain
  // must count as internal, not external — the exact false positive a live run hit
  // (app.vdr.ai's sign-up CTA counting as an external link).
  const ctaBrief = buildBrief(
    { topicBrief: "x", targetKeyword: "widgets", wordCount: 1000, externalLinkCount: 1, webResearch: false, ctaUrl: "https://app.vdr.ai/signup" },
    null,
    NEUTRAL_PROFILE,
    "seed",
  );
  const ctaArticle = normaliseArticle(
    {
      title: "Widgets",
      slug: "widgets",
      meta_description: "d".repeat(155),
      intro_blocks: [{ type: "paragraph", runs: [{ text: "Widgets are a useful tool for many businesses today." }] }],
      sections: [{ heading: "Get Started", blocks: [
        { type: "paragraph", runs: [{ text: "Ready to try it? " }, { text: "Sign up here", link: "https://app.vdr.ai/signup" }, { text: " to get started." }] },
        { type: "paragraph", runs: [{ text: "One external source backs this up. " }, { text: "See the report", link: "https://example.com/report" }, { text: "." }] },
      ] }],
      links_used: [],
      word_count: 0,
      qc_notes: "",
    },
    { focusKeyword: "widgets" },
  );
  const ctaQc = runQc(ctaArticle, ctaBrief);
  check("the CTA link to the brief's own domain is counted internal, not external", ctaQc.computed.externalLinks === 1, ctaQc.computed);
  check(
    "…so the run does not falsely flag '2 external links vs 1' the way the live app.vdr.ai run did",
    !ctaQc.defects.some((d) => d.toLowerCase().includes("external reference link") && d.includes("2")),
    ctaQc.defects,
  );

  // --- Word-count floor (owner feedback on live run cmu1kgojj…, 2026-09-14) ---

  const bandAt1500 = lengthBand(1500);
  check("lengthBand: the floor is the target itself, not 85% of it", bandAt1500.min === 1500, bandAt1500);
  check("lengthBand: the ceiling is target * 1.25", bandAt1500.max === 1875, bandAt1500);

  const floorBrief = buildBrief({ topicBrief: "x", targetKeyword: "widgets", wordCount: 1500, externalLinkCount: 0, webResearch: false }, null, NEUTRAL_PROFILE, "seed");
  const wordsOfLength = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
  const articleOfWords = (n: number) =>
    normaliseArticle(
      {
        title: "Widgets",
        slug: "widgets",
        meta_description: "d".repeat(155),
        intro_blocks: [{ type: "paragraph", runs: [{ text: wordsOfLength(Math.min(n, 20)) }] }],
        sections: [
          { heading: "One", blocks: [{ type: "paragraph", runs: [{ text: wordsOfLength(Math.max(0, n - 20)) }] }] },
          { heading: "Two", blocks: [{ type: "paragraph", runs: [{ text: "A short second section stands here for structure." }] }] },
          { heading: "Three", blocks: [{ type: "paragraph", runs: [{ text: "A short third section stands here for structure too." }] }] },
        ],
        links_used: [],
        word_count: 0,
        qc_notes: "",
      },
      { focusKeyword: "widgets" },
    );

  const shortArticle = articleOfWords(1299);
  const shortQc = runQc(shortArticle, floorBrief);
  check("a 1299-word article against a 1500 target fails on length", shortQc.defects.some((d) => d.includes("below the 1500-word floor")), shortQc.computed);
  const shortDeficit = floorBrief.length.min - shortArticle.wordCount;
  check(
    "the defect names the exact deficit, not just \"add substance\"",
    shortQc.defects.some((d) => d.includes(`add ~${shortDeficit} words`)),
    { shortDeficit, defects: shortQc.defects },
  );

  const inBandArticle = articleOfWords(1600);
  const inBandQc = runQc(inBandArticle, floorBrief);
  check("a 1600-word article (within 1500-1875) does not fail on length", !inBandQc.defects.some((d) => d.includes("word") && (d.includes("floor") || d.includes("ceiling") || d.includes("above the"))), inBandQc.defects);

  const overArticle = articleOfWords(2000);
  const overQc = runQc(overArticle, floorBrief);
  check("a 2000-word article (over the 1875 ceiling) fails on length the other way", overQc.defects.some((d) => d.includes("above the")), overQc.defects);

  // The repair-round instruction itself names the exact deficit.
  const underLengthNote = underLength(shortArticle, floorBrief);
  check("underLength() is empty once the floor is met", underLength(inBandArticle, floorBrief) === "");
  check("underLength() names the exact word deficit for a short draft", /short of the 1500-word floor/.test(underLengthNote) && /Add AT LEAST 2\d\d words/.test(underLengthNote), underLengthNote);

  // isBetterDraft: on a tied defect count, a draft under the floor never beats one that clears it.
  const tiedQcResult = (defectCount: number) => ({
    defects: Array.from({ length: defectCount }, (_, i) => `defect ${i}`),
    warnings: [],
    pass: defectCount === 0,
    computed: { wordCount: 0, sections: 0, externalLinks: 0, internalLinks: 0, fillerHits: 0, longestParagraphSentences: 0, charts: 0, tables: 0, callouts: 0, images: 0 },
  });
  const underFloorDraft = { article: shortArticle, qc: tiedQcResult(1) };
  const meetsFloorDraft = { article: inBandArticle, qc: tiedQcResult(1) };
  check("on a tie, a draft that meets the floor beats one that doesn't", isBetterDraft(meetsFloorDraft, underFloorDraft, floorBrief) === true);
  check("…and the reverse is never true", isBetterDraft(underFloorDraft, meetsFloorDraft, floorBrief) === false);
  const fewerDefectsButShort = { article: shortArticle, qc: tiedQcResult(0) };
  check("defect count still wins over the floor when they're not actually tied", isBetterDraft(fewerDefectsButShort, meetsFloorDraft, floorBrief) === true);
}

// ---------------------------------------------------------------------------
// LinkedIn Poster / X Poster / Meta Poster (2026-09-14 Social module rebuild). Only the pure
// staging/scheduling/validation logic is testable without a live database or a real Graph API
// call — see lib/agent-handlers/social-poster-shared.ts and meta-poster-delivery.ts.
// ---------------------------------------------------------------------------
{
  // computeScheduledTimes: deterministic given startAt, spaced by cadence, on the chosen hour.
  const startAt = new Date("2026-09-14T00:00:00.000Z");
  // Days apart is checked on the calendar date, not exact milliseconds: every post lands on the
  // same configured hour, but minutes are staggered a little per post (see the function's doc
  // comment) so a batch never lands on the exact same hour:00 for every entry.
  const dayOf = (d: Date) => Math.floor(d.getTime() / (24 * 60 * 60 * 1000));
  const dailyTimes = computeScheduledTimes({ batchSize: 3, frequency: "Daily", startAt });
  check("computeScheduledTimes: Daily spaces posts exactly 1 day apart", dailyTimes.length === 3 &&
    dayOf(dailyTimes[1]!) - dayOf(dailyTimes[0]!) === 1 &&
    dayOf(dailyTimes[2]!) - dayOf(dailyTimes[1]!) === 1, dailyTimes);
  check("computeScheduledTimes: every post lands after startAt", dailyTimes.every((d) => d.getTime() > startAt.getTime()), dailyTimes);

  const weeklyTimes = computeScheduledTimes({ batchSize: 2, frequency: "Weekly", startAt });
  check("computeScheduledTimes: Weekly spaces posts 7 days apart", dayOf(weeklyTimes[1]!) - dayOf(weeklyTimes[0]!) === 7, weeklyTimes);

  const windowedTimes = computeScheduledTimes({ batchSize: 1, frequency: "Daily", window: "Morning (7-9 AM)", startAt });
  check("computeScheduledTimes: a posting window sets the scheduled hour", windowedTimes[0]!.getHours() === 8, windowedTimes);

  check("computeScheduledTimes: batchSize 0 returns no times", computeScheduledTimes({ batchSize: 0, frequency: "Daily", startAt }).length === 0);

  // validateSocialAccount: workspace / platform / expired, in that order, and the happy path.
  const now = new Date("2026-09-14T12:00:00.000Z");
  const goodAccount = { id: "acct_1", workspaceId: "ws_1", platform: "LINKEDIN" as const, expiresAt: new Date("2026-12-01T00:00:00.000Z") };
  check("validateSocialAccount: a live account in the right workspace/platform is ok", validateSocialAccount(goodAccount, { workspaceId: "ws_1", platform: "LINKEDIN", now }).ok === true);
  check("validateSocialAccount: null account (not found/not selected) fails with not_found", validateSocialAccount(null, { workspaceId: "ws_1", platform: "LINKEDIN", now }).ok === false);
  const wrongWorkspace = validateSocialAccount(goodAccount, { workspaceId: "ws_other", platform: "LINKEDIN", now });
  check("validateSocialAccount: an account from a different workspace is rejected", !wrongWorkspace.ok && wrongWorkspace.code === "wrong_workspace", wrongWorkspace);
  const wrongPlatform = validateSocialAccount(goodAccount, { workspaceId: "ws_1", platform: "TWITTER_X", now });
  check("validateSocialAccount: a LinkedIn account offered against TWITTER_X is rejected", !wrongPlatform.ok && wrongPlatform.code === "wrong_platform", wrongPlatform);
  const expiredAccount = { ...goodAccount, expiresAt: new Date("2026-01-01T00:00:00.000Z") };
  const expired = validateSocialAccount(expiredAccount, { workspaceId: "ws_1", platform: "LINKEDIN", now });
  check("validateSocialAccount: an expired token is rejected with a reconnect hint", !expired.ok && expired.code === "expired" && /reconnect/i.test(expired.hint), expired);

  // postsStillToCreate: idempotency for socialPosterOnApprove — a post already in `alreadyCreated`
  // is never returned again, so re-approval never creates a duplicate SocialPost.
  const pending = [
    { id: "post_1", content: "one", scheduledAt: "2026-09-15T09:00:00.000Z" },
    { id: "post_2", content: "two", scheduledAt: "2026-09-16T09:00:00.000Z" },
  ];
  check("postsStillToCreate: nothing created yet returns everything", postsStillToCreate(pending, {}).length === 2);
  const partiallyCreated = postsStillToCreate(pending, { post_1: "sp_abc" });
  check("postsStillToCreate: a post already created is excluded", partiallyCreated.length === 1 && partiallyCreated[0]!.id === "post_2", partiallyCreated);
  check("postsStillToCreate: everything already created returns nothing (fully idempotent)", postsStillToCreate(pending, { post_1: "sp_a", post_2: "sp_b" }).length === 0);

  // publishMetaBatch: no network calls when nothing matches the target platform, and idempotent —
  // a post already "published" or "manual" is left untouched and not re-counted.
  const metaPosts: MetaStagedPost[] = [
    { id: "m1", platform: "Facebook", surface: "feed", caption: "hello", status: "pending" },
    { id: "m2", platform: "Instagram", surface: "feed", caption: "no image", status: "pending" },
    { id: "m3", platform: "Facebook", surface: "feed", caption: "already went out", status: "published", fbPostId: "fb_1" },
  ];
  const creds = { page_access_token: "tok", page_id: "pg_1", page_name: "Test Page", ig_user_id: "ig_1" };
  let fetchCalls = 0;
  const fakeFetch = (async (url: string) => {
    fetchCalls++;
    return new Response(JSON.stringify({ id: "posted_123" }), { status: 200 });
  }) as unknown as typeof fetch;
  const metaResult = await publishMetaBatch(metaPosts, creds, "Both", { fetchImpl: fakeFetch });
  check("publishMetaBatch: the already-published post is untouched and not re-fetched", metaResult.posts.find((p) => p.id === "m3")?.fbPostId === "fb_1");
  check("publishMetaBatch: a Facebook feed post publishes and is counted", metaResult.posts.find((p) => p.id === "m1")?.status === "published");
  check("publishMetaBatch: an Instagram feed post with no imageUrl is marked manual, not published", metaResult.posts.find((p) => p.id === "m2")?.status === "manual");
  check("publishMetaBatch: publishedCount reflects m1 (new) and m3 (already published)", metaResult.publishedCount === 2, metaResult.publishedCount);
  check("publishMetaBatch: only one network call — m2 needed no fetch and m3 was skipped", fetchCalls === 1, fetchCalls);
  check("isMetaBatchSettled: true once nothing is left pending", isMetaBatchSettled(metaResult.posts) === true);
  check("isMetaBatchSettled: false while any post is still pending", isMetaBatchSettled(metaPosts) === false);
  check("isMetaBatchSettled: an empty batch is not considered settled", isMetaBatchSettled([]) === false);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

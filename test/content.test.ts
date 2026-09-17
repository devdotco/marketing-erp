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
import { googleProofAction } from "@/lib/security/google-proof";
import { buildResearchAsk } from "@/lib/content/research";
import { domainList } from "@/lib/content/domains";
import { isPrivateAddress } from "@/lib/integrations/public-url";
import { payloadPostUrl, rankInternalLinkCandidates } from "@/lib/integrations/payload";
import {
  collectionNameProblem,
  elevatedRole,
  mediaCollectionOptions,
  normalisePayloadBaseUrl,
  parseAccessCollections,
  postsCollectionOptions,
  sniffBodyFormat,
  suggestMediaCollection,
  suggestPostsCollection,
  tenantOptions,
  tenantOptionsFromUser,
} from "@/lib/integrations/payload-discovery";
import { discoverPayload } from "@/lib/integrations/payload-discover";
import { getPreset, resolveProfile, NEUTRAL_PROFILE } from "@/lib/content/editorial";
import { isDesignatedForPlatformKey, platformKeyEligibility } from "@/lib/ai/client";
import { normaliseArticle, renderHtml, replaceImageSrc, SUBMIT_ARTICLE_TOOL, submittedFields } from "@/lib/content/article";
import { lengthBand } from "@/lib/content/brief";
import { underLength } from "@/lib/content/draft";
import { isBetterDraft } from "@/lib/content/pipeline";
import { AGENTS } from "@/lib/agents";
import { AGENT_META } from "@/lib/agent-metadata";
import { applyRenamedInputs } from "@/lib/agent-handlers/renamed-inputs";
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
  resolveScoringWeights,
  computeWeightedTotal,
  DEFAULT_SCORING_WEIGHTS,
  type ScoringDimension,
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
  buildCrmEngagement,
  crmRefusalHint,
  wantsDeal,
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
import {
  buildGoogleAdsHeaders,
  googleAdsAccountValue,
  googleAdsError,
  GoogleAdsApiError,
  googleAdsSearchStream,
  listGoogleAdsAccounts,
  matchGoogleAdsOption,
  parseGoogleAdsAccountValue,
  sameGoogleAdsChoice,
} from "@/lib/integrations/google-ads";
import { GOOGLE_RESOURCES, findResourceOption } from "@/lib/integrations/google-resources";
import { AgentInputError } from "@/lib/ai/errors";
import { CONNECT_METHODS } from "@/lib/integrations/catalog";
import { SETUP_GUIDES } from "@/lib/integrations/guides";
import { constantTimeEqual } from "@/lib/security/compare";
import { adminSeedGate } from "@/lib/security/admin-seed";
import { canInviteRole } from "@/lib/security/invite-roles";
import { resolveInviter } from "@/lib/security/invite-authority";
import {
  allowUnsignedWebhooks,
  generateWebhookToken,
  isWebhookProvider,
  parseWebhookToken,
  webhookAuthMode,
} from "@/lib/security/webhook-token";
import {
  dedupeKey,
  linkedInSlug,
  parseAimfoxPayload,
  parseInstantlyPayload,
  pickProspect,
  processWebhook,
  prospectUpdatesFor,
  type OutboundStatus,
  type ParsedWebhook,
  type ProspectCandidate,
  type ProspectUpdate,
  type WebhookDeps,
} from "@/lib/webhooks/outbound-events";
import { planChannelPause, PAUSE_TRIGGER_EVENTS, type PauseCandidate } from "@/lib/webhooks/outbound-pause";
import {
  buildPlaySlices,
  buildSliceRows,
  personaBucket,
  scoreBand,
  MIN_SLICE_SAMPLE_SIZE,
  type SliceInputProspect,
} from "@/lib/agent-handlers/outbound-cro";
import {
  buildGoogleTtsRequest,
  chunkDialogue,
  chunkNarration,
  cleanScriptForSpeech,
  concatPcm,
  describeGoogleError,
  dialogueSpeakers,
  googleTtsCostUsd,
  googleTtsModelId,
  googleVoiceName,
  GOOGLE_TTS_MODEL_OPTIONS,
  GOOGLE_VOICE_OPTIONS,
  parseDialogue,
  parseGoogleTtsResponse,
  planGoogleTtsChunks,
  synthesizeGoogleSpeech,
  verifyGoogleTtsKey,
} from "@/lib/voice/google-tts";
import { encodeMp3 } from "@/lib/voice/mp3";
import { scriptForSpeech, selectVoiceProvider, voiceProviderChoice, VOICE_PROVIDER_OPTIONS } from "@/lib/voice/provider";
import { KEY_VERIFIERS } from "@/lib/integrations/verify";

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
    "blog-writer", // false positive: reads flow through lib/content/brief.ts's buildBrief(), not inline — see doc comment above.
    // ad-creative, captions-clips, content-refresh, digital-pr, internal-linking, landing-page-copy,
    // newsletter, on-site-publisher, podcast, repurposer, schema, short-form, topic-planner,
    // video-script, youtube: reconciled 2026-09-14; old input names still honoured via
    // lib/agent-handlers/renamed-inputs.ts.
    // community, email-marketing, inbox-responder, lead-enrichment, onboarder, operator, outreach,
    // prospector, proposal, x-engager: reconciled 2026-09-14; old input names still honoured via
    // lib/agent-handlers/renamed-inputs.ts.
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

// 12b. Renamed inputs: an old key saved before a form/handler reconciliation still reaches the
// handler under the new name, but never beats a value supplied under the new name, and a select
// never accepts a label outside its current options.
{
  const renamedRun = (slug: string, input: Record<string, unknown>, saved: Record<string, unknown>) =>
    ({ input, agentConfig: { agentSlug: slug, config: saved } }) as unknown as Parameters<typeof resolveInputs>[0];

  const r1 = renamedRun("outreach", {}, { pitchAngle: "our churn study", sequenceLength: "4", dailyLimit: 12 });
  const c1 = applyRenamedInputs(r1, resolveInputs(r1), {
    yourPitch: "pitchAngle",
    followUpCount: { from: "sequenceLength", map: (v: unknown) => Number(v) - 1 },
    dailySendLimit: "dailyLimit",
  });
  check("a saved old key reaches the new name over its metadata default", c1.yourPitch === "our churn study" && c1.dailySendLimit === 12, c1);
  check("a mapped rename converts the old value (sequenceLength 4 → 3 follow-ups)", c1.followUpCount === 3, c1);

  const r2 = renamedRun("outreach", { dailySendLimit: "25" }, { dailyLimit: 12 });
  const c2 = applyRenamedInputs(r2, resolveInputs(r2), { dailySendLimit: "dailyLimit" });
  check("a value typed under the new name beats a saved old key", c2.dailySendLimit === 25, c2);

  const r3 = renamedRun("x-engager", {}, { replyStyle: "Informative", requireHumanApproval: "false" });
  const c3 = applyRenamedInputs(r3, resolveInputs(r3), { replyTone: "replyStyle", requireApproval: "requireHumanApproval" });
  check("an old select label that no longer exists falls back to the default", c3.replyTone === "Conversational", c3);
  check("an old boolean key is coerced under the new name", c3.requireApproval === false, c3);
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

  // No Instantly integration connected → refuse (2026-09-17: this used to fabricate an
  // `instantly_...` lead id and report the send as successful — see outbound-email-delivery.ts's
  // doc comment for why that's worse than no send for a real campaign). Still no network call.
  let simEmailCalls = 0;
  let simEmailErr: unknown = null;
  try {
    await activateOutboundEmailDelivery(
      { ...emailDelivery, connected: false },
      { addLead: async () => { simEmailCalls++; return { id: "x" }; } },
    );
  } catch (e) {
    simEmailErr = e;
  }
  check(
    "activateOutboundEmailDelivery refuses (no network call, no fabricated id) when Instantly isn't connected",
    simEmailCalls === 0 && simEmailErr instanceof AgentInputError && simEmailErr.code === "instantly_not_connected",
    simEmailErr,
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

  // No Aimfox integration connected → refuse, same reasoning as the Instantly case above. Still no
  // network call.
  let simLiCalls = 0;
  let simLiErr: unknown = null;
  try {
    await activateOutboundLinkedinDelivery(
      { ...liDelivery, connected: false },
      { addProfile: async () => { simLiCalls++; return {}; } },
    );
  } catch (e) {
    simLiErr = e;
  }
  check(
    "activateOutboundLinkedinDelivery refuses (no network call, no fabricated id) when Aimfox isn't connected",
    simLiCalls === 0 && simLiErr instanceof AgentInputError && simLiErr.code === "aimfox_not_connected",
    simLiErr,
  );

  // --- Outbound Revenue / erp.io CRM ------------------------------------------------------

  const engagementProspect = {
    id: "prospect_3",
    firstName: "Sam",
    lastName: "Lee",
    email: "sam@beta.com",
    title: "VP Engineering",
    company: "Beta Co",
    companyDomain: "beta.com",
    linkedInUrl: "https://linkedin.com/in/samlee",
    score: 84,
    channel: "EMAIL_AND_LINKEDIN",
    play: { slug: "saas", name: "SaaS founders" },
    intelligence: { painHypothesis: "Shipping slowly", primarySignal: "Hiring 3 engineers" },
  };

  const engagement = buildCrmEngagement({
    prospect: engagementProspect,
    event: "meeting_booked",
    runId: "run_9",
    occurredAt: new Date("2026-09-17T10:00:00.000Z"),
    replyText: "Happy to chat Thursday.",
    writing: { note: "Booked a meeting for Thursday.", dealName: "Beta Co — dev pod", tags: ["Outbound", "hiring"], replyDraft: "Thursday works." },
    play: { crmDealOn: "interested", crmPipelineId: "pipe_1" },
  });
  check(
    "CRM engagement carries the prospect, the play and the run as its idempotency key",
    engagement.prospectId === "prospect_3" && engagement.eventKey === "run_9" && engagement.play.slug === "saas",
    engagement,
  );
  check(
    "CRM engagement passes the contact through with tags normalised",
    engagement.contact.email === "sam@beta.com" && engagement.contact.companyDomain === "beta.com" && engagement.contact.tags?.[0] === "outbound",
    engagement.contact,
  );
  check("CRM engagement asks for a deal in the play's pipeline", engagement.deal?.create === true && engagement.deal?.pipelineId === "pipe_1", engagement.deal);

  // A bare reply is often "take me off your list". Under the default setting it still writes the
  // contact and the timeline entry, but it does not open a deal.
  check("wantsDeal: interest and meetings always open a deal", wantsDeal("interested", "interested") && wantsDeal("meeting_booked", "interested"));
  check("wantsDeal: a bare reply does not, by default", !wantsDeal("email_reply", "interested") && !wantsDeal("linkedin_reply", "interested"));
  check("wantsDeal: unless the play says any reply should", wantsDeal("email_reply", "reply"));
  const replyEngagement = buildCrmEngagement({
    prospect: engagementProspect,
    event: "email_reply",
    runId: "run_10",
    occurredAt: new Date("2026-09-17T10:00:00.000Z"),
    writing: {},
    play: { crmDealOn: "interested" },
  });
  check("CRM engagement for a bare reply opens no deal", replyEngagement.deal?.create === false, replyEngagement.deal);

  // Approval is the only thing that writes to the CRM, and it is safe to repeat: an
  // already-activated delivery never calls again, and the CRM answers a repeat with duplicate:true.
  const stagedRev: OutboundRevenueDelivery = { status: "staged", prospectId: "prospect_3", event: "meeting_booked", engagement };
  const target = { baseUrl: "https://app.erp.io/crm", auth: { kind: "service" as const, shellOrgId: "org_1" } };
  let crmCalls = 0;
  const activatedRev = await activateOutboundRevenueDelivery(stagedRev, {
    target,
    via: "service",
    record: async () => {
      crmCalls++;
      return new Response(
        JSON.stringify({
          personId: "person_1",
          dealId: "deal_1",
          taskId: "task_1",
          pipeline: { id: "pipe_1", name: "Outbound" },
          stage: { key: "meeting_set", name: "Meeting Set" },
          duplicate: false,
          warnings: [],
        }),
        { status: 201 },
      );
    },
  });
  check(
    "activateOutboundRevenueDelivery records the CRM's own ids",
    crmCalls === 1 && activatedRev.crmPersonId === "person_1" && activatedRev.crmDealId === "deal_1" && activatedRev.stageName === "Meeting Set",
    activatedRev,
  );

  let crmCallsAgain = 0;
  const reActivated = await activateOutboundRevenueDelivery(activatedRev, {
    target,
    via: "service",
    record: async () => { crmCallsAgain++; return new Response("{}", { status: 201 }); },
  });
  check(
    "activateOutboundRevenueDelivery skips an already-activated delivery entirely — no CRM call",
    crmCallsAgain === 0 && reActivated === activatedRev,
    reActivated,
  );

  // A refusal is legible and never a fabricated success — the GoHighLevel version simulated a
  // contact id when the integration was missing, and the run looked like it had worked.
  let refusalMessage = "";
  try {
    await activateOutboundRevenueDelivery(stagedRev, {
      target,
      via: "service",
      record: async () => new Response(JSON.stringify({ error: "Unauthorized", code: "unauthorized" }), { status: 401 }),
    });
  } catch (err) {
    refusalMessage = err instanceof Error ? err.message : String(err);
  }
  check("activateOutboundRevenueDelivery throws a legible error when the CRM refuses", refusalMessage.includes("401"), refusalMessage);
  check(
    "crmRefusalHint names the signing key for a signed 401, and the pipeline for a missing one",
    crmRefusalHint(401, "unauthorized", "service").includes("MARKETING_SERVICE_PUBLIC_KEY") &&
      crmRefusalHint(404, "pipeline_not_found", "service").includes("Outbound Engine → Plays"),
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
// Scoring weights (lib/agent-handlers/outbound-play-config.ts) — resolveScoringWeights turns a
// play's (partial, possibly-unbalanced) scoringWeights into the six integer maxima the Strategist's
// prompt and tool schema use, always summing to exactly 100; computeWeightedTotal recomputes a
// scored prospect's total from its raw dimension scores, clamped to those maxima. Both are
// deliberately pure/no-network so the normalisation math — the part most likely to have an
// off-by-one — is checked here rather than only by eyeballing a live run.
// ---------------------------------------------------------------------------
{
  const defaultsOnly = resolveScoringWeights({});
  check(
    "resolveScoringWeights: no overrides returns DEFAULT_SCORING_WEIGHTS untouched (already sums to 100)",
    defaultsOnly.signal === 25 && defaultsOnly.serviceFit === 20 && defaultsOnly.firmographic === 25 &&
      defaultsOnly.persona === 15 && defaultsOnly.timing === 10 && defaultsOnly.dataQuality === 5,
    defaultsOnly,
  );
  check(
    "resolveScoringWeights: undefined/null input behaves the same as {}",
    JSON.stringify(resolveScoringWeights(undefined)) === JSON.stringify(defaultsOnly) &&
      JSON.stringify(resolveScoringWeights(null)) === JSON.stringify(defaultsOnly),
  );

  const sumTo100 = (w: Record<ScoringDimension, number>) => Object.values(w).reduce((a: number, b: number) => a + b, 0);
  check("resolveScoringWeights: always sums to exactly 100 for the defaults", sumTo100(defaultsOnly) === 100, defaultsOnly);

  // A play that only raised `timing` (25 instead of the default 10) — every dimension's weight
  // (not just the one that changed) shifts a little once normalised, since the other five now make
  // up a smaller share of a bigger pre-normalisation sum (115 instead of 100).
  const timingHeavy = resolveScoringWeights({ timing: 25 });
  check("resolveScoringWeights: one raised dimension still sums to exactly 100", sumTo100(timingHeavy) === 100, timingHeavy);
  check("resolveScoringWeights: the raised dimension's normalised share grows relative to its old default", timingHeavy.timing > defaultsOnly.timing, timingHeavy);

  // Weights that don't sum to 100 at all — the case the running total in PlaysManager.tsx warns
  // about. Still always normalises to exactly 100, never silently left at the raw sum.
  const lopsided = resolveScoringWeights({ signal: 10, serviceFit: 10, firmographic: 10, persona: 10, timing: 10, dataQuality: 5 }); // raw sum 55
  check("resolveScoringWeights: a raw sum far from 100 still normalises to exactly 100", sumTo100(lopsided) === 100, lopsided);

  // Every weight zeroed — normalising would divide by zero, so this falls back to the defaults
  // rather than asking Claude to score six 0-point dimensions.
  const allZero = resolveScoringWeights({ signal: 0, serviceFit: 0, firmographic: 0, persona: 0, timing: 0, dataQuality: 0 });
  check("resolveScoringWeights: all-zero weights fall back to the defaults instead of dividing by zero", JSON.stringify(allZero) === JSON.stringify(defaultsOnly), allZero);

  // A negative or non-finite override is treated as unset (falls back to that dimension's default)
  // rather than propagating a bad value into the prompt/tool schema.
  const badValue = resolveScoringWeights({ signal: -5, serviceFit: NaN });
  check("resolveScoringWeights: a negative override falls back to the default for that dimension", badValue.signal === 25, badValue);
  check("resolveScoringWeights: a NaN override falls back to the default for that dimension", badValue.serviceFit === 20, badValue);

  // computeWeightedTotal: sums six raw dimension scores, clamped to the resolved weights.
  const weights = { signal: 25, serviceFit: 20, firmographic: 25, persona: 15, timing: 10, dataQuality: 5 };
  check(
    "computeWeightedTotal: sums exact-fit dimension scores",
    computeWeightedTotal({ signal: 20, serviceFit: 15, firmographic: 20, persona: 10, timing: 8, dataQuality: 4 }, weights) === 77,
  );
  check(
    "computeWeightedTotal: a dimension score above its weight is clamped down, not left to inflate the total",
    computeWeightedTotal({ signal: 999, serviceFit: 0, firmographic: 0, persona: 0, timing: 0, dataQuality: 0 }, weights) === 25,
  );
  check(
    "computeWeightedTotal: a negative dimension score is clamped to 0, not subtracted",
    computeWeightedTotal({ signal: -10, serviceFit: 20, firmographic: 0, persona: 0, timing: 0, dataQuality: 0 }, weights) === 20,
  );
  check(
    "computeWeightedTotal: a missing/non-numeric dimension score counts as 0 rather than throwing",
    computeWeightedTotal({ signal: 20 }, weights) === 20,
  );
  check(
    "computeWeightedTotal: every dimension maxed out sums to exactly 100 for the default weights",
    computeWeightedTotal(DEFAULT_SCORING_WEIGHTS, DEFAULT_SCORING_WEIGHTS) === 100,
  );
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
  check("planScoutChaining: no prospectIds plans nothing (e.g. a run that matched but revealed no emails)", planScoutChaining({ playSlug: "acme-icp", prospectIds: [] }, autoAdvanceOn) === null);
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

// ─── Security hotfix: webhook tokens (Instantly/Aimfox deliveries were unsigned and matched across workspaces) ───
{
  check("constantTimeEqual: identical secrets match", constantTimeEqual("s3cret-value", "s3cret-value"));
  check("constantTimeEqual: a different secret does not match", !constantTimeEqual("s3cret-value", "s3cret-valuf"));
  check("constantTimeEqual: a prefix of the secret does not match", !constantTimeEqual("s3cret", "s3cret-value"));
  check("constantTimeEqual: empty presented never matches", !constantTimeEqual("", "s3cret-value"));
  check("constantTimeEqual: empty expected never matches (an unset env is not a password of '')", !constantTimeEqual("", ""));
  check("constantTimeEqual: null/undefined never match", !constantTimeEqual(null, undefined));

  const ws = "cmabc123workspace";
  const token = generateWebhookToken(ws);
  check("generateWebhookToken: carries the workspace id it was minted for", parseWebhookToken(token)?.workspaceId === ws, token);
  check("generateWebhookToken: two tokens for the same workspace differ", generateWebhookToken(ws) !== generateWebhookToken(ws));
  check("generateWebhookToken: the secret half is at least 32 bytes of entropy", token.split(".")[1]!.length >= 43, token);
  check("parseWebhookToken: a bare workspace id is not a token", parseWebhookToken(ws) === null);
  check("parseWebhookToken: a short secret is rejected", parseWebhookToken(`${ws}.short`) === null);
  check("parseWebhookToken: path-traversal-ish input is rejected", parseWebhookToken(`../${ws}.${"a".repeat(43)}`) === null);
  check("parseWebhookToken: empty/null rejected", parseWebhookToken("") === null && parseWebhookToken(null) === null);
  check("parseWebhookToken: oversize input rejected", parseWebhookToken(`${ws}.${"a".repeat(300)}`) === null);
  check("a token for workspace A never equals workspace B's token", !constantTimeEqual(token, generateWebhookToken("cmotherworkspace")));
  // The attack: keep workspace A's id, forge the secret — the whole-token compare must fail.
  const forged = `${ws}.${"A".repeat(43)}`;
  check("a forged secret on a real workspace id is parseable but does not verify", parseWebhookToken(forged) !== null && !constantTimeEqual(forged, token));

  check("allowUnsignedWebhooks: off when unset", allowUnsignedWebhooks({}) === false);
  check("allowUnsignedWebhooks: only the literal 'true' turns it on", allowUnsignedWebhooks({ WEBHOOKS_ALLOW_UNSIGNED: "true" }) && !allowUnsignedWebhooks({ WEBHOOKS_ALLOW_UNSIGNED: "1" }) && !allowUnsignedWebhooks({ WEBHOOKS_ALLOW_UNSIGNED: "TRUE" }));
  check("webhookAuthMode: no token, flag off → reject", webhookAuthMode(null, false) === "reject");
  check("webhookAuthMode: no token, flag on → unsigned grace", webhookAuthMode(null, true) === "unsigned-grace");
  check("webhookAuthMode: a presented token is always verified, even with the flag on (a bad token never falls back)", webhookAuthMode("x", true) === "verify" && webhookAuthMode("x", false) === "verify");
  check("isWebhookProvider: Instantly and Aimfox only", isWebhookProvider("INSTANTLY") && isWebhookProvider("AIMFOX") && !isWebhookProvider("APOLLO"));
}

// ─── Security hotfix: every OutboundProspect query is workspace-scoped ───
// outbound-revenue and on-approve looked prospects up (and wrote them) by id alone, and the id
// arrives in run.input, which any OPERATOR controls. This scans every call site's `where` for a
// workspaceId so a new unscoped lookup fails here rather than in another tenant's data.
{
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".git", "coverage", "test"]);
  const callRe = /outboundProspect\s*\.\s*(findUnique|findFirst|findMany|update|updateMany|delete|deleteMany|upsert|count|groupBy)\s*\(/g;
  const unscoped: string[] = [];
  let scanned = 0;
  function whereOf(text: string, from: number): string | null {
    const w = text.indexOf("where:", from);
    if (w === -1 || w - from > 400) return null;
    const open = text.indexOf("{", w);
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
    }
    return null;
  }
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (![".ts", ".tsx"].includes(path.extname(entry.name))) continue;
      const text = readFileSync(full, "utf8");
      for (const m of text.matchAll(callRe)) {
        scanned++;
        const where = whereOf(text, m.index! + m[0].length);
        if (!where || !/workspaceId/.test(where)) {
          unscoped.push(`${path.relative(repoRoot, full)}:${text.slice(0, m.index).split("\n").length}`);
        }
      }
    }
  }
  walk(path.join(repoRoot, "lib"));
  walk(path.join(repoRoot, "app"));
  check("prospect scoping: the scan found the outbound call sites", scanned >= 15, scanned);
  check("prospect scoping: every OutboundProspect query/write filters by workspaceId", unscoped.length === 0, unscoped);
}

// ─── Security hotfix: /api/admin/seed gate (public route, query-string secret, NEXTAUTH_SECRET fallback) ───
{
  const strong = "x".repeat(40);
  check("adminSeedGate: production without ALLOW_ADMIN_SEED is 404 even with the right secret", adminSeedGate({ NODE_ENV: "production", ADMIN_SEED_SECRET: strong }, strong) === "not_found");
  check("adminSeedGate: production with ALLOW_ADMIN_SEED=true and the right secret is ok", adminSeedGate({ NODE_ENV: "production", ALLOW_ADMIN_SEED: "true", ADMIN_SEED_SECRET: strong }, strong) === "ok");
  check("adminSeedGate: ALLOW_ADMIN_SEED must be exactly 'true'", adminSeedGate({ NODE_ENV: "production", ALLOW_ADMIN_SEED: "1", ADMIN_SEED_SECRET: strong }, strong) === "not_found");
  check("adminSeedGate: no ADMIN_SEED_SECRET is 404 — NEXTAUTH_SECRET is not a fallback", adminSeedGate({ NODE_ENV: "development", NEXTAUTH_SECRET: strong, SEED_SECRET: strong }, strong) === "not_found");
  check("adminSeedGate: a short ADMIN_SEED_SECRET is refused (404)", adminSeedGate({ NODE_ENV: "development", ADMIN_SEED_SECRET: "short" }, "short") === "not_found");
  check("adminSeedGate: wrong secret is 403", adminSeedGate({ NODE_ENV: "development", ADMIN_SEED_SECRET: strong }, strong + "y") === "forbidden");
  check("adminSeedGate: missing header is 403", adminSeedGate({ NODE_ENV: "development", ADMIN_SEED_SECRET: strong }, null) === "forbidden");
  check("adminSeedGate: right secret outside production is ok", adminSeedGate({ NODE_ENV: "development", ADMIN_SEED_SECRET: strong }, strong) === "ok");
}

// ─── Security hotfix: invitation roles (any string, SUPER_ADMIN included, was stored) ───
{
  const admin = { role: "WORKSPACE_ADMIN", isSuperAdmin: false };
  check("canInviteRole: an admin may invite VIEWER, OPERATOR and WORKSPACE_ADMIN", canInviteRole("VIEWER", admin) && canInviteRole("OPERATOR", admin) && canInviteRole("WORKSPACE_ADMIN", admin));
  check("canInviteRole: nobody may invite SUPER_ADMIN — not an admin", !canInviteRole("SUPER_ADMIN", admin));
  check("canInviteRole: nobody may invite SUPER_ADMIN — not even a platform super admin", !canInviteRole("SUPER_ADMIN", { role: "SUPER_ADMIN", isSuperAdmin: true }));
  check("canInviteRole: unknown / lowercase / non-string roles are refused", !canInviteRole("OWNER", admin) && !canInviteRole("viewer", admin) && !canInviteRole(["VIEWER"], admin) && !canInviteRole(undefined, admin));
  check("canInviteRole: an OPERATOR cannot invite at all", !canInviteRole("VIEWER", { role: "OPERATOR", isSuperAdmin: false }));
  check("canInviteRole: a VIEWER cannot invite at all", !canInviteRole("VIEWER", { role: "VIEWER", isSuperAdmin: false }));
  check("canInviteRole: a non-member cannot invite", !canInviteRole("VIEWER", { role: null, isSuperAdmin: false }));
  check("canInviteRole: a platform super admin with no membership may invite up to WORKSPACE_ADMIN", canInviteRole("WORKSPACE_ADMIN", { role: null, isSuperAdmin: true }));
}

// ─── Invitations: platform super admin is DB-derived, not the always-false session flag ───
{
  const db = (opts: { superAdmin: boolean; memberRole: string | null; workspace?: boolean }) => ({
    workspaceMember: {
      findFirst: async (args: { where: { userId: string; role: "SUPER_ADMIN" } }) => (opts.superAdmin && args.where.role === "SUPER_ADMIN" ? { id: "sa" } : null),
      findUnique: async () => (opts.memberRole ? { role: opts.memberRole } : null),
    },
    workspace: { findUnique: async () => (opts.workspace === false ? null : { id: "ws" }) },
  });
  const platformOp = await resolveInviter("u-op", "ws", db({ superAdmin: true, memberRole: null }));
  check("resolveInviter: a platform super admin (SUPER_ADMIN row in the DB) with no membership may invite", platformOp.mayInvite && platformOp.isSuperAdmin, platformOp);
  check("resolveInviter: …and up to WORKSPACE_ADMIN, but still never SUPER_ADMIN", canInviteRole("WORKSPACE_ADMIN", platformOp) && !canInviteRole("SUPER_ADMIN", platformOp));
  const admin = await resolveInviter("u-a", "ws", db({ superAdmin: false, memberRole: "WORKSPACE_ADMIN" }));
  check("resolveInviter: a workspace admin may invite, not as a super admin", admin.mayInvite && !admin.isSuperAdmin && admin.role === "WORKSPACE_ADMIN", admin);
  const operator = await resolveInviter("u-o", "ws", db({ superAdmin: false, memberRole: "OPERATOR" }));
  check("resolveInviter: an OPERATOR member may not invite", !operator.mayInvite, operator);
  const stranger = await resolveInviter("u-x", "ws", db({ superAdmin: false, memberRole: null }));
  check("resolveInviter: a non-member who is not a super admin may not invite", !stranger.mayInvite, stranger);
  const ghost = await resolveInviter("u-op", "missing", db({ superAdmin: true, memberRole: null, workspace: false }));
  check("resolveInviter: not even a super admin invites into a workspace that does not exist", !ghost.mayInvite, ghost);
  check("resolveInviter: nobody without a user id", !(await resolveInviter(null, "ws", db({ superAdmin: true, memberRole: "WORKSPACE_ADMIN" }))).mayInvite);
  const route = readFileSync(path.join(process.cwd(), "app/api/invitations/route.ts"), "utf8");
  check("invitations route: no longer reads session.user.isSuperAdmin", !/isSuperAdmin:\s*Boolean\(|session\.user\.isSuperAdmin/.test(route));
  check("invitations route: gates on resolveInviter and keeps the canInviteRole allowlist", /await resolveInviter\(session\.user\.id, workspaceId\)/.test(route) && /canInviteRole\(role, \{ role: inviter\.role, isSuperAdmin: inviter\.isSuperAdmin \}\)/.test(route));
  check("invitation-authority: super admin comes from isPlatformSuperAdmin", /isPlatformSuperAdmin\(userId, db\)/.test(readFileSync(path.join(process.cwd(), "lib/security/invite-authority.ts"), "utf8")));
}

// Payload two-step connect: discovery parsing, no network (fake fetch, stubbed DNS guard).
{
  // /api/access as Payload 3 actually sends it: sanitizePermissions turns
  // { permission: true } into `true`, deletes denied operations, and keeps a
  // `where` for query-constrained (tenant-scoped) access.
  const accessBody = {
    canAccessAdmin: true,
    collections: {
      posts: { create: true, read: true, update: true, delete: true, fields: true },
      tenants: { read: { permission: true, where: { id: { in: [3] } } } },
      users: { read: true, update: true },
      media: { read: true, create: true },
      secrets: { fields: { name: true } },
      legacy: { read: { permission: false } },
      "payload-preferences": { read: true, create: true },
    },
  };
  const collections = parseAccessCollections(accessBody) ?? [];
  check(
    "parseAccessCollections: only readable, non-internal collections survive",
    collections.map((c) => c.slug).join(",") === "media,posts,tenants,users",
    collections.map((c) => c.slug),
  );
  check("parseAccessCollections: a `where` constraint is readable but marked scoped", collections.find((c) => c.slug === "tenants")?.scoped === true);
  check("parseAccessCollections: create permission is carried through", collections.find((c) => c.slug === "posts")?.create === true);
  check("parseAccessCollections: a body that isn't an access map is null (fall back to free text)", parseAccessCollections({ message: "Not Found" }) === null);
  check("parseAccessCollections: an access map with nothing allowed is an empty list, not null", parseAccessCollections({ canAccessAdmin: true })?.length === 0);

  const postsOptions = postsCollectionOptions(collections, "users");
  check("postsCollectionOptions: excludes the auth and tenants collections", !postsOptions.includes("users") && !postsOptions.includes("tenants"), postsOptions);
  check("suggestPostsCollection: defaults to posts", suggestPostsCollection(postsOptions) === "posts");
  check("suggestPostsCollection: falls back to a post-like name", suggestPostsCollection(["pages", "blog-articles"]) === "blog-articles");
  check("suggestPostsCollection: nothing post-like → no guess", suggestPostsCollection(["pages"]) === null);
  const mediaOptions = mediaCollectionOptions(collections, "users");
  check("mediaCollectionOptions: only collections the key can create in", mediaOptions.join(",") === "media,posts", mediaOptions);
  check("suggestMediaCollection: defaults to media", suggestMediaCollection(mediaOptions) === "media");

  const tenants = tenantOptions([
    { id: 12, name: "Investment Bank", slug: "ib", primaryDomain: "investmentbank.com" },
    { id: 3, name: "DEV.co", slug: "dev-co", siteUrl: "https://dev.co/" },
    { id: "7", slug: "no-domain" },
    { name: "no id" },
  ]);
  check("tenantOptions: docs without an id are dropped", tenants.length === 3, tenants);
  check("tenantOptions: label is \"Name — domain\" and value is the id", tenants.some((t) => t.id === "12" && t.label === "Investment Bank — investmentbank.com"), tenants);
  check("tenantOptions: a bare domain becomes an https site URL", tenants.find((t) => t.id === "12")?.siteUrl === "https://investmentbank.com");
  check("tenantOptions: an explicit siteUrl is used and its trailing slash dropped", tenants.find((t) => t.id === "3")?.siteUrl === "https://dev.co" && tenants.find((t) => t.id === "3")?.label === "DEV.co — dev.co", tenants.find((t) => t.id === "3"));
  check("tenantOptions: no name or domain falls back to the slug, with no site URL", tenants.find((t) => t.id === "7")?.label === "no-domain" && tenants.find((t) => t.id === "7")?.siteUrl === null, tenants.find((t) => t.id === "7"));

  const htmlSniff = sniffBodyFormat({ id: 1, bodyHtml: "<p>Hello</p>", content: { root: { children: [] } } });
  check("sniffBodyFormat: populated bodyHtml string → html, even alongside Lexical", htmlSniff.bodyFormat === "html" && htmlSniff.bodyField === "bodyHtml" && htmlSniff.source === "content", htmlSniff);
  const emptyHtml = sniffBodyFormat({ id: 1, bodyHtml: null, content: { root: { children: [] } } });
  check("sniffBodyFormat: an empty bodyHtml field still wins (only HTML can be published into)", emptyHtml.bodyFormat === "html" && emptyHtml.bodyField === "bodyHtml" && emptyHtml.source === "field", emptyHtml);
  const lexical = sniffBodyFormat({ id: 1, title: "x", content: { root: { type: "root", children: [] } } });
  check("sniffBodyFormat: a {root} object → lexical in that field", lexical.bodyFormat === "lexical" && lexical.bodyField === "content", lexical);
  const htmlContent = sniffBodyFormat({ id: 1, content: "<p>Hi</p>" });
  check("sniffBodyFormat: a string `content` field → html content", htmlContent.bodyFormat === "html" && htmlContent.bodyField === "content", htmlContent);
  const nothing = sniffBodyFormat(undefined);
  check("sniffBodyFormat: no post → html/bodyHtml default, flagged as a default", nothing.bodyFormat === "html" && nothing.bodyField === "bodyHtml" && nothing.source === "default", nothing);

  check("collectionNameProblem: a post slug is called out as one", /post slug/.test(collectionNameProblem("ai-virtual-data-room") ?? ""), collectionNameProblem("ai-virtual-data-room"));
  check("collectionNameProblem: posts is fine", collectionNameProblem("posts") === null);
  check("collectionNameProblem: a single-hyphen collection name isn't flagged without a list", collectionNameProblem("reusable-blocks") === null);
  check("collectionNameProblem: a pasted URL is called out", /URL/.test(collectionNameProblem("https://payload.dev.co/api/posts") ?? ""));
  check("collectionNameProblem: against a known list, an unknown name lists what's readable", /posts, pages/.test(collectionNameProblem("articles", ["posts", "pages"]) ?? ""), collectionNameProblem("articles", ["posts", "pages"]));

  const adminUrl = normalisePayloadBaseUrl("https://payload.dev.co/admin");
  check("normalisePayloadBaseUrl: /admin is stripped to the origin", adminUrl.ok && adminUrl.url === "https://payload.dev.co" && adminUrl.changed, adminUrl);
  const bare = normalisePayloadBaseUrl("payload.dev.co");
  check("normalisePayloadBaseUrl: a missing scheme becomes https", bare.ok && bare.url === "https://payload.dev.co", bare);
  check("normalisePayloadBaseUrl: http is refused", !normalisePayloadBaseUrl("http://payload.dev.co").ok);
  check("elevatedRole: super-admin is flagged", elevatedRole({ globalRole: "super-admin" }) === "super-admin");
  check("elevatedRole: a standard user isn't", elevatedRole({ globalRole: "standard-user" }) === null);
  const fromUser = tenantOptionsFromUser({
    tenantAssignments: [
      { tenant: { id: 12, name: "Investment Bank", primaryDomain: "investmentbank.com" }, roles: ["publisher"] },
      { tenant: 5, roles: ["editor"] },
      { tenant: 12, roles: ["editor"] },
    ],
  });
  check(
    "tenantOptionsFromUser: populated and bare-id assignments both become options, deduped",
    fromUser.length === 2 && fromUser.some((t) => t.id === "12" && t.siteUrl === "https://investmentbank.com") && fromUser.some((t) => t.id === "5" && t.label === "Tenant 5"),
    fromUser,
  );
  check("tenantOptionsFromUser: the plugin's default tenants[].tenant shape works too", tenantOptionsFromUser({ tenants: [{ tenant: "abc" }] })[0]?.id === "abc");

  // The whole discover flow against canned responses.
  const secretKey = "sk-test-not-a-real-key-123";
  const seen: { url: string; headers: Record<string, string>; redirect?: string }[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
  const makeFetch = (routes: Record<string, () => Response>) =>
    (async (input: string, init?: RequestInit) => {
      seen.push({ url: input, headers: init?.headers as Record<string, string>, redirect: init?.redirect });
      const path = new URL(input).pathname;
      return (routes[path] ?? (() => json({ errors: [{ message: "Not Found" }] }, 404)))();
    }) as unknown as typeof fetch;
  const noDns = async () => {};

  const happy = await discoverPayload(
    { baseUrl: "https://payload.dev.co/admin", authCollection: "", apiKey: secretKey },
    {
      assertPublicUrl: noDns,
      fetch: makeFetch({
        "/api/users/me": () => json({ user: { id: 9, email: "api@dev.co", globalRole: "standard-user" }, collection: "users", strategy: "api-key" }),
        "/api/access": () => json(accessBody),
        "/api/tenants": () => json({ docs: [{ id: 12, name: "Investment Bank", primaryDomain: "investmentbank.com" }], totalDocs: 1 }),
        "/api/posts": () => json({ docs: [{ id: 1, tenant: 12, bodyHtml: "<p>x</p>" }], totalDocs: 40 }),
      }),
    },
  );
  check("discoverPayload: happy path resolves", happy.ok, happy);
  if (happy.ok) {
    check("discoverPayload: base URL normalised and auth collection defaulted", happy.baseUrl === "https://payload.dev.co" && happy.authCollection === "users");
    check("discoverPayload: posts + media suggested, tenant listed, multi-tenant detected", happy.postsCollection === "posts" && happy.mediaCollection === "media" && happy.multiTenant && happy.tenants.available && happy.tenants.options[0]?.id === "12", happy);
    check("discoverPayload: body sniffed from the post", happy.body.bodyField === "bodyHtml" && happy.body.bodyFormat === "html");
  }
  check("discoverPayload: the API key never appears in the result", !JSON.stringify(happy).includes(secretKey));
  check("discoverPayload: every call sends the API-Key header, a browser UA and redirect: error", seen.length === 4 && seen.every((s) => s.headers.Authorization === `users API-Key ${secretKey}` && /Mozilla/.test(s.headers["User-Agent"]) && s.redirect === "error"), seen.map((s) => s.url));

  const badKey = await discoverPayload(
    { baseUrl: "https://payload.dev.co", authCollection: "users", apiKey: secretKey },
    { assertPublicUrl: noDns, fetch: makeFetch({ "/api/users/me": () => json({ user: null }) }) },
  );
  check("discoverPayload: /me with user:null (Payload's answer to an unknown key) is a key error that explains the API tab", !badKey.ok && badKey.step === "auth" && /JSON viewer/.test(badKey.error), badKey);

  const wrongHost = await discoverPayload(
    { baseUrl: "https://investmentbank.com", authCollection: "users", apiKey: secretKey },
    { assertPublicUrl: noDns, fetch: (async () => new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } })) as unknown as typeof fetch },
  );
  check("discoverPayload: an HTML 404 means the Base URL isn't Payload", !wrongHost.ok && wrongHost.step === "url", wrongHost);

  const noAccess = await discoverPayload(
    { baseUrl: "https://payload.example.com", authCollection: "users", apiKey: secretKey },
    {
      assertPublicUrl: noDns,
      fetch: makeFetch({
        "/api/users/me": () => json({ user: { id: 1, email: "a@b.co" } }),
        "/api/posts": () => json({ docs: [{ id: 1, content: { root: { children: [] } } }] }),
      }),
    },
  );
  check(
    "discoverPayload: no /api/access → free-text fallback with posts defaulted and Lexical sniffed",
    noAccess.ok && !noAccess.access.available && noAccess.postsCollection === "posts" && noAccess.body.bodyFormat === "lexical" && !noAccess.multiTenant,
    noAccess,
  );

  // payload.dev.co's recommended setup: a tenant-scoped user whose /api/tenants
  // read errors (its access `where` targets a field tenants don't have).
  const scoped = await discoverPayload(
    { baseUrl: "https://payload.dev.co", authCollection: "users", apiKey: secretKey },
    {
      assertPublicUrl: noDns,
      fetch: makeFetch({
        "/api/users/me": () =>
          json({ user: { id: 2, email: "api-ib@dev.co", globalRole: "standard-user", tenantAssignments: [{ tenant: { id: 12, name: "Investment Bank", primaryDomain: "investmentbank.com" }, roles: ["publisher"] }] } }),
        "/api/access": () => json(accessBody),
        "/api/tenants": () => json({ errors: [{ message: "The following path cannot be queried: tenant" }] }, 400),
        "/api/posts": () => json({ docs: [] }),
      }),
    },
  );
  check(
    "discoverPayload: when tenants can't be listed, the user's own tenant assignments fill the dropdown",
    scoped.ok && scoped.multiTenant && scoped.tenants.available && scoped.tenants.options.length === 1 && scoped.tenants.options[0]!.label === "Investment Bank — investmentbank.com",
    scoped,
  );
}

// Google sign-in as proof of the inbox (lib/security/google-proof.ts).
{
  const base = { provider: "google", profileEmail: "Tim@Dev.co", profileEmailVerified: true, accountEmail: "tim@dev.co", alreadyVerified: false };
  check("google: verified matching address verifies an unverified account", googleProofAction(base) === "verify");
  check("google: already verified account is left alone", googleProofAction({ ...base, alreadyVerified: true }) === "none");
  check("google: unverified google email proves nothing", googleProofAction({ ...base, profileEmailVerified: false }) === "none");
  check("google: a different address proves nothing", googleProofAction({ ...base, profileEmail: "other@dev.co" }) === "none");
  check("google: other providers are ignored", googleProofAction({ ...base, provider: "sendgrid" }) === "none");
}

// ─── Instantly / Aimfox webhook payloads (2026-09-15) ───
// The handlers read `event` / `leadId` / `email`; real deliveries send `event_type` and vendor-specific
// fields, so no real reply, interest or meeting ever reached a prospect. Fixtures below follow the
// vendors' own docs:
//  - Instantly: https://developer.instantly.ai/guides/webhook-events — the docs give a field schema,
//    not a literal example, so these are that schema filled in, field names and casing exactly as
//    documented.
//  - Aimfox: https://docs.aimfox.com/webhooks — examples copied from the event catalogue at
//    https://api.webhooks-external.linkedape.com/api/v1/webhooks/events, with the long `campaign`
//    object (schedule, flows, metrics) trimmed to id/name/state.
{
  const instantlyBase = {
    timestamp: "2026-09-15T10:37:15.565Z",
    workspace: "01a0a4a4-71ad-762d-bba9-f38eb6841e2e",
    campaign_id: "01a0a4a4-71a6-74ab-8215-e965b040335e",
    campaign_name: "Q3 Outbound — SaaS CTOs",
    lead_email: "Jane.Doe@Acme.com",
    email_account: "nate@send.dev.co",
  };
  const instantlyReply = {
    ...instantlyBase,
    event_type: "reply_received",
    unibox_url: "https://app.instantly.ai/app/unibox?thread_search=Jane.Doe%40Acme.com",
    step: 2,
    variant: 1,
    is_first: true,
    email_id: "01a0a4a4-bba8-71d6-9320-c925d0fe1b25",
    reply_text_snippet: "Sounds interesting — can we talk Thursday?",
    reply_subject: "Re: Quick question",
    reply_text: "Sounds interesting — can we talk Thursday?\n\nJane",
    reply_html: "<p>Sounds interesting — can we talk Thursday?</p>",
    firstName: "Jane",
    companyName: "Acme",
  };

  const r = parseInstantlyPayload(instantlyReply);
  check(
    "instantly: reply_received parses to email_reply with the lead's address lower-cased",
    r.kind === "event" && r.event === "email_reply" && r.identity.emails.join() === "jane.doe@acme.com",
    r,
  );
  check("instantly: the sending mailbox (email_account) is never taken as the lead", r.kind === "event" && !r.identity.emails.includes("nate@send.dev.co"), r);
  check("instantly: reply text comes from reply_text", r.kind === "event" && r.replyText.startsWith("Sounds interesting") && r.replyText.includes("Jane"), r);
  check("instantly: the event timestamp is kept for dedupe (Instantly sends no event id)", r.kind === "event" && r.occurredAt === instantlyBase.timestamp && r.eventId === null, r);

  const snippetOnly = parseInstantlyPayload({ ...instantlyBase, event_type: "reply_received", reply_text_snippet: "Yes please" });
  check("instantly: falls back to reply_text_snippet", snippetOnly.kind === "event" && snippetOnly.replyText === "Yes please", snippetOnly);

  const documented: [string, string][] = [
    ["lead_interested", "interested"],
    ["lead_not_interested", "not_interested"],
    ["lead_meeting_booked", "meeting_booked"],
    ["email_bounced", "bounced"],
    ["lead_unsubscribed", "unsubscribed"],
  ];
  for (const [vendorEvent, ours] of documented) {
    const p = parseInstantlyPayload({ ...instantlyBase, event_type: vendorEvent });
    check(`instantly: ${vendorEvent} → ${ours}`, p.kind === "event" && p.event === ours, p);
  }
  check("instantly: event_type is matched case-insensitively", (() => { const p = parseInstantlyPayload({ ...instantlyBase, event_type: "Lead_Meeting_Booked" }); return p.kind === "event" && p.event === "meeting_booked"; })());

  for (const ignored of ["email_sent", "email_opened", "link_clicked", "auto_reply_received", "lead_neutral", "lead_out_of_office", "lead_wrong_person", "lead_meeting_completed", "lead_closed", "account_error", "Positive - Asked for pricing"]) {
    const p = parseInstantlyPayload({ ...instantlyBase, event_type: ignored });
    check(`instantly: ${ignored} is ignored`, p.kind === "ignored", p);
  }
  const completed = parseInstantlyPayload({ timestamp: instantlyBase.timestamp, event_type: "campaign_completed", workspace: instantlyBase.workspace, campaign_id: instantlyBase.campaign_id, campaign_name: instantlyBase.campaign_name });
  check("instantly: campaign_completed (no lead) is ignored", completed.kind === "ignored", completed);
  const noLead = parseInstantlyPayload({ timestamp: instantlyBase.timestamp, event_type: "reply_received", campaign_id: "c" });
  check("instantly: a handled event with no lead address is ignored, not an error", noLead.kind === "ignored", noLead);
  check("instantly: a non-object body is invalid", parseInstantlyPayload([instantlyReply]).kind === "invalid" && parseInstantlyPayload("x").kind === "invalid");

  const legacyInstantly = parseInstantlyPayload({ event: "meeting_booked", leadId: "lead_77", email: "SAM@Beta.com", replyText: "Booked", timestamp: "2026-09-01T00:00:00Z" });
  check(
    "instantly: the legacy shape (event/leadId/email/replyText) still parses",
    legacyInstantly.kind === "event" && legacyInstantly.event === "meeting_booked" && legacyInstantly.identity.leadIds.join() === "lead_77" && legacyInstantly.identity.emails.join() === "sam@beta.com" && legacyInstantly.replyText === "Booked",
    legacyInstantly,
  );
  const legacyReply = parseInstantlyPayload({ event: "reply_received", email: "sam@beta.com" });
  check("instantly: legacy reply_received still parses", legacyReply.kind === "event" && legacyReply.event === "email_reply", legacyReply);

  // ── Aimfox ──
  const aimfoxWorkspace = { id: "ed0a4291-8866-465a-b62a-6518c56c0693", name: "Jane's workspace", created_at: 1725279327 };
  const aimfoxCampaignReply = {
    id: "1e5e930e-c44c-4994-9b85-a6b65423f3e8",
    event_type: "campaign_reply",
    event: {
      conversation_urn: "2-MTBmOGZlNGUtNzZjZS00MjZkLWE0NTAtNGY2NjIyOTNlM2RiXzEwMA==",
      message_urn: "2-MTc2MTY1OTA0ODIwNGI0NTg0Ny0xMDAmMTBmOGZlNGUtNzZjZS00MjZkLWE0NTAtNGY2NjIyOTNlM2RiXzEwMA==",
      body: "Hey, can you try once? It will take a maximum of 2-3 minutes and the first 5 prompts are free.",
      declined: false,
      message: {
        urn: "2-MTc2MTY1OTA0ODIwNGI0NTg0Ny0xMDAmMTBmOGZlNGUtNzZjZS00MjZkLWE0NTAtNGY2NjIyOTNlM2RiXzEwMA==",
        inmail: false,
        subject: null,
        body: "Hey, can you try once? It will take a maximum of 2-3 minutes and the first 5 prompts are free.",
        reactions: [],
        sender: "1432144979",
        created_at: 1761659048204,
        edited: false,
        deleted: false,
      },
      timestamp: "2025-10-28T13:44:08.204Z",
      sender: {
        id: 1432144979,
        urn: "ACoAAFVczFMB65mrY-IofOnkRLexvBVXhT5HcQs",
        public_identifier: "john-doe-72b75733b",
        first_name: "John ",
        last_name: "Doe",
        email: "johndoe@hotmail.com",
        picture_url: "https://cdn.constel.co/linkedin-profile/ACoAAFVczFMB65mrY-IofOnkRLexvBVXhT5HcQs.jpg",
      },
      recipient: {
        id: 1033744867,
        urn: "ACoAAD2dseMBdvw12MyzFvftslnla0_OX5XeBgQ",
        public_identifier: "jane-doe-b9724724a",
        first_name: "Jane",
        last_name: "Doe",
        email: "janedoe@gmail.com",
        picture_url: "https://cdn.constel.co/linkedin-profile/ACoAAD2dseMBdvw12MyzFvftslnla0_OX5XeBgQ.jpg",
      },
      campaign: { id: "3acad0ac-e95d-4d2a-84ec-896a3562e29d", state: "ACTIVE", name: "LinkedIn search Campaign #25", owners: ["1033744867"] },
    },
    workspace: aimfoxWorkspace,
  };
  const ac = parseAimfoxPayload(aimfoxCampaignReply);
  check("aimfox: campaign_reply → linkedin_reply", ac.kind === "event" && ac.event === "linkedin_reply", ac);
  check(
    "aimfox: on a message event the lead is the SENDER (the recipient is the campaign's own seat)",
    ac.kind === "event" && ac.identity.linkedInSlugs.includes("john-doe-72b75733b") && ac.identity.emails.includes("johndoe@hotmail.com") && !ac.identity.emails.includes("janedoe@gmail.com"),
    ac,
  );
  check("aimfox: reply text is the message body", ac.kind === "event" && ac.replyText.startsWith("Hey, can you try once?"), ac);
  check("aimfox: dedupe id is the message urn", ac.kind === "event" && ac.eventId === `message:${aimfoxCampaignReply.event.message_urn}`, ac);

  // The same LinkedIn message delivered as new_reply too (a different envelope id) must dedupe to one.
  const asNewReply = parseAimfoxPayload({ ...aimfoxCampaignReply, id: "b9c92988-ae97-418c-a4a1-2b2a0f8417b4", event_type: "new_reply" });
  check(
    "aimfox: new_reply and campaign_reply for one message share a dedupe key",
    ac.kind === "event" && asNewReply.kind === "event" && dedupeKey(ac, "p1") === dedupeKey(asNewReply, "p1"),
    asNewReply,
  );

  const aimfoxAccepted = {
    id: "1399ddcd-dd16-4123-8047-2f01abe0bfba",
    event_type: "accepted",
    event: {
      target_urn: "ACoAAAkpGpYBqjQMr2DBS8q4ht8NNGwbAfE-qtc",
      prev_state: "withdraw",
      state: "message",
      transition: "accepted",
      flow_id: "9b21f2e1-118b-40ed-8831-deba6f97f9a2",
      flow_type: "PRIMARY_CONNECT",
      timestamp: "2024-11-26T02:48:46.332Z",
      account: {
        id: 685914315,
        urn: "ACoAACjiOMsBxN2eyo8LuQz4xK1D54uGND8jCwg",
        public_identifier: "kengur-kengurovic-1a3865171",
        first_name: "Kengur",
        last_name: "Kengurovic",
        email: "kengur1111@gmail.com",
        picture_url: "https://cdn.constel.co/linkedin-profile/685914315.jpg",
      },
      target: {
        id: 153688726,
        urn: "ACoAAAkpGpYBqjQMr2DBS8q4ht8NNGwbAfE-qtc",
        public_identifier: "nevena-nikolic-hr",
        first_name: "Nevena",
        last_name: "Nikolic",
        email: null,
        picture_url: "https://cdn.constel.co/linkedin-profile/ACoAAAkpGpYBqjQMr2DBS8q4ht8NNGwbAfE-qtc.jpg",
      },
      campaign: { id: "7efc00b5-6e5f-45a1-b150-12b2010425b5", state: "ACTIVE", name: "Search Campaign #1" },
    },
    workspace: { id: "94f46bd4-c750-4fde-b53b-9938d4d889ec", name: "Aimfox Workspace", created_at: 1732541078 },
  };
  const aa = parseAimfoxPayload(aimfoxAccepted);
  check("aimfox: accepted → connection_accepted", aa.kind === "event" && aa.event === "connection_accepted", aa);
  check(
    "aimfox: on a campaign event the lead is the TARGET, never our own account",
    aa.kind === "event" && aa.identity.leadIds.includes("153688726") && aa.identity.leadIds.includes("ACoAAAkpGpYBqjQMr2DBS8q4ht8NNGwbAfE-qtc") && aa.identity.linkedInSlugs.includes("nevena-nikolic-hr") && !aa.identity.emails.includes("kengur1111@gmail.com"),
    aa,
  );
  check("aimfox: envelope id is the dedupe id when there is no message urn", aa.kind === "event" && aa.eventId === aimfoxAccepted.id, aa);

  const aimfoxFirstReply = {
    id: "815e2d1d-6c72-47ae-8185-ecdb76dd929e",
    event_type: "reply",
    event: {
      target_urn: "ACoAACHGAQoBKI-3086W4V3Q58uQQtGMPAUQNZ4",
      prev_state: "message",
      state: "done",
      transition: "reply",
      flow_id: "0b465ad5-e3b1-4b45-8060-050dc191cb74",
      flow_type: "PRIMARY_CONNECT",
      template_id: "4d6446a6-0198-4ae2-9676-b20eea556459",
      message: "Hi Selena, I hope you’re doing well. I’m Kengur, and I’d love to connect and discuss our shared interests in web development and potential collaboration opportunities.",
      timestamp: "2024-11-26T14:01:05.787Z",
      account: { id: 685914315, urn: "ACoAACjiOMsBxN2eyo8LuQz4xK1D54uGND8jCwg", public_identifier: "kengur-kengurovic-1a3865171", first_name: "Kengur", last_name: "Kengurovic", email: "kengur1111@gmail.com", picture_url: "https://cdn.constel.co/linkedin-profile/685914315.jpg" },
      target: { id: 566624522, urn: "ACoAACHGAQoBKI-3086W4V3Q58uQQtGMPAUQNZ4", public_identifier: "aidan-ashley-jones-862917139", first_name: "Aidan Ashley", last_name: "Jones", email: null, picture_url: "https://cdn.constel.co/linkedin-profile/ACoAACHGAQoBKI-3086W4V3Q58uQQtGMPAUQNZ4.jpg" },
      campaign: { id: "3e807949-733c-4e0d-a03a-cb6a53822d71", state: "ACTIVE", name: "List Campaign #7" },
    },
    workspace: { id: "47973863-0513-4ee6-910a-c5bc55782ed2", name: "Aimfox Workspace", created_at: 1732541078 },
  };
  const af = parseAimfoxPayload(aimfoxFirstReply);
  check("aimfox: reply (first reply) → linkedin_reply for the target", af.kind === "event" && af.event === "linkedin_reply" && af.identity.linkedInSlugs.includes("aidan-ashley-jones-862917139"), af);
  check("aimfox: our own outbound template (event.message on `reply`) is never passed off as the lead's reply", af.kind === "event" && af.replyText === "", af);
  check("aimfox: inmail_reply → linkedin_reply", (() => { const p = parseAimfoxPayload({ ...aimfoxFirstReply, event_type: "inmail_reply" }); return p.kind === "event" && p.event === "linkedin_reply"; })());

  for (const ignored of ["new_connection", "view", "connect", "inmail", "message", "lead_label_added", "campaign_ended", "campaign_created", "campaign_started", "inbox_event", "account_logged_in", "account_logged_out"]) {
    const p = parseAimfoxPayload({ ...aimfoxAccepted, event_type: ignored });
    check(`aimfox: ${ignored} is ignored`, p.kind === "ignored", p);
  }

  const legacyAimfox = parseAimfoxPayload({ event: "connection_declined", leadId: "aimfox_1", linkedInUrl: "https://www.linkedin.com/in/Sam-Beta/", timestamp: "2026-09-01T00:00:00Z" });
  check(
    "aimfox: the legacy shape (event/leadId/linkedInUrl) still parses",
    legacyAimfox.kind === "event" && legacyAimfox.event === "connection_declined" && legacyAimfox.identity.leadIds.join() === "aimfox_1" && legacyAimfox.identity.linkedInSlugs.join() === "sam-beta",
    legacyAimfox,
  );
  const legacyAimfoxReply = parseAimfoxPayload({ event: "new_reply", leadId: "aimfox_1", replyText: "Sure" });
  check("aimfox: legacy new_reply still parses with its reply text", legacyAimfoxReply.kind === "event" && legacyAimfoxReply.event === "linkedin_reply" && legacyAimfoxReply.replyText === "Sure", legacyAimfoxReply);

  check("linkedInSlug: normalises host, case, trailing slash and query", linkedInSlug("http://LinkedIn.com/in/Jane-Doe-123/?utm=x") === "jane-doe-123" && linkedInSlug("https://example.com/in/x") === null);

  // ── Matching ──
  const cand = (over: Partial<ProspectCandidate>): ProspectCandidate => ({
    id: "p?",
    workspaceId: "ws1",
    email: "x@x.com",
    linkedInUrl: null,
    instantlyLeadId: null,
    aimfoxLeadId: null,
    status: "IN_SEQUENCE",
    ...over,
  });
  const jane = cand({ id: "p_jane", email: "Jane.Doe@acme.COM" });
  check(
    "match: email is case-insensitive",
    r.kind === "event" && pickProspect("INSTANTLY", r.identity, [jane], true)?.id === "p_jane",
  );
  const byId = cand({ id: "p_by_id", email: "other@acme.com", instantlyLeadId: "lead_77" });
  const byMail = cand({ id: "p_by_mail", email: "sam@beta.com" });
  check(
    "match: the stored vendor lead id beats an email match",
    legacyInstantly.kind === "event" && pickProspect("INSTANTLY", legacyInstantly.identity, [byMail, byId], true)?.id === "p_by_id",
  );
  check(
    "match: an Instantly lead id is never compared with aimfoxLeadId",
    legacyInstantly.kind === "event" && pickProspect("INSTANTLY", legacyInstantly.identity, [cand({ id: "p_af", email: "no@x.com", aimfoxLeadId: "lead_77" })], true) === null,
  );
  const sam = cand({ id: "p_sam", linkedInUrl: "https://linkedin.com/in/sam-beta" });
  const samantha = cand({ id: "p_samantha", linkedInUrl: "https://linkedin.com/in/sam-beta-2" });
  check(
    "match: a LinkedIn handle matches exactly, not by prefix",
    legacyAimfox.kind === "event" && pickProspect("AIMFOX", { ...legacyAimfox.identity, leadIds: [] }, [samantha, sam], true)?.id === "p_sam",
  );
  const twoWs = [cand({ id: "p_a", workspaceId: "wsA", email: "jane.doe@acme.com" }), cand({ id: "p_b", workspaceId: "wsB", email: "jane.doe@acme.com" })];
  check("match: an unsigned (grace) delivery matching prospects in two workspaces acts on neither", r.kind === "event" && pickProspect("INSTANTLY", r.identity, twoWs, false) === null);

  // ── Guarded writes ──
  const now = new Date("2026-09-15T12:00:00Z");
  const replyUpdates = prospectUpdatesFor("email_reply", now);
  check("updates: a reply sets emailRepliedAt only while unset", replyUpdates.some((u) => u.onlyIfNull === "emailRepliedAt" && u.data.emailRepliedAt === now));
  check("updates: a reply never moves a prospect past REPLIED back to REPLIED", replyUpdates.every((u) => !u.data.status || (u.onlyIfStatusIn ?? []).every((s) => s === "PENDING" || s === "IN_SEQUENCE")));
  check("updates: connection accepted only promotes a PENDING prospect", prospectUpdatesFor("connection_accepted", now).every((u) => (u.onlyIfStatusIn ?? []).join() === "PENDING"));

  // ── The whole flow, against an in-memory store ──
  type Row = ProspectCandidate & { emailRepliedAt: Date | null; linkedInRepliedAt: Date | null; interestedAt: Date | null; meetingBookedAt: Date | null; excludeUntil: Date | null };
  function memoryDeps(rows: Row[], opts: { revenueEnabled?: boolean; failFirstUpdate?: boolean; failChannelPause?: boolean } = {}) {
    const receipts = new Set<string>();
    const runs: Record<string, unknown>[] = [];
    const enqueued: string[] = [];
    const pauseCalls: Array<{ prospectId: string; event: string }> = [];
    let calls = 0;
    let failNext = opts.failFirstUpdate ?? false;
    const deps: WebhookDeps<Row> = {
      async findCandidates(_vendor, identity, workspaceId) {
        calls++;
        return rows.filter(
          (row) =>
            (workspaceId === null || row.workspaceId === workspaceId) &&
            (identity.emails.includes(row.email.toLowerCase()) ||
              identity.leadIds.includes(row.instantlyLeadId ?? "") ||
              identity.leadIds.includes(row.aimfoxLeadId ?? "") ||
              identity.linkedInSlugs.includes(linkedInSlug(row.linkedInUrl) ?? "")),
        );
      },
      async claim(ws, vendor, key) {
        const k = `${ws}|${vendor}|${key}`;
        if (receipts.has(k)) return false;
        receipts.add(k);
        return true;
      },
      async release(ws, vendor, key) {
        receipts.delete(`${ws}|${vendor}|${key}`);
      },
      async applyUpdate(prospect, update: ProspectUpdate) {
        if (failNext) {
          failNext = false;
          throw new Error("db down");
        }
        const row = rows.find((x) => x.id === prospect.id && x.workspaceId === prospect.workspaceId)!;
        if (update.onlyIfStatusIn && !update.onlyIfStatusIn.includes(row.status)) return;
        if (update.onlyIfNull && row[update.onlyIfNull] !== null) return;
        Object.assign(row, update.data);
      },
      async applyChannelPause(prospect, event) {
        pauseCalls.push({ prospectId: prospect.id, event });
        if (opts.failChannelPause) throw new Error("pause boom");
      },
      async revenueAgentId() {
        return opts.revenueEnabled === false ? null : "cfg_revenue";
      },
      async createRevenueRun(args) {
        runs.push(args.input);
        return `run_${runs.length}`;
      },
      async enqueue(runId) {
        enqueued.push(runId);
      },
      now: () => now,
      log: () => undefined,
    };
    return { deps, runs, enqueued, receipts, pauseCalls, calls: () => calls };
  }
  const row = (over: Partial<Row>): Row => ({ ...cand({}), emailRepliedAt: null, linkedInRepliedAt: null, interestedAt: null, meetingBookedAt: null, excludeUntil: null, ...over });

  {
    const rows = [row({ id: "p_jane", workspaceId: "ws1", email: "jane.doe@ACME.com" }), row({ id: "p_other_ws", workspaceId: "ws2", email: "jane.doe@acme.com" })];
    const m = memoryDeps(rows);
    const first = await processWebhook(r, "ws1", m.deps);
    check("flow: a documented Instantly reply matches the prospect and starts one Outbound Revenue run", first.status === 200 && first.outcome === "run_created" && m.runs.length === 1 && m.enqueued.length === 1, { first, runs: m.runs });
    check("flow: applyChannelPause is called for every located event, even one that plans no pause step (email_reply)", m.pauseCalls.length === 1 && m.pauseCalls[0]?.prospectId === "p_jane" && m.pauseCalls[0]?.event === "email_reply", m.pauseCalls);
    check("flow: the run carries the prospect, our event name, the reply and the vendor event", m.runs[0]?.prospectId === "p_jane" && m.runs[0]?.event === "email_reply" && String(m.runs[0]?.replyText).startsWith("Sounds") && m.runs[0]?.sourceEvent === "reply_received", m.runs[0]);
    check("flow: the reply is recorded on the prospect", rows[0]!.status === "REPLIED" && rows[0]!.emailRepliedAt?.getTime() === now.getTime(), rows[0]);
    check("flow: a prospect with the same address in ANOTHER workspace is untouched", rows[1]!.status === "IN_SEQUENCE" && rows[1]!.emailRepliedAt === null, rows[1]);

    // Instantly retries the same payload (re-serialised, keys in a different order).
    const retried = parseInstantlyPayload(Object.fromEntries(Object.entries(instantlyReply).reverse()));
    const second = await processWebhook(retried, "ws1", m.deps);
    check("flow: a retried delivery is a 200 duplicate and starts no second run", second.status === 200 && second.outcome === "duplicate" && m.runs.length === 1 && m.enqueued.length === 1, second);

    const later = parseInstantlyPayload({ ...instantlyReply, timestamp: "2026-09-16T09:00:00.000Z", reply_text: "Following up" });
    const third = await processWebhook(later, "ws1", m.deps);
    check("flow: a genuinely new reply (new timestamp) is processed", third.outcome === "run_created" && m.runs.length === 2, third);
    check("flow: …without moving the first-reply timestamp", rows[0]!.emailRepliedAt?.getTime() === now.getTime(), rows[0]);

    const callsBefore = m.calls();
    const unknown = await processWebhook(parseInstantlyPayload({ ...instantlyBase, event_type: "email_opened" }), "ws1", m.deps);
    check("flow: an unhandled event is a 200 and never touches the database", unknown.status === 200 && unknown.outcome === "ignored" && m.calls() === callsBefore, unknown);

    const stranger = await processWebhook(parseInstantlyPayload({ ...instantlyReply, lead_email: "nobody@nowhere.com" }), "ws1", m.deps);
    check("flow: a lead we don't have is a 200 with nothing written", stranger.status === 200 && stranger.outcome === "no_prospect" && m.runs.length === 2, stranger);

    check("flow: an invalid body is a 400", (await processWebhook(parseInstantlyPayload(null), "ws1", m.deps)).status === 400);
  }

  {
    const rows = [row({ id: "p_booked", email: "jane.doe@acme.com", status: "MEETING_BOOKED" as OutboundStatus })];
    const m = memoryDeps(rows);
    await processWebhook(r, "ws1", m.deps);
    check("flow: a reply after a booked meeting never drags the status back to REPLIED", rows[0]!.status === "MEETING_BOOKED", rows[0]);
  }

  {
    const rows = [row({ id: "p_jane", email: "jane.doe@acme.com" })];
    const m = memoryDeps(rows, { revenueEnabled: false });
    const res = await processWebhook(r, "ws1", m.deps);
    check("flow: with Outbound Revenue disabled the reply is still recorded, but no run starts", res.outcome === "updated" && m.runs.length === 0 && rows[0]!.status === "REPLIED", res);
  }

  {
    const rows = [row({ id: "p_jane", email: "jane.doe@acme.com" })];
    const m = memoryDeps(rows, { failFirstUpdate: true });
    const failed = await processWebhook(r, "ws1", m.deps);
    check("flow: a database failure is a 500 so the vendor retries, and its claim is released", failed.status === 500 && m.receipts.size === 0 && m.runs.length === 0, failed);
    const retry = await processWebhook(r, "ws1", m.deps);
    check("flow: …and the retry then does the work exactly once", retry.outcome === "run_created" && m.runs.length === 1, retry);
  }

  {
    const rows = [row({ id: "p_john", email: "johndoe@hotmail.com", linkedInUrl: "https://www.linkedin.com/in/john-doe-72b75733b/" })];
    const m = memoryDeps(rows);
    const first = await processWebhook(ac, "ws1", m.deps);
    const dup = await processWebhook(asNewReply, "ws1", m.deps);
    check("flow: an Aimfox campaign_reply starts a linkedin_reply run", first.outcome === "run_created" && m.runs[0]?.event === "linkedin_reply", { first, runs: m.runs });
    check("flow: the same message arriving again as new_reply is a duplicate", dup.outcome === "duplicate" && m.runs.length === 1, dup);
    check("flow: the LinkedIn reply is recorded", rows[0]!.status === "REPLIED" && rows[0]!.linkedInRepliedAt !== null, rows[0]);
  }

  {
    const rows = [row({ id: "p_nevena", status: "PENDING", linkedInUrl: "https://linkedin.com/in/nevena-nikolic-hr" })];
    const m = memoryDeps(rows);
    const res = await processWebhook(aa, "ws1", m.deps);
    check("flow: an Aimfox accepted moves a PENDING prospect to IN_SEQUENCE and starts no run", res.outcome === "updated" && rows[0]!.status === "IN_SEQUENCE" && m.runs.length === 0, res);
  }

  {
    const rows = [row({ id: "p_jane", email: "jane.doe@acme.com" })];
    const m = memoryDeps(rows);
    const bounced = parseInstantlyPayload({ ...instantlyBase, event_type: "email_bounced" }) as ParsedWebhook;
    const res = await processWebhook(bounced, "ws1", m.deps);
    check("flow: a bounce suppresses the prospect and starts no run", res.outcome === "updated" && rows[0]!.status === "SUPPRESSED" && m.runs.length === 0, { res, row: rows[0] });
  }

  {
    // A pause-orchestration failure (network error, bad credentials, whatever) must never turn an
    // otherwise-successful webhook into a 500 — that would make the vendor retry a delivery that
    // already updated the database and (if applicable) already started a Revenue run, risking a
    // second one. See outbound-events.ts's processWebhook, which wraps deps.applyChannelPause in
    // its own try/catch on top of runChannelPause's own never-throws contract.
    const rows = [row({ id: "p_jane", email: "jane.doe@acme.com" })];
    const m = memoryDeps(rows, { failChannelPause: true });
    const res = await processWebhook(r, "ws1", m.deps);
    check("flow: a channel-pause failure still returns 200/run_created, not 500", res.status === 200 && res.outcome === "run_created" && m.pauseCalls.length === 1, res);
  }
}

// Outbound Engine: cross-channel "stop on positive signal" (lib/webhooks/outbound-pause.ts) and
// the CRO's real signal/persona/channel/score-band slicing (lib/agent-handlers/outbound-cro.ts).
// Both pure — no network, no DB.
{
  const withInstantly: PauseCandidate = { instantlyLeadId: "lead_1", aimfoxLeadId: null };
  const withAimfox: PauseCandidate = { instantlyLeadId: null, aimfoxLeadId: "aimfox_1" };
  const withBoth: PauseCandidate = { instantlyLeadId: "lead_1", aimfoxLeadId: "aimfox_1" };
  const withNeither: PauseCandidate = { instantlyLeadId: null, aimfoxLeadId: null };

  check("pause: exactly interested, meeting_booked, linkedin_reply are trigger events", [...PAUSE_TRIGGER_EVENTS].sort().join() === ["interested", "linkedin_reply", "meeting_booked"].sort().join(), [...PAUSE_TRIGGER_EVENTS]);
  for (const untouched of ["email_reply", "bounced", "unsubscribed", "not_interested", "connection_accepted", "connection_declined"] as const) {
    check(`pause: "${untouched}" plans nothing at all, even with both vendor ids on record`, planChannelPause(untouched, withBoth).length === 0);
  }

  const interested = planChannelPause("interested", withInstantly);
  check("pause: interested + instantlyLeadId → one Instantly step at interestValue 1", interested.length === 1 && interested[0]?.vendor === "INSTANTLY" && interested[0]?.action === "set_interest_status" && interested[0]?.interestValue === 1, interested);

  const meeting = planChannelPause("meeting_booked", withInstantly);
  check("pause: meeting_booked + instantlyLeadId → one Instantly step at interestValue 2", meeting.length === 1 && meeting[0]?.action === "set_interest_status" && meeting[0]?.interestValue === 2, meeting);

  const liReplyCross = planChannelPause("linkedin_reply", withInstantly);
  check("pause: linkedin_reply + instantlyLeadId → cross-channel Instantly step, interestValue 1", liReplyCross.length === 1 && liReplyCross[0]?.vendor === "INSTANTLY" && liReplyCross[0]?.interestValue === 1 && /cross-channel/.test(liReplyCross[0]!.reason), liReplyCross);

  check("pause: interested with only an aimfoxLeadId on record → no Instantly step, one unsupported Aimfox step", (() => {
    const steps = planChannelPause("interested", withAimfox);
    return steps.length === 1 && steps[0]?.vendor === "AIMFOX" && steps[0]?.action === "unsupported";
  })());

  check("pause: a trigger event with both vendor ids plans one Instantly step AND records the Aimfox limitation", (() => {
    const steps = planChannelPause("meeting_booked", withBoth);
    return steps.length === 2 && steps.some((s) => s.vendor === "INSTANTLY") && steps.some((s) => s.vendor === "AIMFOX" && s.action === "unsupported");
  })());

  check("pause: a trigger event with neither vendor id on record plans nothing — 'only act for prospects that actually have ... on record'", planChannelPause("interested", withNeither).length === 0);

  // ── CRO slicing ──
  check("cro: scoreBand boundaries", scoreBand(0) === "0-49" && scoreBand(49) === "0-49" && scoreBand(50) === "50-64" && scoreBand(64) === "50-64" && scoreBand(65) === "65-79" && scoreBand(79) === "65-79" && scoreBand(80) === "80-100" && scoreBand(100) === "80-100");

  check("cro: personaBucket prefers Apollo's own seniority, title-cased", personaBucket("Some Title", "c_suite") === "C Suite");
  check("cro: personaBucket falls back to a title keyword match when Apollo has nothing", personaBucket("VP of Engineering", null) === "VP" && personaBucket("Director of Ops", undefined) === "Director");
  check("cro: personaBucket falls back further to a generic IC bucket for an unrecognised title", personaBucket("Account Executive", null) === "Other / IC (from title, no Apollo seniority)");
  check("cro: personaBucket with nothing at all", personaBucket(null, null) === "(no title recorded)");

  const flags = { replied: (r: SliceInputProspect) => r.replied, interested: (r: SliceInputProspect) => r.interested, meetingBooked: (r: SliceInputProspect) => r.meetingBooked };
  const p = (over: Partial<SliceInputProspect>): SliceInputProspect => ({
    playId: "play1",
    channel: "EMAIL_ONLY",
    score: 70,
    title: null,
    primarySignal: "Recently raised Series B",
    messagingAngle: null,
    apolloSeniority: null,
    replied: false,
    interested: false,
    meetingBooked: false,
    ...over,
  });

  // A small slice (below MIN_SLICE_SAMPLE_SIZE) is flagged; a slice that clears it is not.
  const thin = [p({}), p({ replied: true })];
  const thinRows = buildSliceRows(thin, () => "only-bucket", flags);
  check("cro: a slice under the minimum sample size is flagged insufficientData", thinRows.length === 1 && thinRows[0]?.added === 2 && thinRows[0]?.insufficientData === true, thinRows);

  const thick = Array.from({ length: MIN_SLICE_SAMPLE_SIZE }, (_, i) => p({ replied: i < 3, interested: i < 1 }));
  const thickRows = buildSliceRows(thick, () => "only-bucket", flags);
  check(
    "cro: a slice at the minimum sample size is not flagged, and its rates are computed correctly",
    thickRows.length === 1 && thickRows[0]?.insufficientData === false && thickRows[0]?.added === MIN_SLICE_SAMPLE_SIZE && thickRows[0]?.replied === 3 && thickRows[0]?.replyRate === "30.0%" && thickRows[0]?.interested === 1 && thickRows[0]?.positiveRate === "10.0%",
    thickRows,
  );

  // buildPlaySlices groups a mixed cohort into all four axes correctly, and different plays'
  // prospects never mix (the caller is expected to have already filtered to one play — this just
  // checks the aggregation itself doesn't accidentally key on playId).
  const cohort: SliceInputProspect[] = [
    p({ primarySignal: "Series B", apolloSeniority: "vp", channel: "EMAIL_AND_LINKEDIN", score: 85, replied: true }),
    p({ primarySignal: "Series B", apolloSeniority: "vp", channel: "EMAIL_AND_LINKEDIN", score: 82 }),
    p({ primarySignal: "Hiring 5 engineers", apolloSeniority: "director", channel: "EMAIL_ONLY", score: 68, interested: true }),
  ];
  const slices = buildPlaySlices(cohort);
  check("cro: buildPlaySlices bySignal groups by exact primarySignal text", slices.bySignal.find((r) => r.value === "Series B")?.added === 2 && slices.bySignal.find((r) => r.value === "Hiring 5 engineers")?.added === 1, slices.bySignal);
  check("cro: buildPlaySlices byPersona groups by title-cased Apollo seniority", slices.byPersona.find((r) => r.value === "Vp")?.added === 2, slices.byPersona);
  check("cro: buildPlaySlices byScoreBand groups by band, not raw score", slices.byScoreBand.find((r) => r.value === "80-100")?.added === 2 && slices.byScoreBand.find((r) => r.value === "65-79")?.added === 1, slices.byScoreBand);
  check("cro: buildPlaySlices byChannel separates EMAIL_AND_LINKEDIN from EMAIL_ONLY", slices.byChannel.find((r) => r.value === "EMAIL_AND_LINKEDIN")?.added === 2 && slices.byChannel.find((r) => r.value === "EMAIL_ONLY")?.added === 1, slices.byChannel);
  check("cro: every row in this tiny cohort is flagged insufficientData (well under the minimum)", [...slices.bySignal, ...slices.byPersona, ...slices.byScoreBand, ...slices.byChannel].every((r) => r.insufficientData === true));
}

// Podcast voice providers: Google Gemini TTS as the alternative to Cartesia
// (lib/voice/*). Pure, with every network call injected.
{
  // --- form values → safe request values ---
  check("google voice: form label parses to the voice name", googleVoiceName("Kore — Firm") === "Kore");
  check("google voice: bare lower-case name is accepted", googleVoiceName("puck") === "Puck");
  check("google voice: an unknown voice falls back to the default", googleVoiceName("Robert'); DROP", "Aoede — Breezy") === "Aoede");
  check("google voice: every form option maps to itself", GOOGLE_VOICE_OPTIONS.every((o) => googleVoiceName(o) === o.split(" ")[0]) && GOOGLE_VOICE_OPTIONS.length === 30);
  check("google model: labels and ids map to allowlisted ids", googleTtsModelId(GOOGLE_TTS_MODEL_OPTIONS[1]) === "gemini-2.5-pro-preview-tts" && googleTtsModelId("gemini-2.5-flash-preview-tts") === "gemini-2.5-flash-preview-tts");
  check("google model: anything else is the default, never interpolated into the URL", googleTtsModelId("../../evil") === "gemini-3.1-flash-tts-preview");

  // --- request building ---
  const single = buildGoogleTtsRequest("gemini-3.1-flash-tts-preview", { kind: "narration", text: "Hello there." }, { kind: "single", voice: "Kore" });
  const sBody = single.body as { contents: Array<{ parts: Array<{ text: string }> }>; generationConfig: { responseModalities: string[]; speechConfig: { voiceConfig?: { prebuiltVoiceConfig: { voiceName: string } }; multiSpeakerVoiceConfig?: unknown } } };
  check("google request: generateContent URL for the model, key not in the URL", single.url === "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent" && !single.url.includes("key="), single.url);
  check("google request: single voice uses voiceConfig.prebuiltVoiceConfig and AUDIO modality",
    sBody.generationConfig.responseModalities[0] === "AUDIO" && sBody.generationConfig.speechConfig.voiceConfig?.prebuiltVoiceConfig.voiceName === "Kore" && !sBody.generationConfig.speechConfig.multiSpeakerVoiceConfig, sBody);
  check("google request: narration text is sent after a style direction", sBody.contents[0].parts[0].text.endsWith("\n\nHello there."), sBody.contents[0].parts[0].text);

  const duo = buildGoogleTtsRequest(
    "gemini-2.5-pro-preview-tts",
    { kind: "dialogue", lines: [{ speaker: "Host", text: "Welcome back." }, { speaker: "Guest", text: "Glad to be here." }] },
    { kind: "dialogue", speakers: [{ label: "Host", voice: "Charon" }, { label: "Guest", voice: "Aoede" }] },
  );
  const dBody = duo.body as { contents: Array<{ parts: Array<{ text: string }> }>; generationConfig: { speechConfig: { voiceConfig?: unknown; multiSpeakerVoiceConfig?: { speakerVoiceConfigs: Array<{ speaker: string; voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } }> } } } };
  const svc = dBody.generationConfig.speechConfig.multiSpeakerVoiceConfig?.speakerVoiceConfigs ?? [];
  check("google request: dialogue uses multiSpeakerVoiceConfig with exactly two speakers mapped to voices",
    svc.length === 2 && svc[0].speaker === "Host" && svc[0].voiceConfig.prebuiltVoiceConfig.voiceName === "Charon" && svc[1].speaker === "Guest" && svc[1].voiceConfig.prebuiltVoiceConfig.voiceName === "Aoede" && !dBody.generationConfig.speechConfig.voiceConfig, svc);
  check("google request: dialogue prompt names both speakers and keeps labelled turns",
    dBody.contents[0].parts[0].text.includes("between Host and Guest") && dBody.contents[0].parts[0].text.includes("\nHost: Welcome back.\nGuest: Glad to be here."), dBody.contents[0].parts[0].text);

  // --- script cleanup ---
  check("speech cleanup: cue markers never reach the voice", cleanScriptForSpeech("Big news. [PAUSE] It's **here**. [EMPHASIS]Really.[TRANSITION]\n## Segment 2\nNext.") === "Big news. … It's here. Really.\nSegment 2\nNext.", cleanScriptForSpeech("Big news. [PAUSE] It's **here**. [EMPHASIS]Really.[TRANSITION]\n## Segment 2\nNext."));

  // --- chunking ---
  const para = (n: number, words: number) => Array.from({ length: words }, (_, i) => `word${n}_${i}.`).join(" ");
  const longScript = [para(1, 300), para(2, 300), para(3, 300)].join("\n\n");
  const chunks = chunkNarration(longScript, 3000);
  const words = (t: string) => t.split(/\s+/).filter(Boolean);
  check("chunkNarration: every chunk is within the limit", chunks.every((c) => c.length <= 3000), chunks.map((c) => c.length));
  check("chunkNarration: splits a long script into several chunks", chunks.length > 1, chunks.length);
  check("chunkNarration: no words are lost, duplicated or reordered", words(chunks.join(" ")).join(" ") === words(longScript).join(" "));
  const giantSentence = "a".repeat(50) + " " + "b".repeat(7000);
  const gChunks = chunkNarration(giantSentence, 3000);
  check("chunkNarration: an unbreakable run of text is hard-split within the limit", gChunks.every((c) => c.length <= 3000) && gChunks.join("").replace(/\s/g, "") === giantSentence.replace(/\s/g, ""), gChunks.map((c) => c.length));
  check("chunkNarration: a short script is one chunk, an empty one is none", chunkNarration("Hi.").length === 1 && chunkNarration("   ").length === 0);

  // --- dialogue ---
  check("dialogueSpeakers: solo has none, two-voice formats have two labels", dialogueSpeakers("Solo host") === null && dialogueSpeakers("Interview")?.[1] === "Guest" && dialogueSpeakers("Two co-hosts")?.[1] === "CoHost");
  const parsed = parseDialogue("Host: Welcome.\n**Guest:** Thanks for having me.\nIt's great.\nhost: Let's start.", ["Host", "Guest"]);
  check("parseDialogue: labelled turns, markdown-bold labels, case-insensitive, unlabelled lines continue the turn",
    parsed?.length === 3 && parsed[1].speaker === "Guest" && parsed[1].text === "Thanks for having me. It's great." && parsed[2].speaker === "Host", parsed);
  check("parseDialogue: a script where only one speaker talks is not a dialogue", parseDialogue("Host: one\nHost: two", ["Host", "Guest"]) === null);
  const turns = Array.from({ length: 40 }, (_, i) => ({ speaker: i % 2 ? "Guest" : "Host", text: para(i, 30) }));
  const dChunks = chunkDialogue(turns, 3000);
  check("chunkDialogue: whole turns packed in order within the limit",
    dChunks.length > 1 && dChunks.every((c) => c.reduce((n, l) => n + l.speaker.length + 2 + l.text.length + 1, 0) <= 3000) && dChunks.flat().map((l) => l.text).join("|") === turns.map((l) => l.text).join("|"), dChunks.map((c) => c.length));
  const hugeTurn = chunkDialogue([{ speaker: "Host", text: para(9, 1200) }], 3000);
  check("chunkDialogue: one over-long turn becomes several turns by the same speaker", hugeTurn.length > 1 && hugeTurn.flat().every((l) => l.speaker === "Host"), hugeTurn.length);
  const duoMode = { kind: "dialogue" as const, speakers: [{ label: "Host", voice: "Charon" }, { label: "CoHost", voice: "Aoede" }] as [{ label: string; voice: string }, { label: string; voice: string }] };
  const unlabelledPlan = planGoogleTtsChunks("Just one narrator talking.\n\nNo labels at all.", duoMode);
  check("planGoogleTtsChunks: an unlabelled two-host script falls back to the host voice alone",
    unlabelledPlan.mode.kind === "single" && unlabelledPlan.mode.voice === "Charon" && unlabelledPlan.chunks.every((c) => c.kind === "narration"), unlabelledPlan);
  const labelledPlan = planGoogleTtsChunks("Host: Hi [PAUSE] there.\nCoHost: Hello.", duoMode);
  check("planGoogleTtsChunks: a labelled script stays a dialogue, cleaned", labelledPlan.mode.kind === "dialogue" && labelledPlan.chunks[0].kind === "dialogue" && JSON.stringify(labelledPlan.chunks[0]).includes("Hi … there."), labelledPlan);

  // --- provider selection ---
  check("voiceProviderChoice: form labels and API shorthands", voiceProviderChoice(VOICE_PROVIDER_OPTIONS[0]) === "auto" && voiceProviderChoice("Cartesia") === "cartesia" && voiceProviderChoice("Google (Gemini TTS)") === "google" && voiceProviderChoice("gemini") === "google" && voiceProviderChoice("") === "auto");
  check("selectVoiceProvider: auto with only Google connected uses Google", selectVoiceProvider("auto", { cartesia: false, google: true }).provider === "google");
  check("selectVoiceProvider: auto with both connected keeps Cartesia", selectVoiceProvider("auto", { cartesia: true, google: true }).provider === "cartesia");
  check("selectVoiceProvider: explicit Google is honoured when both are connected", selectVoiceProvider("google", { cartesia: true, google: true }).provider === "google");
  const wrongPick = selectVoiceProvider("cartesia", { cartesia: false, google: true });
  check("selectVoiceProvider: an explicit choice that isn't connected never silently switches, and points at the one that is",
    wrongPick.provider === null && wrongPick.note.includes("Google Text-to-Speech"), wrongPick);
  const noneConnected = selectVoiceProvider("auto", { cartesia: false, google: false });
  check("selectVoiceProvider: nothing connected names both alternatives", noneConnected.provider === null && noneConnected.note.includes("Cartesia or Google"), noneConnected);
  check("scriptForSpeech: fullScript first, then segment scripts, never the raw reply",
    scriptForSpeech({ fullScript: " Full. ", segments: [{ script: "x" }] }) === "Full." &&
    scriptForSpeech({ segments: [{ script: "One." }, { name: "no script" }, { script: "Two." }] }) === "One.\n\nTwo." &&
    scriptForSpeech({ script: "{\"episodeTitle\": ..." }) === "");

  // --- podcast form and listing ---
  const podcastInputs = AGENT_META["podcast"].inputs;
  const field = (key: string) => podcastInputs.find((i) => i.key === key);
  check("podcast form: voice provider, Google voices and model are selects whose defaults are real options",
    ["voiceProvider", "googleVoice", "googleSecondVoice", "googleTtsModel"].every((k) => field(k)?.type === "select" && field(k)!.options!.includes(field(k)!.defaultValue ?? "")));
  check("podcast form: the Cartesia voice ID is no longer required (a Google-only workspace must be able to run)", field("voiceId")?.required !== true);
  check("podcast listing: Cartesia and Google are shown as alternatives, not both required",
    AGENTS.find((a) => a.slug === "podcast")!.integrations.some((i) => i.includes("Cartesia or Google")));
  check("GOOGLE_TTS: catalog key form, verifier and setup guide all exist",
    CONNECT_METHODS.GOOGLE_TTS?.method.kind === "key" && typeof KEY_VERIFIERS.GOOGLE_TTS === "function" && SETUP_GUIDES.GOOGLE_TTS?.provider === "GOOGLE_TTS");

  // --- response parsing ---
  const pcmBytes = Buffer.from([1, 0, 2, 0, 3, 0]);
  const okParsed = parseGoogleTtsResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcmBytes.toString("base64") } }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 250 } });
  check("parseGoogleTtsResponse: PCM, sample rate and usage come out", okParsed.ok && okParsed.sampleRate === 24000 && okParsed.pcm.equals(pcmBytes) && okParsed.outputTokens === 250, okParsed);
  const textOnly = parseGoogleTtsResponse({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "hello" }] } }] });
  check("parseGoogleTtsResponse: a 200 with text instead of audio is retryable", !textOnly.ok && textOnly.retryable, textOnly);
  const blocked = parseGoogleTtsResponse({ promptFeedback: { blockReason: "SAFETY" } });
  check("parseGoogleTtsResponse: a blocked prompt is not retried", !blocked.ok && !blocked.retryable, blocked);
  check("googleTtsCostUsd: priced per 1M tokens", Math.abs(googleTtsCostUsd("gemini-3.1-flash-tts-preview", 1_000_000, 1_000_000) - 21) < 1e-9);

  // --- verifier, with injected fetch ---
  const SECRET = "AIzaSy-test-secret-key-000";
  const gErr = (status: number, reason?: string, message = "boom") =>
    new Response(JSON.stringify({ error: { code: status, message, status: "X", details: reason ? [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason }] : [] } }), { status, headers: { "content-type": "application/json" } });
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const verifyWith = (res: () => Response | Promise<Response>) =>
    verifyGoogleTtsKey(SECRET, async (url, init) => {
      seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return res();
    });

  const vOk = await verifyWith(() => new Response(JSON.stringify({ name: "models/gemini-3.1-flash-tts-preview" }), { status: 200 }));
  check("verifyGoogleTtsKey: 200 from models.get is ok", vOk.ok, vOk);
  check("verifyGoogleTtsKey: one GET of the TTS model, key in the x-goog-api-key header, not the URL",
    seen[0].url.endsWith("/models/gemini-3.1-flash-tts-preview") && seen[0].headers["x-goog-api-key"] === SECRET && !seen[0].url.includes(SECRET), seen[0]);
  const vBad = await verifyWith(() => gErr(400, "API_KEY_INVALID", "API key not valid. Please pass a valid API key."));
  check("verifyGoogleTtsKey: API_KEY_INVALID says the key was rejected", !vBad.ok && vBad.reason.includes("rejected that API key"), vBad);
  const vDisabled = await verifyWith(() => gErr(403, "SERVICE_DISABLED", "Generative Language API has not been used in project 123 before or it is disabled."));
  check("verifyGoogleTtsKey: SERVICE_DISABLED says to enable the API", !vDisabled.ok && vDisabled.reason.includes("isn't enabled"), vDisabled);
  const vBlocked = await verifyWith(() => gErr(403, "API_KEY_SERVICE_BLOCKED"));
  check("verifyGoogleTtsKey: a key restricted to other APIs says to fix its restrictions", !vBlocked.ok && vBlocked.reason.includes("restricted to other Google APIs"), vBlocked);
  const vReferrer = await verifyWith(() => gErr(403, "API_KEY_HTTP_REFERRER_BLOCKED"));
  check("verifyGoogleTtsKey: a website/IP restriction says to remove the application restriction", !vReferrer.ok && vReferrer.reason.includes("application restriction"), vReferrer);
  const vQuota = await verifyWith(() => gErr(429, undefined, "Resource has been exhausted"));
  check("verifyGoogleTtsKey: 429 explains the quota", !vQuota.ok && vQuota.reason.includes("rate limit"), vQuota);
  const vHtml = await verifyWith(() => new Response("<html>bad gateway</html>", { status: 502 }));
  check("verifyGoogleTtsKey: a non-JSON 5xx still yields a reason", !vHtml.ok && vHtml.reason.includes("502"), vHtml);
  const vNet = await verifyGoogleTtsKey(SECRET, async () => { throw new TypeError("fetch failed"); });
  check("verifyGoogleTtsKey: a network error is reported, not thrown", !vNet.ok && vNet.reason.includes("Couldn't reach Google"), vNet);
  const vTimeout = await verifyGoogleTtsKey(SECRET, async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); });
  check("verifyGoogleTtsKey: a timeout says try again", !vTimeout.ok && vTimeout.reason.includes("in time"), vTimeout);
  check("verifyGoogleTtsKey: no reason ever contains the key", [vBad, vDisabled, vBlocked, vReferrer, vQuota, vHtml, vNet, vTimeout].every((r) => !r.ok && !r.reason.includes(SECRET)));
  check("describeGoogleError: 5xx is retryable, 4xx key problems are not", describeGoogleError(503, null).retryable && !describeGoogleError(400, null).retryable && describeGoogleError(429, null).retryable);

  // --- synthesis end to end, with injected fetch and sleep ---
  const pcmResponse = (samples: number[]) => {
    const buf = Buffer.alloc(samples.length * 2);
    samples.forEach((v, i) => buf.writeInt16LE(v, i * 2));
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: buf.toString("base64") } }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1000 },
    }), { status: 200 });
  };
  let calls = 0;
  const slept: number[] = [];
  const synth = await synthesizeGoogleSpeech({
    apiKey: SECRET,
    modelId: "gemini-3.1-flash-tts-preview",
    script: `${para(1, 20)}\n\n${para(2, 20)}`,
    mode: { kind: "single", voice: "Kore" },
    maxChunkChars: 250,
    sleep: async (ms) => { slept.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ error: { code: 429, message: "slow down", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3s" }] } }), { status: 429 });
      return pcmResponse(calls === 2 ? [1000, -1000] : [7, 8, 9]);
    },
  });
  check("synthesizeGoogleSpeech: a 429 is retried after Google's retryDelay", slept[0] === 3000 && calls === 3, { slept, calls });
  check("synthesizeGoogleSpeech: chunks are joined as PCM with a silence gap between them",
    synth.chunks === 2 && synth.sampleRate === 24000 && synth.pcm.length === 2 + 6000 + 3 && synth.pcm[0] === 1000 && synth.pcm[1] === -1000 && synth.pcm[2] === 0 && synth.pcm[6002] === 7 && synth.pcm[6004] === 9, { chunks: synth.chunks, len: synth.pcm.length });
  check("synthesizeGoogleSpeech: token usage and cost are summed across chunks", synth.outputTokens === 2000 && Math.abs(synth.costUsd - (200 * 1 + 2000 * 20) / 1e6) < 1e-12, synth);

  let failedMessage = "";
  try {
    await synthesizeGoogleSpeech({ apiKey: SECRET, modelId: "gemini-3.1-flash-tts-preview", script: "Hello.", mode: { kind: "single", voice: "Kore" }, sleep: async () => {}, fetchImpl: async () => gErr(403, "SERVICE_DISABLED") });
  } catch (err) {
    failedMessage = (err as Error).message;
  }
  check("synthesizeGoogleSpeech: a non-retryable error fails at once with the actionable reason, key-free", failedMessage.includes("isn't enabled") && !failedMessage.includes(SECRET), failedMessage);
  let emptyMessage = "";
  try {
    await synthesizeGoogleSpeech({ apiKey: SECRET, modelId: "gemini-3.1-flash-tts-preview", script: "  ", mode: { kind: "single", voice: "Kore" }, fetchImpl: async () => { throw new Error("must not be called"); } });
  } catch (err) {
    emptyMessage = (err as Error).message;
  }
  check("synthesizeGoogleSpeech: an empty script never calls Google", emptyMessage.includes("empty"), emptyMessage);

  check("concatPcm: odd trailing bytes are dropped, gap is silence", concatPcm([Buffer.from([1, 0, 9]), Buffer.from([2, 0])], 1000, 2).join(",") === "1,0,0,2");

  // --- MP3 encoding (real encoder, no network) ---
  const tone = new Int16Array(24000);
  for (let i = 0; i < tone.length; i++) tone[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24000));
  const mp3 = await encodeMp3(tone, 24000);
  check("encodeMp3: one second of 24 kHz PCM becomes an MPEG audio stream of plausible size",
    mp3.length > 5000 && mp3.length < 12000 && mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0, { length: mp3.length, head: [...mp3.subarray(0, 4)] });
}

// Google Ads through manager (MCC) accounts (lib/integrations/google-ads.ts).
// Injected fetch only — the picker walks customer_client under each accessible
// account, and every call must carry the chosen account's own manager.
{
  const adsError = (code: string, group = "authorizationError", message = "x") =>
    JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure", errors: [{ errorCode: { [group]: code }, message }] }] } });
  const cc = (id: string, level: number, name: string, extra: Record<string, unknown> = {}) => ({
    customerClient: { clientCustomer: `customers/${id}`, descriptiveName: name, level: String(level), status: "ENABLED", currencyCode: "USD", ...extra },
  });
  type Seen = { url: string; headers: Record<string, string> };
  const makeAdsFetch = (routes: Record<string, (seen: Seen) => Response | Promise<Response>>, seen: Seen[]) =>
    (async (url: string, init?: RequestInit) => {
      const s = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> };
      seen.push(s);
      const key = Object.keys(routes).find((k) => s.url.includes(k));
      if (!key) return new Response("not routed", { status: 599 });
      return routes[key](s);
    }) as unknown as typeof fetch;
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  // Composite value: parse, back-compat, round trip.
  const both = parseGoogleAdsAccountValue("1234567890@9876543210");
  check("ads value: customer@manager parses both ids", both?.customerId === "1234567890" && both?.loginCustomerId === "9876543210", both);
  const legacy = parseGoogleAdsAccountValue("123-456-7890");
  check("ads value: a bare dashed legacy id still parses, with no manager", legacy?.customerId === "1234567890" && legacy.loginCustomerId === undefined, legacy);
  check("ads value: blank, non-numeric and triple-part values are rejected", parseGoogleAdsAccountValue("") === null && parseGoogleAdsAccountValue("abc@123") === null && parseGoogleAdsAccountValue("1@2@3") === null);
  check("ads value: round trips", googleAdsAccountValue(both!) === "1234567890@9876543210" && googleAdsAccountValue(legacy!) === "1234567890");

  // Headers.
  const viaManager = buildGoogleAdsHeaders({ accessToken: "tok", developerToken: "dev", customerId: "1234567890", loginCustomerId: "9876543210", fallbackLoginCustomerId: "5555555555" });
  check("ads headers: a manager selection sends that manager as login-customer-id, not the env fallback", viaManager["login-customer-id"] === "9876543210" && viaManager["developer-token"] === "dev" && viaManager.Authorization === "Bearer tok", viaManager);
  const direct = buildGoogleAdsHeaders({ accessToken: "tok", developerToken: "dev", customerId: "1234567890", loginCustomerId: "1234567890", fallbackLoginCustomerId: "5555555555" });
  check("ads headers: direct access sends no login-customer-id and ignores the env fallback", !("login-customer-id" in direct), direct);
  const legacyHeaders = buildGoogleAdsHeaders({ accessToken: "tok", developerToken: "dev", customerId: "1234567890", fallbackLoginCustomerId: "555-555-5555" });
  check("ads headers: a legacy selection with no manager keeps the env fallback", legacyHeaders["login-customer-id"] === "5555555555", legacyHeaders);
  let threw = false;
  try {
    buildGoogleAdsHeaders({ accessToken: "tok", customerId: "1" });
  } catch {
    threw = true;
  }
  check("ads headers: no developer token is a server misconfiguration error", threw);

  // Error mapping.
  const testMode = googleAdsError(401, adsError("DEVELOPER_TOKEN_NOT_APPROVED", "authorizationError", "The developer token is only approved for use with test accounts."));
  check("ads errors: test-only developer token is known, fatal and says Test access", testMode.known && testMode.fatal && testMode.errorCode === "DEVELOPER_TOKEN_NOT_APPROVED" && /Test access/.test(testMode.message) && /apicenter/.test(testMode.hint), testMode);
  const testModeText = googleAdsError(401, "The developer token is only approved for use with test accounts. To access non-test accounts, apply for Basic or Standard access.");
  check("ads errors: the test-accounts sentence alone is enough to recognise it", testModeText.errorCode === "DEVELOPER_TOKEN_NOT_APPROVED", testModeText);
  const denied = googleAdsError(403, `[${adsError("USER_PERMISSION_DENIED")}]`, { customerId: "3333333333", loginCustomerId: "1111111111" });
  check("ads errors: USER_PERMISSION_DENIED (searchStream array body) names the account and manager, and says to pick it via its manager", denied.known && !denied.fatal && /333-333-3333/.test(denied.message) && /111-111-1111/.test(denied.message) && /via/.test(denied.hint) && /manager/.test(denied.hint), denied);
  const notAds = googleAdsError(401, adsError("NOT_ADS_USER", "authenticationError"));
  check("ads errors: NOT_ADS_USER says the login isn't on any Ads account", notAds.known && notAds.fatal && /isn't a user on any Google Ads account/.test(notAds.message), notAds);
  const mcc = googleAdsError(400, adsError("REQUESTED_METRICS_FOR_MANAGER", "queryError"), { customerId: "1111111111" });
  check("ads errors: metrics on a manager says to pick a client under it", mcc.known && /manager \(MCC\)/.test(mcc.message), mcc);
  const unknown = googleAdsError(500, "upstream exploded");
  check("ads errors: anything else keeps the raw status + body shape", !unknown.known && unknown.message === "Google Ads API 500: upstream exploded", unknown);

  // Account picker across a manager with clients, deduped against direct access.
  {
    const seen: Seen[] = [];
    const fetchImpl = makeAdsFetch(
      {
        "customers:listAccessibleCustomers": () => ok({ resourceNames: ["customers/2222222222", "customers/5555555555", "customers/1111111111"] }),
        "customers/1111111111/googleAds:searchStream": () =>
          ok([
            {
              results: [
                cc("1111111111", 0, "Agency MCC", { manager: true }),
                cc("2222222222", 1, "Direct Co"),
                cc("3333333333", 1, "Client A"),
                cc("4444444444", 1, "Closed Co", { status: "CLOSED" }),
                cc("4545454545", 1, "Cancelled Co", { status: "CANCELED" }),
                cc("6666666666", 1, "Sub MCC", { manager: true }),
              ],
            },
            { results: [cc("7777777777", 2, "Deep Client", { status: "SUSPENDED", currencyCode: "EUR" })] },
          ]),
        "customers/2222222222/googleAds:searchStream": () => ok([{ results: [cc("2222222222", 0, "Direct Co")] }]),
        "customers/5555555555/googleAds:searchStream": () => new Response(adsError("CUSTOMER_NOT_ENABLED"), { status: 403 }),
      },
      seen,
    );
    const options = await listGoogleAdsAccounts("tok", { fetch: fetchImpl, developerToken: "dev", fallbackLoginCustomerId: "9999999999" });
    const values = options.map((o) => o.value).sort();
    check(
      "ads picker: clients under the manager are listed with the manager as login; managers, closed, cancelled and not-enabled accounts are not",
      JSON.stringify(values) === JSON.stringify(["2222222222@2222222222", "3333333333@1111111111", "7777777777@1111111111"]),
      options,
    );
    const clientA = options.find((o) => o.value === "3333333333@1111111111");
    check("ads picker: label reads 'Client Name (123-456-7890) · via Manager'", clientA?.label === "Client A (333-333-3333) · via Agency MCC" && clientA?.detail === "USD", clientA);
    const deep = options.find((o) => o.value.startsWith("7777777777"));
    check("ads picker: a level-2 client under a sub-manager goes through the top manager, and a non-enabled status shows in the detail", deep?.label === "Deep Client (777-777-7777) · via Agency MCC" && deep?.detail === "EUR · suspended", deep);
    const directCo = options.find((o) => o.value.startsWith("2222222222"));
    check("ads picker: an account reachable directly AND via a manager appears once, as direct access", options.filter((o) => o.value.startsWith("2222222222")).length === 1 && directCo?.label === "Direct Co (222-222-2222)", options);
    const queries = seen.filter((s) => s.url.includes("searchStream"));
    check(
      "ads picker: each customer_client query authenticates as that accessible account (no login header, no env fallback) with the developer token",
      queries.length === 3 && queries.every((q) => !("login-customer-id" in q.headers) && q.headers["developer-token"] === "dev"),
      queries,
    );
    const listCall = seen.find((s) => s.url.includes("listAccessibleCustomers"));
    check("ads picker: listAccessibleCustomers doesn't send the env fallback manager", !!listCall && !("login-customer-id" in listCall.headers), listCall);

    // The resource entry and override resolution built on it.
    const ads = GOOGLE_RESOURCES.GOOGLE_ADS!;
    check("ads resource: a bare legacy id matches the listed option for that customer", findResourceOption(ads, options, "333-333-3333")?.value === "3333333333@1111111111");
    check("ads resource: a stale/forged manager resolves to the path the grant actually has", matchGoogleAdsOption(options, "3333333333@9999999999")?.value === "3333333333@1111111111");
    check("ads resource: an unreachable customer matches nothing", findResourceOption(ads, options, "8888888888") === undefined);
    const baseCreds = { access_token: "t", refresh_token: "r", expires_at: 0, scope: "s" };
    const applied = ads.apply({ ...baseCreds }, "3333333333@1111111111") as typeof baseCreds & { customer_id?: string; login_customer_id?: string };
    check("ads resource: apply stores customer_id and login_customer_id", applied.customer_id === "3333333333" && applied.login_customer_id === "1111111111", applied);
    check("ads resource: selected reads the composite back", ads.selected(applied as never) === "3333333333@1111111111");
    const reapplied = ads.apply({ ...applied }, "2222222222") as typeof applied;
    check("ads resource: applying a bare value drops a stale manager", reapplied.customer_id === "2222222222" && reapplied.login_customer_id === undefined, reapplied);
    check("ads resource: a connection saved before manager support still reads back as the bare id", ads.selected({ ...baseCreds, customer_id: "2222222222" } as never) === "2222222222");
    check("ads resource: a bare override of the saved customer keeps the saved manager", sameGoogleAdsChoice("3333333333", "3333333333@1111111111") === "3333333333@1111111111");
    check("ads resource: an override adding an unverified manager isn't taken on trust", sameGoogleAdsChoice("3333333333@9999999999", "3333333333") === null);
    check("ads resource: a different customer is a different choice", sameGoogleAdsChoice("2222222222", "3333333333@1111111111") === null);
  }

  // Nearer manager wins when a client is only reachable through managers.
  {
    const fetchImpl = makeAdsFetch(
      {
        "customers:listAccessibleCustomers": () => ok({ resourceNames: ["customers/1000000000", "customers/2000000000"] }),
        "customers/1000000000/googleAds:searchStream": () => ok([{ results: [cc("1000000000", 0, "Top MCC", { manager: true }), cc("2000000000", 1, "Sub MCC", { manager: true }), cc("3000000000", 2, "Client")] }]),
        "customers/2000000000/googleAds:searchStream": () => ok([{ results: [cc("2000000000", 0, "Sub MCC", { manager: true }), cc("3000000000", 1, "Client")] }]),
      },
      [],
    );
    const options = await listGoogleAdsAccounts("tok", { fetch: fetchImpl, developerToken: "dev" });
    check("ads picker: the nearer manager wins the dedupe", options.length === 1 && options[0].value === "3000000000@2000000000" && options[0].label === "Client (300-000-0000) · via Sub MCC", options);
  }

  // A test-only developer token fails the whole listing with the plain message.
  {
    const fetchImpl = makeAdsFetch(
      {
        "customers:listAccessibleCustomers": () => ok({ resourceNames: ["customers/1111111111"] }),
        "googleAds:searchStream": () => new Response(adsError("DEVELOPER_TOKEN_NOT_APPROVED", "authorizationError", "The developer token is only approved for use with test accounts."), { status: 401 }),
      },
      [],
    );
    let err: unknown = null;
    try {
      await listGoogleAdsAccounts("tok", { fetch: fetchImpl, developerToken: "dev" });
    } catch (e) {
      err = e;
    }
    check("ads picker: test-only developer token throws the mapped error", err instanceof GoogleAdsApiError && err.errorCode === "DEVELOPER_TOKEN_NOT_APPROVED", err);
  }

  // A timed-out account is offered bare rather than dropped.
  {
    const fetchImpl = makeAdsFetch(
      {
        "customers:listAccessibleCustomers": () => ok({ resourceNames: ["customers/1111111111"] }),
        "googleAds:searchStream": () => new Promise<Response>(() => {}),
      },
      [],
    );
    // The injected fetch ignores the abort signal, so the race below is what a
    // real hung socket looks like once the per-request timeout fires.
    const hanging = (async (url: string, init?: RequestInit) =>
      Promise.race([
        fetchImpl(url, init),
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
      ])) as unknown as typeof fetch;
    const options = await listGoogleAdsAccounts("tok", { fetch: hanging, developerToken: "dev", timeoutMs: 20 });
    check("ads picker: a timed-out account is still offered, bare", options.length === 1 && options[0].value === "1111111111@1111111111" && options[0].detail === "details unavailable", options);
  }

  // Handler calls: the selection's manager goes out, and known errors become AgentInputError.
  {
    const seen: Seen[] = [];
    const good = makeAdsFetch({ "customers/3333333333/googleAds:searchStream": () => ok([{ results: [{ campaign: { name: "C" } }] }]) }, seen);
    const chunks = await googleAdsSearchStream<{ results?: unknown[] }>("tok", { customerId: "3333333333", loginCustomerId: "1111111111" }, "SELECT campaign.name FROM campaign", { fetch: good, developerToken: "dev" });
    check("ads search: returns chunks and sends the selection's manager as login-customer-id", chunks.length === 1 && seen[0]?.headers["login-customer-id"] === "1111111111", seen);

    const deniedFetch = makeAdsFetch({ "googleAds:searchStream": () => new Response(`[${adsError("USER_PERMISSION_DENIED")}]`, { status: 403 }) }, []);
    let err: unknown = null;
    try {
      await googleAdsSearchStream("tok", { customerId: "3333333333" }, "q", { fetch: deniedFetch, developerToken: "dev" });
    } catch (e) {
      err = e;
    }
    check("ads search: USER_PERMISSION_DENIED surfaces as an AgentInputError with the pick-via-manager hint", err instanceof AgentInputError && /manager/.test(err.hint), err);

    const brokenFetch = makeAdsFetch({ "googleAds:searchStream": () => new Response("boom", { status: 502 }) }, []);
    err = null;
    try {
      await googleAdsSearchStream("tok", { customerId: "3333333333" }, "q", { fetch: brokenFetch, developerToken: "dev" });
    } catch (e) {
      err = e;
    }
    check("ads search: an unrecognised failure stays a plain error for liveCallFailed to wrap", err instanceof GoogleAdsApiError && !(err instanceof AgentInputError) && /Google Ads API 502/.test((err as Error).message), err);
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

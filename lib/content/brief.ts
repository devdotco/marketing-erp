import { bool, lines, num, str } from "@/lib/agents/inputs";
import { splitDomainEntries } from "./domains";
import {
  renderSourcingRules,
  renderStructureRules,
  renderVoiceRules,
  rotationFor,
  type EditorialProfile,
} from "./editorial";

/** A length band, not a single number. QC holds the draft to the band the writer was given. */
export interface LengthTarget {
  min: number;
  aim: number;
  max: number;
  label: string;
}

export function lengthBand(aim: number): LengthTarget {
  const target = Math.min(6000, Math.max(300, Math.round(aim)));
  return {
    min: Math.round(target * 0.85),
    aim: target,
    max: Math.round(target * 1.15),
    label: `${Math.round(target * 0.85)}-${Math.round(target * 1.15)}`,
  };
}

export interface InternalLinkTarget {
  url: string;
  anchor?: string;
}

/**
 * Everything the pipeline needs for one piece, resolved once.
 *
 * Every field here is answered by the Run form and changes the output. A field
 * that only decorates the prompt is worse than no field: it asks a person for
 * work and gives them nothing back for it.
 */
export interface ContentBrief {
  // What to write
  contentType: string;
  workingTitle: string;
  topicBrief: string;
  targetKeyword: string;
  secondaryKeywords: string[];
  searchIntent: string;
  funnelStage: string;
  keyQuestions: string[];
  mustCover: string[];
  mustAvoid: string[];

  // Who it is for, and how it should sound
  audienceDescription: string;
  readingLevel: string;
  tone: string;
  pointOfView: string;
  authorPersona: string;
  profile: EditorialProfile;

  // Evidence
  webResearch: boolean;
  includeStatistics: boolean;
  sourceRecencyYears: number;
  /** Bare hostnames only — these become web_search's allowed_domains. */
  preferredSources: string[];
  /** Bare hostnames only — web_search's blocked_domains, and QC's link check. */
  blockedDomains: string[];
  /** What was typed into Preferred sources that is not a hostname ("high authority sites like…"). */
  preferredSourceNotes: string[];
  /** What was typed into Never link that is not a hostname ("other competitors of…"). */
  blockedSourceNotes: string[];
  competitorUrls: string[];
  proofPoints: string[];

  // Links, promotion, compliance
  externalLinkCount: number;
  internalLinks: InternalLinkTarget[];
  productToFeature: string;
  promotionLevel: string;
  ctaGoal: string;
  ctaUrl: string;
  requiredDisclaimers: string[];
  complianceNotes: string;

  // Shape and delivery
  length: LengthTarget;
  shape: string;
  opener: string;
  includeFaq: boolean;
  includeImageBriefs: boolean;
  schemaType: string;
  geographicScope: string;
  maxRepairRounds: number;
  cmsTarget: string;
  requireApproval: boolean;

  // Context the workspace already holds
  brandContext: string;
  brandName: string;
  siteUrl: string;
}

export interface BrandProfile {
  businessName?: string | null;
  industry?: string | null;
  targetAudience?: string | null;
  websiteUrl?: string | null;
  uniqueValueProp?: string | null;
  brandVoice?: unknown;
  competitors?: string[];
}

/** brandVoice is a Json column: it may be a string, or an object from onboarding. */
function readBrandVoice(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => typeof v === "string" && v.trim() !== "")
      .map(([k, v]) => `${k}: ${String(v).trim()}`)
      .join("; ");
  }
  return "";
}

export function buildBrief(
  inputs: Record<string, unknown>,
  brand: BrandProfile | null,
  profile: EditorialProfile,
  seed: string,
): ContentBrief {
  const brandVoice = readBrandVoice(brand?.brandVoice);
  const toneChoice = str(inputs, "toneOverride", "Use Brand Profile default");
  const tone =
    toneChoice === "Use Brand Profile default"
      ? brandVoice || profile.voiceSummary
      : toneChoice.toLowerCase();

  const rotation = rotationFor(profile, seed);
  const shapeChoice = str(inputs, "articleShape", "Auto (rotate for variety)");
  const shape = shapeChoice.startsWith("Auto")
    ? rotation.shape
    : (profile.shapes.find((s) => matchesShape(s, shapeChoice)) ?? rotation.shape);

  const brandContext = [
    brand?.businessName ? `Business: ${brand.businessName}` : "",
    brand?.industry ? `Industry: ${brand.industry}` : "",
    brand?.uniqueValueProp ? `What sets them apart: ${brand.uniqueValueProp}` : "",
    brandVoice ? `Brand voice: ${brandVoice}` : "",
    brand?.targetAudience ? `Usual audience: ${brand.targetAudience}` : "",
    brand?.websiteUrl ? `Website: ${brand.websiteUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Free text in, filter-safe hosts out. See lib/content/domains.ts for the
  // run this killed.
  const preferred = splitDomainEntries(lines(inputs, "preferredSources", 12));
  const blocked = splitDomainEntries([...lines(inputs, "blockedDomains", 20), ...profile.bannedSourceDomains]);

  return {
    contentType: str(inputs, "contentType", "Blog post"),
    workingTitle: str(inputs, "workingTitle"),
    topicBrief: str(inputs, "topicBrief"),
    targetKeyword: str(inputs, "targetKeyword"),
    secondaryKeywords: lines(inputs, "secondaryKeywords", 10),
    searchIntent: str(inputs, "searchIntent", "Auto-detect"),
    funnelStage: str(inputs, "funnelStage", "Top of funnel (awareness)"),
    keyQuestions: lines(inputs, "keyQuestions", 12),
    mustCover: lines(inputs, "mustCover", 15),
    mustAvoid: lines(inputs, "mustAvoid", 15),

    audienceDescription: str(inputs, "audienceDescription", brand?.targetAudience ?? ""),
    readingLevel: str(inputs, "readingLevel", "General business reader"),
    tone,
    pointOfView: str(inputs, "pointOfView", profile.defaultPointOfView),
    authorPersona: str(inputs, "authorPersona"),
    profile,

    webResearch: bool(inputs, "webResearch", true),
    includeStatistics: bool(inputs, "includeStatistics", true),
    sourceRecencyYears: num(inputs, "sourceRecencyYears", 3, { min: 0, max: 20 }),
    preferredSources: preferred.domains,
    blockedDomains: blocked.domains,
    preferredSourceNotes: preferred.notes,
    blockedSourceNotes: blocked.notes,
    competitorUrls: lines(inputs, "competitorUrls", 5),
    proofPoints: lines(inputs, "proofPoints", 10),

    externalLinkCount: num(inputs, "externalLinkCount", 3, { min: 0, max: 8 }),
    internalLinks: parseInternalLinks(lines(inputs, "internalLinkTargets", 10)),
    productToFeature: str(inputs, "productToFeature"),
    promotionLevel: str(inputs, "promotionLevel", "Mention only where genuinely relevant"),
    ctaGoal: str(inputs, "ctaGoal"),
    ctaUrl: str(inputs, "ctaUrl"),
    requiredDisclaimers: lines(inputs, "requiredDisclaimers", 5),
    complianceNotes: str(inputs, "complianceNotes"),

    length: lengthBand(num(inputs, "wordCount", 1500, { min: 300, max: 6000 })),
    shape,
    opener: rotation.opener,
    includeFaq: bool(inputs, "includeFaq", false),
    includeImageBriefs: bool(inputs, "includeImageBriefs", false),
    schemaType: str(inputs, "schemaType", "Article"),
    geographicScope: str(inputs, "geographicScope", "Universal (no place-specific framing)"),
    maxRepairRounds: num(inputs, "maxRepairRounds", 2, { min: 0, max: 4 }),
    cmsTarget: str(inputs, "cmsTarget", "None (draft only)"),
    requireApproval: bool(inputs, "requireApproval", true),

    brandContext,
    brandName: brand?.businessName ?? "",
    siteUrl: brand?.websiteUrl ?? "",
  };
}

/** Match a form label like "Problem, failed fix, what works" to a profile shape. */
function matchesShape(shape: string, choice: string): boolean {
  const words = choice
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 4);
  if (words.length === 0) return false;
  const lower = shape.toLowerCase();
  return words.filter((w) => lower.includes(w)).length >= Math.ceil(words.length / 2);
}

/** "https://example.com/page | anchor text" or a bare URL, one per line. */
function parseInternalLinks(raw: string[]): InternalLinkTarget[] {
  const targets: InternalLinkTarget[] = [];
  for (const line of raw) {
    const [url, anchor] = line.split("|").map((part) => part.trim());
    if (!url || !/^https?:\/\//i.test(url)) continue;
    targets.push(anchor ? { url, anchor } : { url });
  }
  return targets;
}

export function renderLengthInstruction(target: LengthTarget): string {
  return (
    `LENGTH — a firm requirement, not a suggestion. Write the body, excluding the title, to ${target.min}-${target.max} words (aim for about ${target.aim}). ` +
    `Running materially over is as much a defect as coming up short: do not pad to reach the number, and do not overshoot it. ` +
    `Cover the topic completely within this length — if you have more material than fits, use FEWER sections rather than going long.`
  );
}

/**
 * The system prompt: the workspace's editorial profile, rendered.
 *
 * Stable for every article a workspace writes under one profile, which is what
 * makes it worth a cache breakpoint.
 */
export function buildSystemPrompt(brief: ContentBrief): string {
  const { profile } = brief;

  const povRule = brief.pointOfView.toLowerCase().startsWith("first")
    ? `PERSPECTIVE — first person plural is expected ("we", "our") where the piece speaks for ${brief.brandName || "the business"}. Never "I". Address the reader as "you".`
    : `PERSPECTIVE — no first person. No "I", "we", "us", "our". Address the reader directly as "you" where it reads naturally. No personal stories, no personal opinions.`;

  const geoRule = brief.geographicScope.toLowerCase().startsWith("universal")
    ? "GEOGRAPHIC SCOPE — write for a general audience anywhere. No place name in the title or in any heading, and no section built around one jurisdiction. A location may appear as incidental detail in the one sentence a cited fact needs it. Where a topic genuinely varies by place, write the universal version: say that rules and costs vary and tell the reader what to check."
    : `GEOGRAPHIC SCOPE — this piece is deliberately scoped to: ${brief.geographicScope}. Write it for that audience specifically, and make the scope explicit early.`;

  return [
    `You are a senior content writer producing a publication-ready ${brief.contentType.toLowerCase()} for a company's own site.`,
    "It has to be good enough that a knowledgeable reader finishes it and a search engine has a reason to rank it. Both, not either.",
    "",
    povRule,
    "",
    renderVoiceRules(profile),
    "",
    renderStructureRules(profile),
    "",
    geoRule,
    "",
    renderSourcingRules(profile, brief.externalLinkCount),
    "",
    'Return the finished piece through the submit_article tool. Each section\'s blocks array holds its content in order: a paragraph (type="paragraph" with runs) or a list (type="list" with items, ordered true for numbered). To hyperlink, set a run\'s link field. To bold a list item\'s lead-in label, set that run\'s bold field. Never return the article as prose in your reply.',
  ].join("\n");
}

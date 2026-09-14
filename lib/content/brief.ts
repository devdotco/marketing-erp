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

/**
 * The brief's word count is a FLOOR, not the middle of a band. Owner decision,
 * 2026-09-14: a live run (cmu1kgojj…) asked for 1500 words, the writer
 * delivered 1299, and the old ±15% band (1275-1725) passed it — a draft could
 * come in nearly 15% short and still clear QC. The band is now
 * [target, target × 1.25]: never under, and up to a quarter over is fine
 * (topics genuinely vary in how much they need). See qc.ts's word-count check
 * and draft.ts's underLength() for where this is enforced and explained back
 * to the writer with the exact word deficit.
 */
export function lengthBand(aim: number): LengthTarget {
  const target = Math.min(6000, Math.max(300, Math.round(aim)));
  const max = Math.round(target * 1.25);
  return {
    min: target,
    aim: target,
    max,
    label: `${target}-${max}`,
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
  /** Ask the writer to describe images in prose (placement/description/alt) — no generation, no cost. */
  includeImageBriefs: boolean;
  /** Which visual block types the writer may use. See lib/content/article.ts's Block union. */
  visualTypes: { charts: boolean; tables: boolean; callouts: boolean; images: boolean };
  /** Free text, entered per-run: "what visuals do you want and where". */
  visualsRequest: string;
  /** How many `image` blocks may actually be generated (hero counts). Cost control — see lib/images/generate.ts. */
  maxImages: number;
  /** How AI-generated images should look, folded into every image prompt. */
  imageStyle: string;
  /**
   * Not a per-run input (kept out of the Visuals input group deliberately, to
   * keep the form small) — a fixed cap tied to visualTypes, computed in
   * buildBrief below. Still lives on the brief, per the honesty-rules
   * requirement that visual limits "come from the brief".
   */
  maxCharts: number;
  maxTables: number;
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
    visualTypes: {
      charts: bool(inputs, "includeCharts", false),
      tables: bool(inputs, "includeTables", false),
      callouts: bool(inputs, "includeCallouts", false),
      images: bool(inputs, "includeAiImages", false),
    },
    visualsRequest: str(inputs, "visualsRequest"),
    maxImages: num(inputs, "maxImages", 2, { min: 0, max: 6 }),
    imageStyle: str(inputs, "imageStyle", "Clean editorial photography"),
    // Fixed caps rather than their own inputs — see the ContentBrief doc
    // comment above. 2 of each is enough for any article at the lengths this
    // engine writes without turning the piece into a slide deck.
    maxCharts: bool(inputs, "includeCharts", false) ? 2 : 0,
    maxTables: bool(inputs, "includeTables", false) ? 2 : 0,
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
    `LENGTH — a firm requirement, not a suggestion. Write the body, excluding the title, to AT LEAST ${target.min} words, and no more than ${target.max}. ` +
    `${target.min} is a FLOOR: coming in under it is as much a defect as running past ${target.max} is. Do not pad to reach the number, and do not stop short of it either — expand thin sections with real substance instead. ` +
    `Visual blocks (tables, charts, callouts, images) do not count toward this figure — only prose paragraphs and lists do — so do not rely on a chart to make up word count. ` +
    `Cover the topic completely within this length — if you have more material than fits, use FEWER sections rather than going long; if a section runs thin, deepen it rather than adding another shallow one.`
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
    renderVisualsRules(brief),
    "",
    'Return the finished piece through the submit_article tool. Each section\'s blocks array holds its content in order: a paragraph (type="paragraph" with runs) or a list (type="list" with items, ordered true for numbered). To hyperlink, set a run\'s link field. To bold a list item\'s lead-in label, set that run\'s bold field. Never return the article as prose in your reply.',
  ].join("\n");
}

/**
 * The rules for the top-level `visuals` array (table/callout/stat/chart/
 * image) — what they are for, the hard cap on each, the submission mechanics
 * (a separate array, not embedded in a section's blocks — see
 * SUBMIT_ARTICLE_TOOL's own doc comment in article.ts for why), and the
 * honesty rule QC actually enforces (lib/content/qc.ts's
 * findUntracedVisualData): a chart or stat with an invented number, or one
 * with no verified source, is a defect, not a style choice. Rendered even
 * when every visual type is off, so a model that ignores the constraint at
 * least sees why.
 */
function renderVisualsRules(brief: ContentBrief): string {
  const allowed: string[] = [];
  if (brief.visualTypes.charts) allowed.push(`charts ("chart", at most ${brief.maxCharts})`);
  if (brief.visualTypes.tables) allowed.push(`comparison tables ("table", at most ${brief.maxTables})`);
  if (brief.visualTypes.callouts) allowed.push('callout boxes ("callout": key_takeaway, tip, warning, or stat)');
  if (brief.visualTypes.images) allowed.push(`AI-generated images ("image", at most ${brief.maxImages} — write a concrete image_prompt, not a description of a stock photo you imagine exists)`);

  if (allowed.length === 0) {
    return "VISUALS — this brief does not ask for any. Submit visuals as an empty array.";
  }

  const rules = [
    `Allowed visual types for this piece: ${allowed.join("; ")}. Never submit a type not listed here.`,
    'Each entry in the visuals array carries EVERY field the schema defines, whatever its type — fill in the ones that apply and leave the rest "" (strings), [] (arrays), or "none" (kind/slot). Name where it goes with after_section_index: -1 for after the intro, 0 for after the first section, 1 for after the second, and so on.',
    "HONESTY, NO EXCEPTIONS: every chart data point and every stat value must be one of the CLAIM EVIDENCE facts below, and must carry that claim's exact source_url. Never estimate, round to a nicer number, or invent a data point to fill out a chart — an untraceable value is worse than no chart.",
    "A comparison table may hold qualitative information freely (features, yes/no, short descriptions), but any FIGURE in a table cell follows the identical rule: it must be a number that appears in a verified claim.",
    "A chart or stat with no real, verified data behind it: do not submit one. State the point in prose instead.",
    "A callout's body is plain text only — no links, no bold. A link belongs in the prose, not inside a callout.",
    brief.visualsRequest ? `WHAT THIS RUN ASKED FOR, SPECIFICALLY: ${brief.visualsRequest}` : "",
    brief.visualTypes.images
      ? `IMAGE STYLE: ${brief.imageStyle}. Every image_prompt should read naturally in that style. Never describe a real, named, identifiable person; never a logo, brand mark, or trademark; never readable text rendered inside the image.`
      : "",
  ].filter(Boolean);

  return `VISUALS\n${rules.map((r) => `- ${r}`).join("\n")}`;
}

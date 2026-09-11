/**
 * Editorial profiles: what a workspace's writing is allowed to sound like.
 *
 * The pipeline in this folder is an engine. It researches, drafts, checks and
 * repairs, and it has no opinion about voice. Every rule it enforces comes from
 * one of these profiles, which belong to the workspace and are editable by it.
 *
 * That separation is the point. The first version of this hardcoded one
 * company's house style — derived from our own back catalogue, complete with our
 * banned words and our structural preferences — straight into the prompt and the
 * quality checks. It produced good articles for exactly one tenant. Anyone else
 * would have been writing in our voice and failing QC on our rules.
 *
 * A preset is only a starting point. `resolveProfile` layers a workspace's saved
 * overrides on top, so a tenant can take "Conversational B2C", ban three more
 * phrases their legal team dislikes, and keep the rest.
 */

export interface EditorialProfile {
  /** Preset this came from, or "custom" once a workspace has edited it. */
  key: string;
  name: string;
  description: string;

  // ── Voice ────────────────────────────────────────────────────────────────
  /** How the writing should read, in the profile's own words. Goes in the prompt verbatim. */
  voiceSummary: string;
  /** Extra voice directives, one per line, appended to the prompt as rules. */
  voiceRules: string[];
  defaultPointOfView: string;
  /** "US English", "UK English", "Australian English"… Drives spelling. */
  language: string;
  useContractions: boolean;
  allowEmDash: boolean;

  // ── Prohibitions. Each is enforced in the prompt AND checked in code. ─────
  /** Single words that must not appear anywhere, title included. */
  bannedWords: string[];
  /** Multi-word stock phrasing that must not appear. */
  bannedPhrases: string[];
  /** Section headings that must not be used, lowercased. */
  bannedHeadings: string[];
  /** Whole constructions, described in prose. Prompt-only — too subtle to regex. */
  bannedConstructions: string[];
  /** Words that must not appear more than once in an article. */
  rationedWords: string[];
  /** Absolutes that may not stand on the writer's own authority. */
  hardClaimWords: string[];
  /** True to flag "The cleaning worked. The equipment didn't." */
  banNegationFlip: boolean;
  /** True to flag invented clock times and day-of-week scene setting. */
  banInventedPrecision: boolean;

  // ── Structure ────────────────────────────────────────────────────────────
  minSections: number;
  maxSections: number;
  maxParagraphSentences: number;
  requireIntro: boolean;
  /** Guidance on how headings should be written. */
  headingStyle: string;
  /** True to require headings to vary in grammatical shape. */
  requireHeadingVariety: boolean;
  listPolicy: string;

  // ── Rotation: how a piece opens, and how it is organised. ─────────────────
  openers: string[];
  shapes: string[];

  // ── Sourcing and links ───────────────────────────────────────────────────
  requireCitations: boolean;
  /** Never linked, never returned by search. */
  bannedSourceDomains: string[];
  sourceGuidance: string;
  maxAnchorWords: number;
}

/** The fields a workspace may override. Everything, in practice. */
export type EditorialOverrides = Partial<Omit<EditorialProfile, "key">>;

// ─── Shared building blocks ──────────────────────────────────────────────────

/**
 * Craft failings rather than house style: these read as machine-written to any
 * audience, in any voice, so every preset inherits them. A workspace that wants
 * one back can remove it from its own profile.
 */
const COMMON_BANNED_PHRASES = [
  "in today's world",
  "in the modern world",
  "ever-changing",
  "ever-evolving",
  "navigate the complexities",
  "delve into",
  "it's important to note",
  "it's worth noting",
  "when it comes to",
  "plays a vital role",
  "plays a key role",
  "plays a major role",
];

const COMMON_BANNED_HEADINGS = [
  "conclusion",
  "in conclusion",
  "final thoughts",
  "key takeaways",
  "wrapping up",
];

const COMMON_HARD_CLAIMS = [
  "always",
  "never fails",
  "guarantees",
  "guaranteed",
  "ensures",
  "eliminates",
  "foolproof",
  "100% secure",
  "proven to",
  "the best way",
  "the only option",
  "the only way",
  "industry-leading",
  "impossible",
];

const COMMON_OPENERS = [
  "OPENER: drop the reader into a concrete, verifiable situation relevant to the topic. Describe a situation a reader recognizes, not a character you made up.",
  "OPENER: lead with the stakes the reader actually feels — a cost, a risk, a deadline, a consequence. Name it in the first sentence.",
  "OPENER: open on a single counterintuitive, cited figure, and spend the rest of the intro on what it implies. Cite it with a real link, or use a different opener.",
  "OPENER: make a flat, confident assertion in the first sentence, then earn it across the rest of the intro. No throat-clearing before the claim.",
  "OPENER: start with the exact question the reader arrived with, phrased the way they would phrase it, then move straight into answering it.",
  "OPENER: open on a compressed real example — a named, verifiable case, company, or event. Two or three sentences, then pivot to the general point.",
  "OPENER: open on a before/after contrast in concrete terms: what this used to involve, what it involves now.",
  "OPENER: correct a specific, widely-held misconception in the first two sentences, then spend the intro on what is true instead.",
];

const COMMON_SHAPES = [
  "SHAPE: organize as a PROGRESSION over time or stages — before, during, after, or step 1 through step N. Each section is a distinct phase.",
  "SHAPE: organize around DISTINCT CASES or categories. Each section is a different type, scenario, or situation treated on its own terms.",
  "SHAPE: organize as PROBLEM, then why the obvious fix fails, then what actually works. The middle section is the pivot, not filler.",
  "SHAPE: organize around the DECISIONS the reader has to make, one per section, each with what it turns on and what it costs to get wrong.",
  "SHAPE: organize by WHO IS INVOLVED — each section takes the perspective of a different party, and the piece resolves where their interests meet.",
  "SHAPE: organize as a set of QUESTIONS the reader is actually asking, in the order they would ask them. Each section answers one and stops.",
  "SHAPE: organize from most to least consequential. Open on the thing that matters most and let each section descend in stakes.",
  "SHAPE: organize around what GOES WRONG — each section a common failure, what causes it, and what to do instead.",
];

const COMMON_SOURCE_GUIDANCE =
  "Favor primary and authoritative sources: original studies, government (.gov) and university (.edu) pages, standards bodies, major research firms, and major publications. Avoid content farms and low-authority blogs. Every external link must point at the specific page that supports the sentence, never a homepage or a category index.";

/**
 * The baseline. Deliberately opinionated about craft and silent about identity:
 * it bans what reads as machine-written without imposing anyone's house style.
 */
export const NEUTRAL_PROFILE: EditorialProfile = {
  key: "neutral-professional",
  name: "Neutral professional",
  description:
    "Clear, measured business writing with no house idiosyncrasies. A sound default for any company, and the base every other preset starts from.",

  voiceSummary:
    "Write as a knowledgeable practitioner explaining something to a capable colleague. Confident, specific, and unhurried. Never breathless, never padded.",
  voiceRules: [
    "VARY THE CADENCE. Break long explanatory sentences with short declarative ones. A run of same-length sentences is the clearest sign of machine writing.",
    "PREFER THE SIMPLE WORD. Use \"use\", not \"utilize\". Cut any word that is doing no work.",
    "NO RULE-OF-THREE PADDING. Avoid tricolons used purely for cadence (\"expensive, unpredictable, and time-consuming\").",
    "NO HEDGE-STACKING. Do not pile \"may\", \"often\", \"generally\", \"typically\" and \"tends to\" until nothing is asserted. Make the claim or cut it.",
    "BE CONCRETE. Prefer the specific example, figure, or consequence over the general statement about it.",
  ],
  defaultPointOfView: "Third person (no I, we, our)",
  language: "US English",
  useContractions: true,
  allowEmDash: true,

  bannedWords: ["really", "basically", "very", "extremely"],
  bannedPhrases: COMMON_BANNED_PHRASES,
  bannedHeadings: COMMON_BANNED_HEADINGS,
  bannedConstructions: [],
  rationedWords: [],
  hardClaimWords: COMMON_HARD_CLAIMS,
  banNegationFlip: false,
  banInventedPrecision: true,

  minSections: 3,
  maxSections: 6,
  maxParagraphSentences: 5,
  requireIntro: true,
  headingStyle:
    "Headings should say something rather than label a topic. Prefer a statement (\"Compounding Works Against You\") or, for how-to sections, an imperative (\"Preserve Evidence Early\"). No terminal punctuation, except a question mark on a genuine question.",
  requireHeadingVariety: true,
  listPolicy:
    "Use a real list whenever you present a set of discrete, parallel items — categories, steps, options, things to check. Do not fake one by stacking short paragraphs, and never promise a list with a colon and fail to deliver it.",

  openers: COMMON_OPENERS,
  shapes: COMMON_SHAPES,

  requireCitations: true,
  bannedSourceDomains: ["wikipedia.org"],
  sourceGuidance: COMMON_SOURCE_GUIDANCE,
  maxAnchorWords: 4,
};

function preset(key: string, name: string, description: string, overrides: EditorialOverrides): EditorialProfile {
  return { ...NEUTRAL_PROFILE, ...overrides, key, name, description };
}

export const EDITORIAL_PRESETS: EditorialProfile[] = [
  NEUTRAL_PROFILE,

  preset(
    "conversational-b2c",
    "Conversational B2C",
    "Warm and direct, for consumer audiences. Speaks to the reader, allows the brand to say \"we\", and keeps paragraphs short.",
    {
      voiceSummary:
        "Write the way a friendly expert talks: second person, short paragraphs, plain words, a little warmth. Helpful before it is impressive.",
      voiceRules: [
        "ADDRESS THE READER AS \"YOU\" throughout. This is a conversation, not a report.",
        "KEEP SENTENCES SHORT by default, and let the occasional longer one carry the nuance.",
        "NO CORPORATE REGISTER. Nothing \"leverages\", \"empowers\", or \"unlocks\".",
        "VARY THE CADENCE. Even a conversational piece goes flat when every sentence is the same length.",
      ],
      defaultPointOfView: "First person plural (we, our)",
      maxParagraphSentences: 3,
      maxSections: 7,
      headingStyle:
        "Headings should sound like something a person would say. Questions are welcome when the section genuinely answers one. No terminal punctuation other than a question mark.",
    },
  ),

  preset(
    "technical-practitioner",
    "Technical practitioner",
    "For readers who do the work. Assumes domain fluency, skips the basics, and will not accept an unsourced number.",
    {
      voiceSummary:
        "Write for someone who already knows the fundamentals and wants the specifics. Precise, unhyped, and willing to say when something is a trade-off rather than a win.",
      voiceRules: [
        "DO NOT EXPLAIN THE BASICS. The reader knows the domain. Spend the words on what is actually contested or hard.",
        "NAME THE TRADE-OFF. Any recommendation that has a cost must state the cost.",
        "NO MARKETING REGISTER. No superlatives, no transformation language.",
        "PREFER PRECISE NOUNS over general ones, and units over adjectives.",
      ],
      maxParagraphSentences: 6,
      maxSections: 8,
      hardClaimWords: [...COMMON_HARD_CLAIMS, "seamless", "effortless", "revolutionary"],
    },
  ),

  preset(
    "executive-brief",
    "Executive brief",
    "Short, decision-oriented, and front-loaded. For readers who will read the first paragraph and skim the rest.",
    {
      voiceSummary:
        "Lead with the conclusion and defend it. Every section should be useful to someone who reads only its first sentence.",
      voiceRules: [
        "FRONT-LOAD EVERYTHING. The first sentence of the article, and of every section, carries the point.",
        "QUANTIFY WHERE YOU CAN, and cite it where you quantify.",
        "NO BUILD-UP. Do not save the conclusion for the end.",
        "CUT ANY SENTENCE that does not change what the reader would decide.",
      ],
      minSections: 3,
      maxSections: 5,
      maxParagraphSentences: 4,
      shapes: [
        "SHAPE: lead with the recommendation, then the evidence for it, then what would have to be true for it to be wrong.",
        "SHAPE: organize around the DECISIONS on the table, one per section, each with its cost and its deadline.",
        "SHAPE: organize from most to least consequential, and stop when the stakes stop mattering.",
        "SHAPE: organize as the two or three options available, each on its own terms, and close on which one the evidence favors.",
      ],
    },
  ),

  /**
   * Ours, kept as one preset among several rather than as the engine's opinion.
   * These rules were derived from ~958 published DEV.co / Digital.Marketing
   * articles and hardened against real QC failures, so they are worth keeping —
   * but they are a house style, not a standard, and no tenant should inherit
   * them by default.
   */
  preset(
    "devco-house",
    "DEV.co house voice",
    "The DEV.co and Digital.Marketing house style, derived from ~958 published articles. Strict: bans several constructions outright and rations specific words.",
    {
      voiceSummary:
        "Write as a world-class expert sharing hard-won insight with confidence and a little warmth. Never a machine filling a template. The piece should hold a reader who knows the subject and survive an AI-detection tool.",
      voiceRules: [
        "EARN THE OPEN; DON'T ANNOUNCE IT. Never open by restating the title or the topic. Follow the per-article opener directive.",
        "HARD BAN: do not open with \"When people picture/think about X, they picture Y, what they miss is Z\" or any close variant. It is the most detectable opener there is.",
        "VARY THE CADENCE DELIBERATELY. Break long explanatory sentences with short declarative punches and the occasional fragment. A run of same-length 18-24 word sentences is the clearest AI tell there is.",
        "HEADINGS ARE FULL ASSERTIONS, NOT LABELS.",
        "NO INVENTED PEOPLE. Never open or illustrate with a made-up individual (\"an Ohio mom\", \"one business owner\"). Real, named, verifiable examples are welcome; invented ones are banned.",
        "SIMPLE, ACTIVE WORDS. Never: delve, realm, utilize, tapestry, landscape, exotic as a descriptor for something ordinary.",
        "NO RULE-OF-THREE PADDING, NO HEDGE-STACKING, NO FILLER VERBS.",
        "DO NOT BOLD BODY PROSE. The only place bold is allowed is a short lead-in label at the start of a list item.",
        "WRITE ADVICE, NOT META-FRAMES. Do not tell the reader how to categorize something (\"treat it as\", \"think of this as\", \"what this means for you\", \"at its core\", \"at the end of the day\"). State the concrete action or consequence directly.",
        "FINAL CHECK: re-read as if you were an AI detector. Rewrite any sentence that feels machine-generated and kill any uniform rhythm.",
      ],
      allowEmDash: false,
      bannedWords: ["really", "actually", "very", "basically", "just", "extremely", "gap", "gaps"],
      bannedPhrases: [
        ...COMMON_BANNED_PHRASES,
        "at the end of the day",
        "at its core",
        "the bottom line",
        "final thoughts",
        "on the surface",
        "in other words",
        "treat it as",
        "think of it as",
        "think of this as",
        "what this means for you",
        "that's a sign",
        "this matters because",
      ],
      bannedHeadings: [
        ...COMMON_BANNED_HEADINGS,
        "the bottom line",
        "the big picture",
        "putting it into practice",
      ],
      bannedConstructions: [
        "THE \"IT'S NOT THAT X, IT'S THAT Y\" REFRAME, in every shape it takes: \"The problem isn't the tooling, it's the handoff.\" Do not set up a wrong answer just to swap in the right one. State the real point directly.",
        "THE OBJECTION PRE-EMPT AND THE MATH RE-LABEL: \"That's not cynicism. It's arithmetic.\" Never answer an objection the reader has not raised, and never re-label your own point as arithmetic to borrow authority.",
        "THE BEFORE/AFTER RULE PIVOT: \"That was the old rule. The rule has shifted.\" The words \"the old rule\" and \"the new rule\" are banned outright. A genuine before/after contrast is fine in concrete terms.",
        "THE BANNED WORD \"GAP\" hides the specific thing that is missing. Name that thing instead: the missing maintenance record, the hour nobody logged, the question the buyer will ask.",
      ],
      rationedWords: ["quietly"],
      banNegationFlip: true,
      banInventedPrecision: true,
      maxParagraphSentences: 4,
      requireHeadingVariety: true,
      headingStyle:
        "Prefer a subject+verb statement (\"Compounding Works Against You\") or, for how-to sections, an imperative (\"Preserve Evidence Early\"). A short parenthetical rider is a welcome flourish, used sparingly. No terminal punctuation, except a question mark on a genuine question.",
      bannedSourceDomains: ["wikipedia.org"],
      maxAnchorWords: 3,
    },
  ),
];

export function getPreset(key: string): EditorialProfile {
  return EDITORIAL_PRESETS.find((p) => p.key === key) ?? NEUTRAL_PROFILE;
}

/**
 * A workspace's effective profile: its chosen preset with its own overrides on
 * top. Unknown keys in stored overrides are ignored rather than trusted, so a
 * hand-edited row cannot inject prompt text through a field the engine does not
 * know about.
 */
export function resolveProfile(
  presetKey: string | null | undefined,
  overrides: unknown,
): EditorialProfile {
  const base = getPreset(presetKey ?? NEUTRAL_PROFILE.key);
  if (!overrides || typeof overrides !== "object") return base;

  const raw = overrides as Record<string, unknown>;
  const merged: EditorialProfile = { ...base };
  let touched = false;

  for (const field of Object.keys(base) as Array<keyof EditorialProfile>) {
    if (field === "key" || field === "name" || field === "description") continue;
    const value = raw[field];
    if (value === undefined || value === null) continue;

    const expected = base[field];
    if (Array.isArray(expected)) {
      if (!Array.isArray(value)) continue;
      (merged[field] as string[]) = value.filter((v): v is string => typeof v === "string");
      touched = true;
    } else if (typeof expected === "boolean" && typeof value === "boolean") {
      (merged[field] as boolean) = value;
      touched = true;
    } else if (typeof expected === "number" && typeof value === "number" && Number.isFinite(value)) {
      (merged[field] as number) = value;
      touched = true;
    } else if (typeof expected === "string" && typeof value === "string") {
      (merged[field] as string) = value;
      touched = true;
    }
  }

  if (touched) {
    merged.key = "custom";
    merged.name = `${base.name} (customised)`;
  }
  return merged;
}

// ─── Rendering the profile into prompt text ──────────────────────────────────

/** FNV-1a, so the rotation is stable for a brief and spread across briefs. */
function fnv1a(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Opener and shape for one article, seeded off different slices of the same
 * identity so the two levers do not move in lockstep. This is what stops a
 * workspace's tenth article reading like its first.
 */
export function rotationFor(
  profile: EditorialProfile,
  seed: string,
): { opener: string; shape: string } {
  const openers = profile.openers.length > 0 ? profile.openers : COMMON_OPENERS;
  const shapes = profile.shapes.length > 0 ? profile.shapes : COMMON_SHAPES;
  return {
    opener: openers[fnv1a(seed) % openers.length]!,
    shape: shapes[fnv1a(`shape:${seed}`) % shapes.length]!,
  };
}

function bullet(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function list(items: string[]): string {
  return items.map((item) => `"${item}"`).join(", ");
}

export function renderVoiceRules(profile: EditorialProfile): string {
  const blocks: string[] = [
    `VOICE — ${profile.name}`,
    profile.voiceSummary,
  ];

  if (profile.voiceRules.length > 0) blocks.push(bullet(profile.voiceRules));

  const mechanics = [
    `Write in ${profile.language}, including spelling, throughout.`,
    profile.useContractions
      ? "Use contractions where they read naturally."
      : "Do not use contractions.",
    profile.allowEmDash
      ? ""
      : "NEVER use em-dashes. Replace every one with a comma, a period, or a rewritten clause.",
  ].filter(Boolean);
  blocks.push(bullet(mechanics));

  if (profile.bannedWords.length > 0) {
    blocks.push(
      `BANNED WORDS — these do not appear anywhere, in the title and headings as much as in the body: ${list(profile.bannedWords)}.`,
    );
  }
  if (profile.bannedPhrases.length > 0) {
    blocks.push(`BANNED PHRASES — do not use any of these: ${list(profile.bannedPhrases)}.`);
  }
  if (profile.rationedWords.length > 0) {
    blocks.push(
      `RATIONED WORDS — each of these may appear at most ONCE in the whole article, and never in the title: ${list(profile.rationedWords)}.`,
    );
  }
  if (profile.banNegationFlip) {
    blocks.push(
      "NEVER USE THE NEGATION FLIP — a short assertion immediately undercut by its own negation (\"The cleaning worked. The equipment didn't.\"). Make the reversal inside a single sentence, or state the point plainly and move on.",
    );
  }
  if (profile.banInventedPrecision) {
    blocks.push(
      "NO FABRICATED PRECISION. Do not anchor a scene with an invented clock time (\"at 2:47\"), a specific day of the week (\"on a Tuesday afternoon\"), or a made-up measurement. Concrete scenes are welcome; invented precision is not.",
    );
  }
  if (profile.bannedConstructions.length > 0) {
    blocks.push(
      `HARD-BANNED CONSTRUCTIONS — these never appear, in the title, a heading, or the body. They are not stylistic preferences; a draft containing one is rejected.\n${bullet(profile.bannedConstructions)}`,
    );
  }

  blocks.push(
    "FINAL CHECK: re-read the draft as a skeptical editor. Rewrite anything that reads as machine-written, and kill any uniform rhythm.",
  );

  return blocks.join("\n\n");
}

export function renderStructureRules(profile: EditorialProfile): string {
  const rules = [
    profile.requireIntro
      ? "INTRO IS NON-NEGOTIABLE: populate intro_blocks with 1-2 paragraphs before the first subheading. An article that dives straight into a subheading is a hard defect."
      : "An intro is optional for this profile.",
    `${profile.minSections}-${profile.maxSections} body sections, each under its own subheading.`,
    profile.headingStyle,
    profile.requireHeadingVariety
      ? "HEADING VARIETY IS NON-NEGOTIABLE. Never cast all section headings in the same grammatical mold. A reader who can predict the shape of the next heading from the last one is reading a machine. Scan all your headings before submitting."
      : "",
    profile.bannedHeadings.length > 0
      ? `BANNED HEADINGS: ${list(profile.bannedHeadings)}. Let the final section earn a real heading.`
      : "",
    "EVERY SECTION BODY MUST STAND ALONE. The first sentence of every section must make full sense without reading the heading. Never open a section with \"Because\", \"Since\", \"This means\", \"And\", or any word that treats the heading as the first half of the sentence.",
    "EVERY SUBHEADING MUST HAVE A BODY. If a planned section has nothing worth saying, delete the heading too. When trimming to length, cut whole sections rather than emptying one.",
    `NO paragraph exceeds ${profile.maxParagraphSentences} sentences. If an idea runs longer, split it.`,
    profile.listPolicy,
    "Each list item begins with a short bold lead-in label (1-4 words), then a period, then 1-3 plain sentences. Keep the bold to the label.",
    "A conclusion only if it earns its place. Skip it if the article reads better without one.",
  ].filter(Boolean);

  return `STRUCTURE\n${bullet(rules)}`;
}

export function renderSourcingRules(profile: EditorialProfile, externalLinkCount: number): string {
  if (!profile.requireCitations) {
    return "SOURCING — this profile does not require citations. Do not state statistics or attribute claims to named sources you cannot link.";
  }

  const rules = [
    "EVERY factual claim must be backed by an inline hyperlink to a credible source that actually states it. A factual claim is anything presented as established truth: statistics, percentages, dollar amounts, dated findings, rankings, regulations, what specific companies do. If a skeptical reader could ask \"says who?\", it needs a citation.",
    "NEVER invent, estimate, or approximate a fact or a URL. Use the web_search tool and copy the result URL verbatim.",
    "If you cannot tie a claim to a real, linkable source you have exactly two options: rewrite it as general reasoning that makes no specific factual assertion, or cut it. Never hedge a missing citation with \"studies show\" or \"experts agree\".",
    "Do NOT smuggle uncited numbers in as hypotheticals. \"If 80% of hospitals adopt X…\" reads as a real statistic.",
    "DO NOT NAME A SOURCE YOU ARE NOT LINKING. Name an organization, report, or dataset only in the sentence that carries its hyperlink. A page full of named sources with nothing to click is exactly the failure to avoid.",
    `NO HARD CLAIMS. An absolute or superlative assertion (${list(profile.hardClaimWords.slice(0, 8))} and the like) must not stand on your own authority. Soften it to the qualified claim that is actually true, back it with a link to a page that states it, or cut it. This applies to the title and every heading.`,
    profile.sourceGuidance,
    `Link anchors are SHORT: at most ${profile.maxAnchorWords} words, the fewest that read naturally. The hyperlink covers only the anchor words, never a whole clause. Never anchor a citation on the statistic itself.`,
    "Every link sits inside a complete, grammatical sentence, and links are spaced evenly through the article.",
    profile.bannedSourceDomains.length > 0
      ? `NEVER link these domains: ${list(profile.bannedSourceDomains)}. Link the primary source instead.`
      : "",
    externalLinkCount === 0
      ? "This article carries NO external links. Do not add any."
      : `Link each source at most once, and use ${externalLinkCount} different source${externalLinkCount === 1 ? "" : "s"}.`,
  ].filter(Boolean);

  return `FACTUAL CLAIMS AND CITATIONS — NON-NEGOTIABLE\n${bullet(rules)}`;
}

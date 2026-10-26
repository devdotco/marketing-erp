/**
 * Deterministic safety net for generated landing-page copy.
 *
 * The 2026-10 QA run produced nine invented testimonials, company statistics
 * nobody supplied ("300+ projects", "98% on-time"), a headline and a meta
 * description that disagreed on the same number, and absolute contractual
 * promises ("no exceptions"). A prompt rule alone does not stop a model doing
 * that, so everything here is checked in code against the text the user
 * actually supplied. All of it is pure: no network, no database.
 */

export interface Testimonial {
  quote: string;
  author: string;
  company: string;
}

export interface SocialProofEntry {
  placeholder: boolean;
  quote: string;
  author: string;
  company: string;
  sourceUrl: string | null;
  guidance?: string;
}

export type Variant = Record<string, unknown>;

// ---------------------------------------------------------------- testimonials

/**
 * One real quote per line: `Quote — Name, Company`. The separator is the LAST
 * em/en dash (or spaced hyphen), because the quote itself may contain a dash.
 */
export function parseTestimonials(raw: string): Testimonial[] {
  const out: Testimonial[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const sep = /\s*(?:—|–|\s-{1,2}\s)\s*(?!.*(?:—|–|\s-{1,2}\s))/.exec(text);
    let quotePart = text;
    let attribution = "";
    if (sep && sep.index > 0) {
      quotePart = text.slice(0, sep.index);
      attribution = text.slice(sep.index + sep[0].length);
    }
    const quote = quotePart.trim().replace(/^["“”']+|["“”']+$/g, "").trim();
    if (!quote) continue;
    const comma = attribution.indexOf(",");
    const author = (comma === -1 ? attribution : attribution.slice(0, comma)).trim();
    const company = comma === -1 ? "" : attribution.slice(comma + 1).trim();
    out.push({ quote, author: author || "[Customer name]", company: company || "[Company]" });
  }
  return out;
}

const DEFAULT_ANGLE: Record<string, string> = {
  "pain-led": "the problem they were stuck with before",
  "outcome-led": "the result they got",
  "proof-led": "how the engagement actually went",
};

const normQuote = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The model never writes a testimonial. Real ones fill the first slots; every
 * remaining slot is a placeholder built here. The model contributes only a
 * guidance line per slot, and only if it carries no figures.
 */
export function buildSocialProof(
  variantName: string,
  real: Testimonial[],
  count: number,
  guidance: unknown,
): SocialProofEntry[] {
  if (count <= 0) return [];
  const entries: SocialProofEntry[] = real.slice(0, count).map((t) => ({
    placeholder: false,
    quote: t.quote,
    author: t.author,
    company: t.company,
    sourceUrl: null,
  }));
  const angle = DEFAULT_ANGLE[variantName] ?? "their experience";
  const hints = Array.isArray(guidance) ? guidance : [];
  for (let slot = 0; entries.length < count; slot++) {
    const hint = hints[slot];
    // Digits in guidance would be an invented figure by the back door.
    const usable = typeof hint === "string" && hint.trim() !== "" && !/\d/.test(hint);
    entries.push({
      placeholder: true,
      quote: `[Replace with a real customer quote about ${angle}]`,
      author: "[Customer name]",
      company: "[Company]",
      sourceUrl: null,
      guidance: usable ? (hint as string).trim() : `A real customer quote about ${angle}, in their own words.`,
    });
  }
  return entries;
}

/** How many entries the model returned that are neither supplied quotes nor placeholders. */
export function countFabricatedProof(modelProof: unknown, real: Testimonial[]): number {
  if (!Array.isArray(modelProof)) return 0;
  const known = new Set(real.map((t) => normQuote(t.quote)));
  let bad = 0;
  for (const e of modelProof) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (r.placeholder === true) continue;
    const q = typeof r.quote === "string" ? r.quote : "";
    if (!known.has(normQuote(q))) bad += 1;
  }
  return bad;
}

// ------------------------------------------------------------- copy traversal

const s = (v: unknown): string => (typeof v === "string" ? v : "");
const objs = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];

export interface CopyField {
  field: string;
  text: string;
}

/**
 * Every field a reader sees, except socialProof (verified against the supplied
 * list instead) and reviewNotes (the model talking to the reviewer).
 */
export function copyFields(v: Variant): CopyField[] {
  const f: CopyField[] = [
    { field: "headline", text: s(v.headline) },
    { field: "subheadline", text: s(v.subheadline) },
    { field: "heroBody", text: s(v.heroBody) },
  ];
  objs(v.valueProps).forEach((p, i) => {
    f.push({ field: `valueProps[${i}].title`, text: s(p.title) });
    f.push({ field: `valueProps[${i}].description`, text: s(p.description) });
  });
  objs(v.howItWorks).forEach((p, i) => {
    f.push({ field: `howItWorks[${i}].title`, text: s(p.title) });
    f.push({ field: `howItWorks[${i}].description`, text: s(p.description) });
  });
  objs(v.objectionHandlers).forEach((p, i) => {
    f.push({ field: `objectionHandlers[${i}].objection`, text: s(p.objection) });
    f.push({ field: `objectionHandlers[${i}].response`, text: s(p.response) });
  });
  const cta = (v.cta ?? {}) as Record<string, unknown>;
  f.push({ field: "cta.primary", text: s(cta.primary) });
  f.push({ field: "cta.secondary", text: s(cta.secondary) });
  f.push({ field: "closingStatement", text: s(v.closingStatement) });
  const seo = (v.seo ?? {}) as Record<string, unknown>;
  f.push({ field: "seo.metaTitle", text: s(seo.metaTitle) });
  f.push({ field: "seo.metaDescription", text: s(seo.metaDescription) });
  return f.filter((x) => x.text.trim() !== "");
}

const variantLabel = (v: Variant, i: number) => s(v.name) || `variant ${i + 1}`;

/** `[PROOF NEEDED: ...]` and other bracketed placeholders are the visible gap, not claims. */
const stripBrackets = (t: string) => t.replace(/\[[^\]]*\]/g, " ");

// --------------------------------------------------------------- normalisation

const WORD_NUM: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};
const UNIT_WORDS =
  "seconds?|minutes?|hours?|days?|weeks?|months?|years?|percent|times|projects?|teams?|clients?|customers?|companies|businesses|engineers?|developers?|countries|industries|products?|apps?|launch(?:es)?|sprints?|releases?";
const WORD_NUM_RE = new RegExp(`\\b(${Object.keys(WORD_NUM).join("|")})(?=[\\s-]+(?:${UNIT_WORDS})\\b)`, "gi");

/**
 * Put spelled-out figures ("ten weeks", "98 percent", "a decade") into the same
 * digit form on both sides of the comparison, so "ten weeks" in the copy is
 * judged against "10 weeks" in the brief and vice versa.
 */
export function normalizeNumbers(text: string): string {
  return text
    .replace(WORD_NUM_RE, (m) => String(WORD_NUM[m.toLowerCase()]))
    .replace(/(\d)\s+percent\b/gi, "$1%")
    .replace(/\b(?:a|one|the)\s+decade\b/gi, "10 years")
    .replace(/\b(two|three|four|five|six|seven|eight|nine)\s+decades\b/gi, (_m, w: string) => `${WORD_NUM[w.toLowerCase()] * 10} years`);
}

const TIME_UNITS = new Set(["second", "minute", "hour", "day", "week", "month", "year"]);
const STOP = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "at", "for", "by", "with", "from", "is", "are",
  "as", "it", "if", "we", "you", "our", "your", "be", "so", "than", "then", "but", "that", "this", "no",
  "not", "out", "up", "off", "per", "via", "vs", "am", "pm", "st", "nd", "rd", "th",
]);
// Structural counts ("3 steps") describe the page layout, not the company.
const STRUCTURAL = new Set(["step", "reason", "way", "thing", "question", "tip", "point", "option", "part", "phase", "stage"]);

export const singular = (w: string) =>
  w.toLowerCase().replace(/ies$/, "y").replace(/(?:ches|shes|sses|xes)$/, (m) => m.slice(0, -2)).replace(/s$/, "");

export type ClaimKind = "percent" | "ratio" | "currency" | "time" | "count";

export interface NumericClaim {
  /** As written, e.g. "300+ projects". */
  raw: string;
  /** Numeric value normalised ("1,500" -> "1500"). */
  value: string;
  kind: ClaimKind;
  /** Singular noun the number is attached to, when there is one. */
  noun?: string;
  /** The ratio denominator for N/5. */
  denom?: string;
  index: number;
}

const CLAIM_RE = /(\$)?(\d[\d,]*(?:\.\d+)?)(\+|%|\s?\/\s?\d+)?(?:[\s-]+([A-Za-z][A-Za-z]*))?/g;
const cleanValue = (v: string) => String(parseFloat(v.replace(/,/g, "")));

/**
 * Numbers a reader would take as a fact about the company: anything with a +,
 * %, ratio or currency sign, a decimal, or a counted/timed noun ("150 teams",
 * "30-minute"). Bare integers ("Step 1", "22 October") are not claims.
 */
export function extractNumericClaims(raw: string): NumericClaim[] {
  const text = normalizeNumbers(stripBrackets(raw));
  const found: Array<NumericClaim & { bare: boolean; end: number }> = [];
  CLAIM_RE.lastIndex = 0;
  for (let m = CLAIM_RE.exec(text); m; m = CLAIM_RE.exec(text)) {
    const [whole, dollar, num, suffix, word] = m;
    const noun = word && !STOP.has(word.toLowerCase()) ? singular(word) : undefined;
    const sfx = suffix?.replace(/\s/g, "");
    let kind: ClaimKind = "count";
    if (sfx === "%") kind = "percent";
    else if (sfx?.startsWith("/")) kind = "ratio";
    else if (dollar) kind = "currency";
    else if (noun && TIME_UNITS.has(noun)) kind = "time";
    const decimal = num.includes(".");
    // "100%" is policed as an absolute promise, so it is not double-reported here.
    if (kind === "percent" && cleanValue(num) === "100") continue;
    const nounUsed = noun && !STRUCTURAL.has(noun) ? noun : undefined;
    const bare = !sfx && !dollar && !decimal && !nounUsed;
    found.push({
      // A percentage or ratio reads as itself; the trailing word ("98% on-time") is just context.
      raw: (kind === "percent" || kind === "ratio" ? whole.slice(0, whole.indexOf(sfx ?? "") + (sfx?.length ?? 0)) : whole).trim().replace(/\s+/g, " "),
      value: cleanValue(num),
      kind,
      noun: nounUsed,
      denom: sfx?.startsWith("/") ? sfx.slice(1) : undefined,
      index: m.index,
      bare,
      end: m.index + whole.length,
    });
  }
  // "4-6 weeks": the first number of a range borrows the unit of the second.
  for (let i = 0; i < found.length - 1; i++) {
    const c = found[i];
    if (c.bare && /^\s*[-–]\s*$/.test(text.slice(c.end, found[i + 1].index + 0)) ) {
      const next = found[i + 1];
      if (!next.bare) {
        c.kind = next.kind;
        c.noun = next.noun;
        c.bare = false;
      }
    }
  }
  return found.filter((c) => !c.bare).map(({ bare: _b, end: _e, ...c }) => c);
}

export function inputNumberIndex(inputText: string) {
  const text = normalizeNumbers(inputText);
  const numbers = new Set<string>();
  const percents = new Set<string>();
  const ratios = new Set<string>();
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s?(%|\/\s?\d+)?/g)) {
    const v = cleanValue(m[1]);
    numbers.add(v);
    if (m[2] === "%") percents.add(v);
    else if (m[2]) ratios.add(`${v}${m[2].replace(/\s/g, "")}`);
  }
  return { numbers, percents, ratios };
}

function isSupported(c: NumericClaim, idx: ReturnType<typeof inputNumberIndex>): boolean {
  if (c.kind === "percent") return idx.percents.has(c.value);
  if (c.kind === "ratio") return idx.ratios.has(`${c.value}/${c.denom}`);
  // "300+" in the copy is supported by "300" in the brief, and vice versa.
  return idx.numbers.has(c.value);
}

const sentenceAt = (text: string, index: number): string => {
  let start = 0;
  for (const m of text.matchAll(/[.!?]\s+/g)) {
    const end = (m.index ?? 0) + m[0].length;
    if (end > index) return text.slice(start, end).trim();
    start = end;
  }
  return text.slice(start).trim();
};
const quoteSentence = (t: string) => (t.length > 180 ? `${t.slice(0, 177)}...` : t);

// ------------------------------------------------------------------- warnings

export function unsupportedClaimWarnings(variants: Variant[], inputText: string): string[] {
  const idx = inputNumberIndex(inputText);
  const warnings: string[] = [];
  variants.forEach((v, i) => {
    const seen = new Set<string>();
    for (const { field, text } of copyFields(v)) {
      for (const c of extractNumericClaims(text)) {
        if (isSupported(c, idx)) continue;
        const key = `${field}|${c.raw}`;
        if (seen.has(key)) continue;
        seen.add(key);
        warnings.push(
          `${variantLabel(v, i)} / ${field}: "${c.raw}" is not in the offer, proof points, audience or Business Profile you supplied. Verify it or remove it before publishing.`,
        );
      }
    }
  });
  return warnings;
}

/** Same noun, two different numbers, inside one variant ("150+ teams" and "300+ teams"). */
export function contradictionWarnings(variants: Variant[]): string[] {
  const warnings: string[] = [];
  variants.forEach((v, i) => {
    const byNoun = new Map<string, Map<string, Set<string>>>();
    for (const { field, text } of copyFields(v)) {
      for (const c of extractNumericClaims(text)) {
        if (c.kind !== "count" || !c.noun) continue;
        const values = byNoun.get(c.noun) ?? new Map<string, Set<string>>();
        const where = values.get(c.value) ?? new Set<string>();
        where.add(`${c.raw} in ${field}`);
        values.set(c.value, where);
        byNoun.set(c.noun, values);
      }
    }
    for (const [noun, values] of byNoun) {
      if (values.size < 2) continue;
      const parts = [...values.values()].map((w) => [...w][0]);
      warnings.push(`${variantLabel(v, i)}: contradicts itself on "${noun}" (${parts.join(" vs ")}). Pick one figure.`);
    }
  });
  return warnings;
}

const ABSOLUTES: Array<{ name: string; re: RegExp }> = [
  { name: "always", re: /\balways\b/i },
  { name: "never", re: /\bnever\b/i },
  { name: "no exceptions", re: /\bno exceptions?\b|\bwithout exception\b/i },
  { name: "guarantee", re: /\bguarantee[sd]?\b/i },
  { name: "100%", re: /\b100\s?%/ },
  { name: "risk-free", re: /\brisk[- ]free\b|\bno risk\b|\bzero risk\b/i },
];

/** An absolute is only allowed when the offer text itself makes that commitment. */
export function absoluteWarnings(variants: Variant[], inputText: string): string[] {
  const input = normalizeNumbers(inputText);
  const allowed = new Set(ABSOLUTES.filter((a) => a.re.test(input)).map((a) => a.name));
  const warnings: string[] = [];
  variants.forEach((v, i) => {
    const seen = new Set<string>();
    for (const { field, text } of copyFields(v)) {
      const t = normalizeNumbers(text);
      for (const a of ABSOLUTES) {
        if (allowed.has(a.name)) continue;
        const m = a.re.exec(t);
        if (!m) continue;
        const sentence = sentenceAt(t, m.index);
        const key = `${a.name}|${sentence}`;
        if (seen.has(key)) continue;
        seen.add(key);
        warnings.push(
          `${variantLabel(v, i)} / ${field}: absolute promise ("${a.name}") that the offer text does not make: "${quoteSentence(sentence)}"`,
        );
      }
    }
  });
  return warnings;
}

// -------------------------------------------------------------------- metrics

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export interface VariantMetrics {
  wordCount: number;
  keywordInH1: boolean | null;
  keywordInMetaTitle: boolean | null;
  metaTitleChars: number;
  metaDescriptionChars: number;
}

export function variantMetrics(v: Variant, keyword: string): VariantMetrics {
  // Page copy only: meta tags are not on the page, placeholders are not written copy.
  const body = copyFields(v)
    .filter((f) => !f.field.startsWith("seo."))
    .map((f) => stripBrackets(f.text))
    .concat(objs(v.socialProof).filter((p) => p.placeholder !== true).map((p) => s(p.quote)))
    .join(" ");
  const seo = (v.seo ?? {}) as Record<string, unknown>;
  const k = norm(keyword);
  return {
    wordCount: body.split(/\s+/).filter(Boolean).length,
    keywordInH1: k ? norm(s(v.headline)).includes(k) : null,
    keywordInMetaTitle: k ? norm(s(seo.metaTitle)).includes(k) : null,
    metaTitleChars: s(seo.metaTitle).length,
    metaDescriptionChars: s(seo.metaDescription).length,
  };
}

export function wordCountWarnings(variants: Variant[], target: number): string[] {
  const lo = Math.round(target * 0.75);
  const hi = Math.round(target * 1.25);
  const out: string[] = [];
  variants.forEach((v, i) => {
    const wc = (v.metrics as VariantMetrics | undefined)?.wordCount;
    if (typeof wc === "number" && (wc < lo || wc > hi)) {
      out.push(`${variantLabel(v, i)}: ${wc} words of copy, outside the ${lo}-${hi} range around your ${target}-word target.`);
    }
  });
  return out;
}

// ------------------------------------------------------------------- finalise

export interface FinalizeOptions {
  inputText: string;
  testimonials: Testimonial[];
  socialProofCount: number;
  keyword: string;
  wordCountTarget: number;
  defaultSecondaryCta: string;
}

/**
 * Mutates each variant into its final shape and returns the warnings for a
 * human. Order matters: social proof and notes are normalised first so the
 * claim checks and the word count see the final copy.
 */
export function finalizeVariants(variants: Variant[], o: FinalizeOptions): string[] {
  const warnings: string[] = [];
  variants.forEach((v, i) => {
    const name = variantLabel(v, i);

    const fabricated = countFabricatedProof(v.socialProof, o.testimonials);
    if (fabricated > 0) {
      warnings.push(
        `${name}: the model wrote ${fabricated} testimonial${fabricated === 1 ? "" : "s"} that were not in your supplied list. They were replaced with placeholders.`,
      );
    }
    v.socialProof = buildSocialProof(name, o.testimonials, o.socialProofCount, v.socialProofGuidance);
    delete v.socialProofGuidance;
    if (o.socialProofCount <= 0) delete v.socialProof;

    // valuePropsNote only ever appeared on one variant; reviewNotes is the one place for doubts.
    const notes = [
      ...(Array.isArray(v.reviewNotes) ? v.reviewNotes : []),
      v.valuePropsNote,
    ]
      .filter((n): n is string => typeof n === "string" && n.trim() !== "")
      .map((n) => n.trim());
    delete v.valuePropsNote;
    v.reviewNotes = notes;

    const cta = (v.cta && typeof v.cta === "object" ? v.cta : {}) as Record<string, unknown>;
    if (!s(cta.secondary).trim()) cta.secondary = o.defaultSecondaryCta;
    v.cta = cta;
    if (!Array.isArray(v.howItWorks)) v.howItWorks = [];
  });

  warnings.push(...unsupportedClaimWarnings(variants, o.inputText));
  warnings.push(...contradictionWarnings(variants));
  warnings.push(...absoluteWarnings(variants, o.inputText));

  variants.forEach((v) => {
    v.metrics = variantMetrics(v, o.keyword);
  });
  warnings.push(...wordCountWarnings(variants, o.wordCountTarget));

  variants.forEach((v, i) => {
    if (Array.isArray(v.reviewNotes) && v.reviewNotes.length) {
      warnings.push(`${variantLabel(v, i)} (model was unsure): ${(v.reviewNotes as string[]).join(" | ")}`);
    }
  });
  return warnings;
}

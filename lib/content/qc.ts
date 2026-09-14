import {
  actualLinks,
  allCalloutBlocks,
  allChartBlocks,
  allImageBlocks,
  allStatBlocks,
  allTableBlocks,
  articleText,
  blockText,
  countWords,
  runsText,
  type Article,
  type Block,
} from "./article";
import type { ContentBrief } from "./brief";
import type { ResearchResult } from "./research";

export interface QcResult {
  /** Must be fixed. These are handed back to the writer as a repair round. */
  defects: string[];
  /** Worth a human's eye, not worth another model call. */
  warnings: string[];
  pass: boolean;
  computed: {
    wordCount: number;
    sections: number;
    externalLinks: number;
    internalLinks: number;
    fillerHits: number;
    longestParagraphSentences: number;
    charts: number;
    tables: number;
    callouts: number;
    images: number;
  };
}

/**
 * Deterministic quality control.
 *
 * Everything here is checked in code rather than asked of a model, because a
 * model asked "is this good?" says yes. These are the failures that actually
 * recur: uncited figures, named sources with nothing to click, headings that all
 * share one grammatical mold, a draft 400 words over its band, a list promised
 * by a colon and never delivered.
 *
 * Every word list and every threshold comes from the workspace's editorial
 * profile, never from a constant in this file. A tenant that allows em-dashes
 * and six-sentence paragraphs is not failing QC for it.
 *
 * `research` is optional so every existing pure caller (and every existing
 * test in test/content.test.ts) keeps working unchanged; pass it to get the
 * visual-data honesty checks (a chart or stat whose numbers don't trace to a
 * verified research claim). Without it those checks are skipped rather than
 * failing closed — the pipeline always has research in hand and passes it.
 */
export function runQc(article: Article, brief: ContentBrief, research?: ResearchResult): QcResult {
  const defects: string[] = [];
  const warnings: string[] = [];
  const { profile } = brief;

  const bodyText = articleText(article);
  const lower = bodyText.toLowerCase();
  const titleLower = article.title.toLowerCase();

  // The voice rules treat a violation in the title as the same violation as one
  // in a paragraph ("What Underwriters Actually Read" is filler in a headline),
  // so every voice scan runs over the title and headings too. Word count and
  // keyword density stay on the body alone, which is what they measure.
  const fullText = [article.title, bodyText].filter(Boolean).join("\n");

  // ── Shape ──────────────────────────────────────────────────────────────────
  if (profile.requireIntro && article.introBlocks.length === 0) {
    defects.push(
      "The article has no intro: it opens straight into the first subheading. Add 1-2 opening paragraphs before it.",
    );
  }
  if (article.sections.length < profile.minSections) {
    defects.push(
      `Only ${article.sections.length} body section(s). This profile asks for ${profile.minSections}-${profile.maxSections}, each with a real body under its heading.`,
    );
  } else if (article.sections.length > profile.maxSections) {
    warnings.push(
      `${article.sections.length} body sections — more than the ${profile.minSections}-${profile.maxSections} this profile asks for.`,
    );
  }

  // ── Length ─────────────────────────────────────────────────────────────────
  const words = article.wordCount;
  if (words < brief.length.min) {
    // The brief's word count is a FLOOR, not a midpoint (owner decision,
    // 2026-09-14, after a live run at 1299/1500 words passed QC). The exact
    // deficit is the instruction, not the diagnosis — "add substance" alone
    // got a draft that was forty words closer and still short; see
    // draft.ts's overLength() for the identical lesson on the trim side.
    const deficit = brief.length.min - words;
    defects.push(
      `Word count ${words} is below the ${brief.length.min}-word floor (band: ${brief.length.label}). Expand to at least ${brief.length.min} words: add ~${deficit} words, prioritising the key questions and must-cover items with the thinnest coverage. Deepen existing sections with real substance — more evidence, more specific detail — never padding, hedge-stacking, or restating a point already made.`,
    );
  } else if (words > brief.length.max) {
    defects.push(
      `Word count ${words} is above the ${brief.length.label}-word band. Trim to length by cutting whole sections, never by emptying a section under its heading.`,
    );
  }

  // ── Headings ───────────────────────────────────────────────────────────────
  for (const section of article.sections) {
    const heading = section.heading.trim();
    if (/[.:!;,]$/.test(heading)) {
      defects.push(`Heading "${heading}" ends in punctuation. Headings carry none, except a question mark on a genuine question.`);
    }
    if (profile.bannedHeadings.includes(heading.toLowerCase().replace(/[?.!]$/, ""))) {
      defects.push(
        `Heading "${heading}" is banned by this editorial profile. Give that section a heading that says something.`,
      );
    }
    if (countWords(heading) > 12) {
      warnings.push(`Heading "${heading}" runs long at ${countWords(heading)} words.`);
    }
  }
  if (profile.requireHeadingVariety) {
    const headingVariety = describeHeadingMonotony(article.sections.map((s) => s.heading));
    if (headingVariety) defects.push(headingVariety);
  }

  // ── Voice ──────────────────────────────────────────────────────────────────
  const fillerCounts = countTerms(fullText, profile.bannedWords);
  const fillerHits = sum(fillerCounts);
  if (fillerHits > 0) {
    defects.push(
      `Words this profile bans appear ${fillerHits} time(s): ${describeCounts(fillerCounts)}. Remove every one — in headings and the title as much as in the body.`,
    );
  }

  const tellCounts = countPhrases(fullText.toLowerCase(), profile.bannedPhrases);
  if (sum(tellCounts) > 0) {
    defects.push(
      `Phrasing this profile bans: ${describeCounts(tellCounts)}. Rewrite those sentences in plain, specific language.`,
    );
  }

  if (!profile.allowEmDash && /—/.test(fullText)) {
    defects.push(
      "Em-dashes appear in the article and this profile does not allow them. Replace every one with a comma, a period, or a rewritten clause.",
    );
  }

  for (const rationed of profile.rationedWords) {
    const hits = sum(countTerms(bodyText, [rationed]));
    if (hits > 1) {
      defects.push(`"${rationed}" appears ${hits} times. This profile allows it at most once.`);
    }
    if (new RegExp(`\\b${escapeRegex(rationed)}\\b`, "i").test(article.title)) {
      defects.push(`"${rationed}" appears in the title, where this profile does not allow it.`);
    }
  }

  if (brief.pointOfView.toLowerCase().startsWith("third")) {
    const firstPerson = sum(countTerms(fullText, ["i", "we", "us", "our", "ours", "my", "me"]));
    if (firstPerson > 0) {
      defects.push(
        `First person appears ${firstPerson} time(s) but this article is written in third person. Rewrite those sentences without "I", "we", "us" or "our".`,
      );
    }
  }

  const flips = profile.banNegationFlip ? findNegationFlips(article) : [];
  if (flips.length > 0) {
    defects.push(
      `The negation flip appears ${flips.length} time(s) — a short assertion immediately undercut by its own negation: ${flips.slice(0, 3).map(quote).join(" ")} Make the reversal inside one sentence, or state the point plainly.`,
    );
  }

  const invented = profile.banInventedPrecision ? findInventedPrecision(fullText) : [];
  if (invented.length > 0) {
    defects.push(
      `Fabricated scene precision: ${invented.slice(0, 3).map(quote).join(" ")} Remove the invented time or day, or cite the detail.`,
    );
  }

  // ── Paragraphs and lists ───────────────────────────────────────────────────
  const allBlocks: Block[] = [
    ...article.introBlocks,
    ...article.sections.flatMap((section) => section.blocks),
  ];
  let longestParagraph = 0;
  for (const block of allBlocks) {
    if (block.type !== "paragraph") continue;
    const sentences = splitSentences(runsText(block.runs)).length;
    longestParagraph = Math.max(longestParagraph, sentences);
  }
  if (longestParagraph > profile.maxParagraphSentences) {
    defects.push(
      `A paragraph runs to ${longestParagraph} sentences. This profile caps paragraphs at ${profile.maxParagraphSentences} — split the long ones.`,
    );
  }

  for (const section of article.sections) {
    const first = section.blocks[0];
    if (!first) continue;
    const opening = blockText(first).trim();
    const leadIn = /^(Because|Since|So that|Which is why|Which means|This means|That means|And|But|Yet|So)\b/i.exec(opening);
    if (leadIn) {
      defects.push(
        `The section "${section.heading}" opens with "${leadIn[1]}", which leans on the heading to finish the sentence. Open with a self-contained statement.`,
      );
    }
  }

  for (const [index, block] of allBlocks.entries()) {
    if (block.type !== "paragraph") continue;
    const text = runsText(block.runs).trim();
    if (!/:$/.test(text)) continue;
    const next = allBlocks[index + 1];
    if (!next || next.type !== "list") {
      defects.push(
        `A paragraph promises a list with a colon and never delivers it: ${quote(text.slice(-90))} Add the list, or rewrite the sentence without the colon.`,
      );
    }
  }

  // ── Links ──────────────────────────────────────────────────────────────────
  const links = actualLinks(article);
  // brief.ctaUrl used to be missing here, which is exactly the false positive
  // a live run hit: the brief's own app.vdr.ai sign-up CTA was on the client's
  // site but counted as an EXTERNAL link because only siteUrl and the typed
  // internalLinkTargets were treated as internal. A link to the brief's own
  // call-to-action is definitionally internal, the same as a link to the
  // site's own homepage or an internal-linking target.
  const internalHosts = new Set(
    [brief.siteUrl, brief.ctaUrl, ...brief.internalLinks.map((l) => l.url)].map(hostOf).filter(Boolean) as string[],
  );
  const external = links.filter((link) => !internalHosts.has(hostOf(link.url) ?? ""));
  const internal = links.filter((link) => internalHosts.has(hostOf(link.url) ?? ""));

  if (external.length !== brief.externalLinkCount) {
    const verb = external.length < brief.externalLinkCount ? "only " : "";
    const line = `The brief asks for ${brief.externalLinkCount} external reference link(s); the article has ${verb}${external.length}.`;
    if (external.length > brief.externalLinkCount || external.length < brief.externalLinkCount) {
      defects.push(
        `${line} ${
          external.length < brief.externalLinkCount
            ? "Add the missing link(s) from the verified sources, each to a different source."
            : "Remove the extra link(s), keeping the most useful ones."
        }`,
      );
    }
  }

  const expectedInternal = brief.internalLinks.length;
  if (internal.length < expectedInternal) {
    defects.push(
      `${expectedInternal - internal.length} of the ${expectedInternal} internal link(s) in the brief are missing from the article. Work each one into a sentence where it helps the reader.`,
    );
  }

  const seenHosts = new Map<string, number>();
  for (const link of external) {
    const host = hostOf(link.url);
    if (!host) continue;
    seenHosts.set(host, (seenHosts.get(host) ?? 0) + 1);
  }
  for (const [host, count] of seenHosts) {
    if (count > 1) defects.push(`${host} is linked ${count} times. Link any one source at most once.`);
  }

  for (const link of links) {
    const host = hostOf(link.url);
    if (host && /(^|\.)wikipedia\.org$/i.test(host)) {
      defects.push(`Wikipedia is linked (${link.url}). Link the primary source it cites instead.`);
    }
    if (host && brief.blockedDomains.some((d) => host.endsWith(hostOf(d) ?? d))) {
      defects.push(`${host} is on the brief's blocked list but is linked in the article. Replace that link.`);
    }
    if (isBareSite(link.url) && !internalHosts.has(host ?? "")) {
      defects.push(
        `The link to ${link.url} points at a site root or index page. Every external link must point at the specific page that supports the sentence.`,
      );
    }
    const anchorWords = countWords(link.anchor);
    const declaredAnchor = brief.internalLinks.find((l) => l.url === link.url)?.anchor;
    if (anchorWords > profile.maxAnchorWords && link.anchor !== declaredAnchor) {
      defects.push(
        `The anchor ${quote(link.anchor)} is ${anchorWords} words. This profile caps anchors at ${profile.maxAnchorWords} — link only the words that name the thing.`,
      );
    }
  }

  if (brief.webResearch && brief.externalLinkCount > 0 && external.length === 0) {
    defects.push("The article carries no external references at all, so nothing in it is sourced.");
  }

  // ── Claims ─────────────────────────────────────────────────────────────────
  for (const finding of findUncitedFigures(article)) defects.push(finding);
  for (const finding of findUnlinkedAttributions(article)) defects.push(finding);

  const hardClaims = profile.hardClaimWords.filter((word) =>
    new RegExp(`\\b${escapeRegex(word)}\\b`, "i").test(fullText),
  );
  if (hardClaims.length > 0) {
    warnings.push(
      `Absolute or superlative wording present (${hardClaims.join(", ")}). Each must be softened, sourced, or cut.`,
    );
  }

  // ── SEO fields ─────────────────────────────────────────────────────────────
  if (!article.title) defects.push("The article has no title.");
  const metaLength = article.metaDescription.length;
  if (metaLength === 0) {
    defects.push("The meta description is empty. Write 150-160 characters for a human scanning a results page.");
  } else if (metaLength < 120 || metaLength > 170) {
    defects.push(
      `The meta description is ${metaLength} characters. Aim for 150-160; anything outside 120-170 is rejected.`,
    );
  }
  if (article.metaDescription.trim().toLowerCase() === titleLower) {
    defects.push("The meta description just restates the title. Write a distinct one.");
  }

  if (brief.targetKeyword) {
    const keyword = brief.targetKeyword.toLowerCase();
    if (!titleLower.includes(keyword)) {
      warnings.push(`The target keyword "${brief.targetKeyword}" is not in the title.`);
    }
    const opening = [...article.introBlocks.map(blockText)].join(" ").split(/\s+/).slice(0, 100).join(" ");
    if (!opening.toLowerCase().includes(keyword)) {
      defects.push(
        `The target keyword "${brief.targetKeyword}" does not appear in the first 100 words. Work it into the intro naturally.`,
      );
    }
    const density = occurrences(lower, keyword) / Math.max(1, words);
    if (density > 0.025 && words >= 300) {
      defects.push(
        `The target keyword appears ${occurrences(lower, keyword)} times in ${words} words (${(density * 100).toFixed(1)}%). That reads as keyword stuffing — cut it back below 2%.`,
      );
    }
  }

  // ── The brief's own requirements ───────────────────────────────────────────
  const missing = brief.mustCover.filter((item) => !coversTopic(lower, item));
  if (missing.length > 0) {
    defects.push(
      `The brief's must-cover list is not fully addressed. Missing: ${missing.map(quote).join(", ")}.`,
    );
  }
  // A warning, not a defect, and deliberately so. Matching a must-cover item
  // works because it is a named thing ("duplicate part numbers") that appears in
  // the prose if it is covered. A question is not: "Who needs to be involved?"
  // is answered perfectly well by a paragraph naming the data owner and the CAD
  // admin, in which none of the question's own words appear. Failing a draft on
  // that spends a repair round fixing something that was never broken, so it
  // goes to the reviewer to judge instead.
  const unanswered = brief.keyQuestions.filter((question) => !coversTopic(lower, question));
  if (unanswered.length > 0) {
    warnings.push(
      `${unanswered.length} of the brief's questions may go unanswered — check before publishing: ${unanswered.map(quote).join(", ")}.`,
    );
  }

  const forbidden = brief.mustAvoid.filter((item) => coversTopic(lower, item));
  if (forbidden.length > 0) {
    defects.push(
      `The brief excludes ${forbidden.map(quote).join(", ")}, but the article covers it. Remove it entirely and write around it.`,
    );
  }

  // ── Delivery requirements the brief asked for ─────────────────────────────
  for (const disclaimer of brief.requiredDisclaimers) {
    if (!lower.includes(disclaimer.toLowerCase().trim())) {
      defects.push(
        `A required disclaimer is missing. It has to appear verbatim: ${quote(disclaimer)}.`,
      );
    }
  }

  if (brief.includeFaq && article.faq.length === 0) {
    defects.push("The brief asks for an FAQ section and the article has none.");
  }
  if (brief.includeImageBriefs && article.imageBriefs.length === 0) {
    warnings.push("The brief asks for image briefs and none were returned.");
  }
  for (const image of article.imageBriefs) {
    if (!image.altText) {
      warnings.push(`An image brief for "${image.placement || "an unnamed slot"}" has no alt text.`);
    }
  }

  // Promotion is the fastest way for an owned-blog piece to stop being read.
  if (brief.productToFeature) {
    const mentions = occurrences(lower, brief.productToFeature.toLowerCase());
    const ceiling = promotionCeiling(brief.promotionLevel);
    if (mentions > ceiling) {
      defects.push(
        `"${brief.productToFeature}" is named ${mentions} times, and this brief asks for "${brief.promotionLevel.toLowerCase()}" (at most ${ceiling}). Cut it back to where it genuinely helps the reader.`,
      );
    }
    if (mentions === 0 && ceiling > 0 && brief.promotionLevel.toLowerCase().startsWith("feature")) {
      defects.push(`The brief asks the piece to feature "${brief.productToFeature}" and it is never named.`);
    }
  }

  if (brief.ctaUrl && !links.some((link) => link.url === brief.ctaUrl)) {
    defects.push(
      `The brief's call-to-action URL (${brief.ctaUrl}) is not linked anywhere in the piece. Land it as a concrete next step in the closing section.`,
    );
  }

  if (brief.geographicScope.toLowerCase().startsWith("universal")) {
    const scoped = article.sections
      .map((s) => s.heading)
      .concat(article.title)
      .find(namesAPlace);
    if (scoped) {
      warnings.push(
        `"${scoped}" scopes the piece to one place. This brief asks for universal coverage — check it.`,
      );
    }
  }

  // ── Visuals ────────────────────────────────────────────────────────────────
  const charts = allChartBlocks(article);
  const tables = allTableBlocks(article);
  const callouts = allCalloutBlocks(article);
  const images = allImageBlocks(article);

  // A block type present when the brief never asked for that visual type is a
  // defect, not a warning: the writer used something outside what it was told
  // it could use, the same as it would be for an FAQ nobody requested.
  if (charts.length > 0 && !brief.visualTypes.charts) {
    defects.push(`The brief did not ask for charts, but the article has ${charts.length}. Remove them, or convert the data to prose.`);
  }
  if (tables.length > 0 && !brief.visualTypes.tables) {
    defects.push(`The brief did not ask for tables, but the article has ${tables.length}. Remove them, or convert to a list.`);
  }
  if (callouts.length > 0 && !brief.visualTypes.callouts) {
    defects.push(`The brief did not ask for callout boxes, but the article has ${callouts.length}. Fold that content into ordinary prose.`);
  }
  if (images.length > 0 && !brief.visualTypes.images) {
    defects.push(`The brief did not ask for AI images, but the article has ${images.length} image block(s). Remove them.`);
  }

  if (charts.length > brief.maxCharts) {
    defects.push(`The article has ${charts.length} chart(s); the brief allows at most ${brief.maxCharts}. Remove the least essential ${charts.length - brief.maxCharts}.`);
  }
  if (tables.length > brief.maxTables) {
    defects.push(`The article has ${tables.length} table(s); the brief allows at most ${brief.maxTables}. Remove the least essential ${tables.length - brief.maxTables}.`);
  }
  if (images.length > brief.maxImages) {
    defects.push(`The article proposes ${images.length} image block(s); the brief allows at most ${brief.maxImages}. Cut to the ${brief.maxImages} that matter most — the hero first.`);
  }
  if (images.filter((i) => i.slot === "hero").length > 1) {
    defects.push(`More than one image is marked slot="hero". An article has exactly one hero image; mark the rest "inline".`);
  }

  // Honesty: every chart and stat value, and every figure in a comparison
  // table, must trace to a verified research claim. See findUntracedVisualData
  // for the matching rule and the module doc comment on why a stat/chart's
  // sourceUrl is a real, visible link in the rendered HTML but is NOT counted
  // against externalLinkCount above — it cites the visual's data, not an
  // editorial link placement, and is capped by maxCharts/maxTables/maxImages
  // instead.
  for (const finding of findUntracedVisualData(article, research)) defects.push(finding);

  return {
    defects,
    warnings,
    pass: defects.length === 0,
    computed: {
      wordCount: words,
      sections: article.sections.length,
      externalLinks: external.length,
      internalLinks: internal.length,
      fillerHits,
      longestParagraphSentences: longestParagraph,
      charts: charts.length,
      tables: tables.length,
      callouts: callouts.length,
      images: images.length,
    },
  };
}

/**
 * Place names, for the universal-scope check.
 *
 * This used to be a pattern — a preposition followed by a capitalised word —
 * and it fired on "Run the Audit in Three Passes", which names no place at all.
 * A heading is either about somewhere or it is not, so look for somewhere.
 */
const PLACE_MARKERS = [
  "united states", "u.s.", "usa", "america", "american", "canada", "canadian", "mexico",
  "united kingdom", "u.k.", "britain", "british", "england", "scotland", "wales", "ireland",
  "europe", "european", "eu", "germany", "france", "spain", "italy", "netherlands",
  "australia", "new zealand", "india", "china", "japan", "singapore", "brazil",
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
  "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa",
  "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan",
  "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "ohio",
  "oklahoma", "oregon", "pennsylvania", "tennessee", "texas", "utah", "vermont",
  "virginia", "washington", "wisconsin", "wyoming",
  "midwest", "northeast", "southeast", "southwest", "west coast", "east coast",
];

/** True when a heading or title is about a specific place. */
function namesAPlace(heading: string): boolean {
  const lower = ` ${heading.toLowerCase()} `;
  if (PLACE_MARKERS.some((place) => lower.includes(` ${place} `) || lower.includes(` ${place},`))) {
    return true;
  }
  // "in Austin", "across Ontario" — a preposition plus a capitalised word that is
  // not a number word, an ordinal, or the start of an ordinary noun phrase.
  const match = /\b(?:in|across|under|throughout) ([A-Z][a-z]{2,})\b/.exec(heading);
  if (!match) return false;
  const word = match[1]!.toLowerCase();
  const notAPlace = [
    "three", "four", "five", "six", "seven", "eight", "nine", "ten", "two",
    "practice", "production", "person", "advance", "detail", "order", "place",
    "house", "public", "private", "writing", "reality", "theory", "context",
    "january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december",
  ];
  return !notAPlace.includes(word);
}

/** How many times a product may be named, given how promotional the brief allows. */
function promotionCeiling(level: string): number {
  const lower = level.toLowerCase();
  if (lower.startsWith("do not")) return 0;
  if (lower.startsWith("mention")) return 2;
  if (lower.startsWith("feature")) return 5;
  return 3;
}

// ─── Checks ──────────────────────────────────────────────────────────────────

/**
 * A reader who can predict the grammatical shape of the next heading from the
 * last one is reading a machine. Flags an article whose headings all sit in one
 * mold — all gerunds, all questions, all "How to …", all subject-verb.
 */
function describeHeadingMonotony(headings: string[]): string | null {
  if (headings.length < 3) return null;

  const molds = headings.map(headingMold);
  const counts = new Map<string, number>();
  for (const mold of molds) counts.set(mold, (counts.get(mold) ?? 0) + 1);

  for (const [mold, count] of counts) {
    if (count === headings.length) {
      return `Every section heading is the same grammatical shape (${mold}). Recast at least two of them — mix assertions, imperatives, gerunds and genuine questions.`;
    }
  }

  const firstWords = headings.map((h) => h.split(/\s+/)[0]?.toLowerCase() ?? "");
  const repeated = firstWords.filter((word, i) => firstWords.indexOf(word) !== i);
  if (repeated.length >= 2) {
    return `Several headings open with the same word ("${repeated[0]}"). Vary how each heading starts.`;
  }
  return null;
}

function headingMold(heading: string): string {
  const trimmed = heading.trim();
  if (/\?$/.test(trimmed)) return "a question";
  if (/^(how|why|what|when|where|who)\b/i.test(trimmed)) return "a wh- phrase";
  if (/^\w+ing\b/i.test(trimmed)) return "a gerund phrase";
  if (/^(the|a|an)\b/i.test(trimmed)) return "a noun phrase";
  return "a subject-verb assertion";
}

/**
 * The negation flip: a short assertion immediately undercut by its own negation.
 * "The cleaning worked. The equipment didn't."
 */
function findNegationFlips(article: Article): string[] {
  const hits: string[] = [];
  const blocks = [...article.introBlocks, ...article.sections.flatMap((s) => s.blocks)];
  for (const block of blocks) {
    const sentences = splitSentences(blockText(block));
    for (let i = 1; i < sentences.length; i += 1) {
      const previous = sentences[i - 1]!.trim();
      const current = sentences[i]!.trim();
      const isFlip =
        countWords(current) <= 6 &&
        /\b(isn't|aren't|wasn't|weren't|doesn't|don't|didn't|won't|can't|hasn't|haven't|it is not|they do not)\b/i.test(
          current,
        ) &&
        countWords(previous) <= 18;
      if (isFlip) hits.push(`${previous} ${current}`);
    }
  }
  return hits;
}

/** Invented clock times and day-of-week scene setting. */
function findInventedPrecision(text: string): string[] {
  const hits: string[] = [];
  const patterns = [
    /\bat \d{1,2}:\d{2}\b(?!\s*(a\.?m|p\.?m)?\s*(EST|EDT|UTC|GMT))/gi,
    /\bon a (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) hits.push(match[0]);
  }
  return hits;
}

/**
 * A figure stated in a paragraph that contains no link is an uncited statistic —
 * the single most common reason a draft could not ship.
 */
function findUncitedFigures(article: Article): string[] {
  const findings: string[] = [];
  const blocks = [...article.introBlocks, ...article.sections.flatMap((s) => s.blocks)];

  for (const block of blocks) {
    // Only prose and callouts carry runs. Table/stat/chart figures have their
    // own dedicated honesty checks below (findUntracedVisualData) — this scan
    // would crash on them (no .runs) if it didn't skip them here.
    if (block.type !== "list" && block.type !== "paragraph" && block.type !== "callout") continue;
    const runs = block.type === "list" ? block.items.flat() : block.runs;
    const hasLink = runs.some((run) => run.link);
    if (hasLink) continue;

    for (const sentence of splitSentences(runsText(runs))) {
      if (!/\d/.test(sentence)) continue;
      // Ordinary numbers in prose are fine; a statistic looks like one.
      const looksLikeStatistic =
        /\d+(\.\d+)?\s?%/.test(sentence) ||
        /[$£€]\s?\d/.test(sentence) ||
        /\b\d+(\.\d+)?\s?(million|billion|trillion|percent)\b/i.test(sentence) ||
        /\b(in|since|by)\s+(19|20)\d{2}\b/.test(sentence);
      if (!looksLikeStatistic) continue;
      findings.push(
        `An uncited figure: ${quote(sentence.trim())} Either link the source that states it, or rewrite the sentence without the number.`,
      );
    }
  }
  return findings.slice(0, 5);
}

/**
 * A named source with nothing to click. "According to Pew Research…" in a
 * paragraph with no link is the failure that makes an article look researched
 * and be unverifiable.
 */
function findUnlinkedAttributions(article: Article): string[] {
  const findings: string[] = [];
  const blocks = [...article.introBlocks, ...article.sections.flatMap((s) => s.blocks)];
  const pattern =
    /\b(according to|a study by|research from|a report by|data from|a survey by|as reported by)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/g;

  for (const block of blocks) {
    if (block.type !== "list" && block.type !== "paragraph" && block.type !== "callout") continue;
    const runs = block.type === "list" ? block.items.flat() : block.runs;
    const linked = runs.some((run) => run.link);
    if (linked) continue;
    for (const match of runsText(runs).matchAll(pattern)) {
      findings.push(
        `The article credits "${match[2]}" with no link to click. Link the specific page, or drop the attribution and state the point as your own reasoning.`,
      );
    }
  }
  return findings.slice(0, 5);
}

/**
 * The honesty rule for visual data: every chart and stat value must come from
 * a research claim bound to a verified source, and carry that source's exact
 * URL — no invented data. A chart or stat that fails this is dropped or fixed
 * in the repair round, the same as an uncited figure in prose.
 *
 * Matching is numeric: a value "traces" when every number it contains also
 * appears in the text of a claim that is itself bound to the same sourceUrl.
 * That is deliberately loose (it does not require exact phrasing) and
 * deliberately strict (it requires the same URL, not just any claim in the
 * whole research set) — a chart citing the wrong source for a right-looking
 * number is exactly the failure this exists to catch.
 *
 * Table figures have no per-table sourceUrl field (tables are qualitative
 * comparisons that may also carry a figure), so a table's numbers are checked
 * against the whole claim set rather than one bound source.
 */
function findUntracedVisualData(article: Article, research: ResearchResult | undefined): string[] {
  if (!research) return [];
  const findings: string[] = [];
  const verifiedUrls = new Set(research.sources.map((s) => s.url));
  const claims = research.claims;

  const tracesToSource = (value: string, sourceUrl: string): boolean => {
    const valueNumbers = extractNumbers(value);
    if (valueNumbers.length === 0) return false;
    return claims.some(
      (c) => c.sourceUrl === sourceUrl && valueNumbers.every((n) => extractNumbers(c.claim).includes(n)),
    );
  };

  for (const stat of allStatBlocks(article)) {
    if (!stat.sourceUrl || !verifiedUrls.has(stat.sourceUrl)) {
      findings.push(
        `The stat "${stat.label}: ${stat.value}" has no verified source URL. Every stat callout must carry the exact URL of the verified source that states it, or be removed.`,
      );
      continue;
    }
    if (!tracesToSource(stat.value, stat.sourceUrl)) {
      findings.push(
        `The stat "${stat.label}: ${stat.value}" does not trace to a verified research claim bound to its source URL. Bind it to a matching CLAIM EVIDENCE entry, or remove it — never invent the figure.`,
      );
    }
  }

  for (const chart of allChartBlocks(article)) {
    if (!chart.sourceUrl || !verifiedUrls.has(chart.sourceUrl)) {
      findings.push(
        `The chart "${chart.title}" has no verified source URL. Every chart must carry the exact URL of the verified source its data comes from, or be removed.`,
      );
      continue;
    }
    const untraced = chart.series.filter((p) => !tracesToSource(String(p.value), chart.sourceUrl!));
    if (untraced.length > 0) {
      findings.push(
        `The chart "${chart.title}" has ${untraced.length} data point(s) that do not trace to a verified research claim (${untraced.map((p) => `${p.label}: ${p.value}`).join(", ")}). Fix the values to match a verified claim, or remove the chart — never estimate a data point.`,
      );
    }
  }

  const claimNumbers = new Set(claims.flatMap((c) => extractNumbers(c.claim)));
  for (const table of allTableBlocks(article)) {
    for (const row of table.rows) {
      for (const cell of row) {
        if (!looksLikeStatisticText(cell)) continue;
        const cellNumbers = extractNumbers(cell);
        if (cellNumbers.every((n) => claimNumbers.has(n))) continue;
        findings.push(
          `The table "${table.caption || table.headers.join("/")}" has a figure (${quote(cell)}) that does not trace to a verified research claim. Every figure in a comparison table must come from a verified claim — fix it or remove the row.`,
        );
      }
    }
  }

  return findings.slice(0, 8);
}

function extractNumbers(text: string): number[] {
  return [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => parseFloat(m[0]));
}

/** Same "looks like a statistic, not an ordinary small number" heuristic findUncitedFigures uses. */
function looksLikeStatisticText(text: string): boolean {
  return (
    /\d+(\.\d+)?\s?%/.test(text) ||
    /[$£€]\s?\d/.test(text) ||
    /\b\d+(\.\d+)?\s?(million|billion|trillion|percent)\b/i.test(text) ||
    /\b(19|20)\d{2}\b/.test(text)
  );
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countTerms(text: string, terms: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const term of terms) {
    const matches = text.match(new RegExp(`\\b${escapeRegex(term)}\\b`, "gi"));
    if (matches?.length) counts[term] = matches.length;
  }
  return counts;
}

function countPhrases(lowerText: string, phrases: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const phrase of phrases) {
    const n = occurrences(lowerText, phrase);
    if (n > 0) counts[phrase] = n;
  }
  return counts;
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle.toLowerCase()).length - 1;
}

function sum(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

function describeCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([term, n]) => `"${term}" x${n}`)
    .join(", ");
}

function quote(value: string): string {
  return `"${value.replace(/\s+/g, " ").trim()}"`;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

/** A site root, or a category/tag/author index — never a page that supports a claim. */
function isBareSite(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    if (path === "" || path === "/") return true;
    return /^\/(category|tag|topics?|author|blog|news|articles)$/i.test(path);
  } catch {
    return false;
  }
}

/** Loose containment check for must-cover / must-avoid phrases. */
function coversTopic(lowerText: string, phrase: string): boolean {
  const cleaned = phrase.toLowerCase().trim();
  if (cleaned.length === 0) return true;
  if (lowerText.includes(cleaned)) return true;
  // Fall back to content words, so "permit costs for homeowners" still matches
  // an article that discusses permit costs without that exact wording.
  const words = cleaned.split(/\s+/).filter((w) => w.length > 3);
  if (words.length === 0) return false;
  const present = words.filter((word) => lowerText.includes(word)).length;
  return present / words.length >= 0.7;
}

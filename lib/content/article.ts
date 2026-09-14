import type Anthropic from "@anthropic-ai/sdk";

/**
 * The article as structured data, not as a blob of HTML.
 *
 * The old Blog Writer asked for an HTML string inside a JSON field and then
 * recovered it with `rawText.match(/\{[\s\S]+\}/)`. That fails on any article
 * containing a brace, silently returns half an object, and gives QC nothing to
 * inspect: you cannot count a section, check a heading, or audit a link inside
 * an opaque string. Blocks come back through a tool call the API validates
 * against the schema below, and HTML is rendered from them at the very end.
 */

/** One span of text. `link` makes it a hyperlink; `bold` a list item's lead-in label. */
export interface TextRun {
  text: string;
  link?: string;
  bold?: boolean;
}

export type Block =
  | { type: "paragraph"; runs: TextRun[] }
  | { type: "list"; ordered?: boolean; items: TextRun[][] };

export interface Section {
  heading: string;
  blocks: Block[];
}

export interface LinkUsed {
  anchor: string;
  url: string;
  kind: "internal" | "external";
  rationale: string;
}

export interface FaqEntry {
  question: string;
  answer: string;
}

export interface ImageBrief {
  placement: string;
  description: string;
  altText: string;
}

export interface Article {
  title: string;
  slug: string;
  metaDescription: string;
  focusKeyword: string;
  introBlocks: Block[];
  sections: Section[];
  linksUsed: LinkUsed[];
  faq: FaqEntry[];
  imageBriefs: ImageBrief[];
  wordCount: number;
  qcNotes: string;
}

/** The raw shape the model submits, before normalising. */
export interface SubmittedArticle {
  title?: string;
  slug?: string;
  meta_description?: string;
  intro_blocks?: Block[];
  sections?: Section[];
  links_used?: Array<{ anchor?: string; url?: string; kind?: string; rationale?: string }>;
  faq?: Array<{ question?: string; answer?: string }>;
  image_briefs?: Array<{ placement?: string; description?: string; alt_text?: string }>;
  word_count?: number;
  qc_notes?: string;
}

export const SUBMIT_ARTICLE_TOOL_NAME = "submit_article";

/**
 * Prepare a JSON schema for strict tool use.
 *
 * Strict mode is what stops the model hand-rolling its tool input, but it will
 * only accept a schema where every object explicitly refuses unknown keys. Doing
 * that by hand across a nested schema is a maintenance trap — one missed node
 * and the whole request 400s at run time — so walk it instead.
 */
export function strictSchema<T>(schema: T): T {
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.type === "object" && obj.additionalProperties === undefined) {
      obj.additionalProperties = false;
    }
    for (const value of Object.values(obj)) walk(value);
  };
  walk(schema);
  return schema;
}

export const SUBMIT_ARTICLE_TOOL = {
  name: SUBMIT_ARTICLE_TOOL_NAME,
  /** Schema-validated input. See the note on SUBMIT_RESEARCH_TOOL for why. */
  strict: true,
  description:
    'Submit the finished article in structured form. Each section holds ordered "blocks" — paragraphs or lists. A run with a "link" field becomes a hyperlink; a list-item run with "bold" true becomes that item\'s bold lead-in label.',
  input_schema: strictSchema({
    type: "object",
    required: [
      "title",
      "slug",
      "meta_description",
      "intro_blocks",
      "sections",
      "links_used",
      "faq",
      "image_briefs",
      "word_count",
      "qc_notes",
    ],
    properties: {
      title: {
        type: "string",
        description: "The article headline. No trailing punctuation.",
      },
      slug: {
        type: "string",
        description: "URL-friendly slug: lowercase words separated by hyphens, no stop-word padding.",
      },
      meta_description: {
        type: "string",
        description:
          "150-160 characters. Written for a human scanning a results page, not a keyword string. Must not simply repeat the title.",
      },
      intro_blocks: {
        type: "array",
        description:
          "Lead content before the first subheading — 1-2 paragraphs. Never empty: an article that opens straight into a subheading is a defect.",
        minItems: 1,
        items: { $ref: "#/definitions/block" },
      },
      sections: {
        type: "array",
        description: "The article body, broken into subheaded sections.",
        // minItems 0 or 1 is the only array constraint strict mode enforces, and
        // 1 is the one that matters: without it a schema-valid submission could
        // carry every field and no article. A live run (cmu1jd4uz…) did exactly
        // that on both the first and the corrective round.
        minItems: 1,
        items: {
          type: "object",
          required: ["heading", "blocks"],
          properties: {
            heading: {
              type: "string",
              description:
                "Subheading with no trailing punctuation, except a question mark when the heading is a genuine question the section answers.",
            },
            blocks: {
              type: "array",
              description:
                "The section content, in order. Each block is either a prose paragraph or a list. Use a list whenever you present a set of discrete, parallel items.",
              minItems: 1,
              items: { $ref: "#/definitions/block" },
            },
          },
        },
      },
      links_used: {
        type: "array",
        description: "Every hyperlink in the article, for QC and audit.",
        items: {
          type: "object",
          required: ["anchor", "url", "kind", "rationale"],
          properties: {
            anchor: { type: "string" },
            url: { type: "string" },
            kind: {
              type: "string",
              enum: ["internal", "external"],
              description:
                '"internal" for a page on the client\'s own site, "external" for any outside reference.',
            },
            rationale: { type: "string", description: "Why this link helps the reader here." },
          },
        },
      },
      faq: {
        type: "array",
        description:
          "Only when the brief asks for an FAQ. Questions a reader still has after the article, each answered in 2-4 sentences that do not repeat the body verbatim. Empty array otherwise.",
        items: {
          type: "object",
          required: ["question", "answer"],
          properties: {
            question: { type: "string" },
            answer: { type: "string" },
          },
        },
      },
      image_briefs: {
        type: "array",
        description:
          "Only when the brief asks for image briefs. What to commission or find for each image slot, and the alt text it should carry. Empty array otherwise.",
        items: {
          type: "object",
          required: ["placement", "description", "alt_text"],
          properties: {
            placement: {
              type: "string",
              description: 'Where it goes, e.g. "hero" or the heading of the section it sits under.',
            },
            description: { type: "string", description: "What the image should show, concretely." },
            alt_text: {
              type: "string",
              description: "Alt text describing the image for a reader who cannot see it. Not a keyword string.",
            },
          },
        },
      },
      word_count: {
        type: "integer",
        description: "Approximate word count of the body, excluding the title.",
      },
      qc_notes: {
        type: "string",
        description:
          "Notes to the editor: anything notable about voice, sourcing, or links. Empty string if nothing notable.",
      },
    },
    definitions: {
      paragraph: {
        type: "array",
        description: "A sequence of text runs — one prose paragraph, or one list item.",
        minItems: 1,
        items: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string" },
            link: {
              type: "string",
              description: "Optional URL to hyperlink this run. Omit for plain text.",
            },
            bold: {
              type: "boolean",
              description:
                'True ONLY for the short lead-in label at the very start of a list item (e.g. "Permit fees"). Never bold body prose or whole sentences.',
            },
          },
        },
      },
      block: {
        type: "object",
        description:
          'One piece of content: a prose paragraph (type="paragraph") or a list (type="list").',
        required: ["type"],
        properties: {
          type: { type: "string", enum: ["paragraph", "list"] },
          runs: {
            description: 'For type="paragraph" ONLY: the paragraph as a sequence of text runs.',
            $ref: "#/definitions/paragraph",
          },
          ordered: {
            type: "boolean",
            description:
              'For type="list" ONLY: true for a numbered list (sequence or steps), false for bullets.',
          },
          items: {
            type: "array",
            description: 'For type="list" ONLY: each entry is one list item, itself a sequence of runs.',
            minItems: 1,
            items: { $ref: "#/definitions/paragraph" },
          },
        },
      },
    },
  }),
} as Anthropic.Tool;

/**
 * True when a submit_article call actually carries a body.
 *
 * A call can be structurally valid and still empty: after a web_search round the
 * model sometimes submits with only the leading fields populated and no
 * `sections`, with a perfectly normal stop_reason. dm-watcher accepted one of
 * those once and the failure surfaced ~700 lines later blaming max_tokens, which
 * was never the cause. Treating it as "has not submitted yet" lets the caller run
 * the corrective round instead.
 */
export function hasArticleBody(submitted: SubmittedArticle | undefined): boolean {
  if (!submitted) return false;
  if (!Array.isArray(submitted.sections) || submitted.sections.length === 0) return false;
  return submitted.sections.some(
    (section) => Array.isArray(section?.blocks) && section.blocks.length > 0,
  );
}

/**
 * What a submission actually held, for diagnosing an empty one. Field names
 * alone were not enough: a failed run listed "sections" as present, which hid
 * whether it was an empty list, a string, or sections with no blocks.
 */
export function submittedFields(submitted: unknown): string {
  if (typeof submitted !== "object" || submitted === null) return `(input was ${typeof submitted})`;
  const input = submitted as Record<string, unknown>;
  const names = Object.keys(input).join(", ") || "(no fields)";
  const shape = (value: unknown) =>
    Array.isArray(value) ? `${value.length} item(s)` : value === undefined ? "missing" : typeof value;
  const sections = input.sections;
  const perSection = Array.isArray(sections)
    ? ` [blocks per section: ${sections.map((s) => (s && typeof s === "object" ? shape((s as Record<string, unknown>).blocks) : typeof s)).join(", ") || "none"}]`
    : "";
  return `${names}; intro_blocks ${shape(input.intro_blocks)}, sections ${shape(sections)}${perSection}`;
}

export function normaliseArticle(
  submitted: SubmittedArticle,
  fallback: { focusKeyword: string },
): Article {
  const title = (submitted.title ?? "").trim();
  const sections = asArray<Section>(submitted.sections)
    .filter((s) => s && typeof s.heading === "string")
    .map((s) => ({ heading: s.heading.trim(), blocks: cleanBlocks(s.blocks) }))
    .filter((s) => s.blocks.length > 0);

  const introBlocks = cleanBlocks(submitted.intro_blocks);
  const article: Article = {
    title,
    slug: slugify(submitted.slug || title),
    metaDescription: (submitted.meta_description ?? "").trim(),
    focusKeyword: fallback.focusKeyword,
    introBlocks,
    sections,
    linksUsed: asArray<{ anchor: string; url: string; kind: string; rationale: string }>(
      submitted.links_used,
    )
      .filter((l) => Boolean(l?.anchor && l?.url))
      .map((l) => ({
        anchor: l.anchor.trim(),
        url: l.url.trim(),
        kind: l.kind === "internal" ? "internal" : "external",
        rationale: (l.rationale ?? "").trim(),
      })),
    faq: asArray<{ question?: string; answer?: string }>(submitted.faq)
      .filter((entry) => entry?.question && entry?.answer)
      .map((entry) => ({ question: entry.question!.trim(), answer: entry.answer!.trim() })),
    imageBriefs: asArray<{ placement?: string; description?: string; alt_text?: string }>(
      submitted.image_briefs,
    )
      .filter((entry) => entry?.description)
      .map((entry) => ({
        placement: (entry.placement ?? "").trim(),
        description: entry.description!.trim(),
        altText: (entry.alt_text ?? "").trim(),
      })),
    wordCount: 0,
    qcNotes: (submitted.qc_notes ?? "").trim(),
  };

  // Always recount. The model's own word_count is an estimate and QC holds the
  // draft to a band, so an estimate that drifts 200 words either way turns a
  // passing article into a failing one (or the reverse).
  article.wordCount = countWords(articleText(article));
  return article;
}

/**
 * A tool input field is whatever the model put there.
 *
 * The schema says `angles` is an array of strings; a live run returned it as a
 * single string and `.filter` threw, taking the article down at the first stage.
 * The API only guarantees the shape for a tool declared `strict`, and a missing
 * optional still arrives undefined. Never call an array method on tool output
 * without going through this.
 */
export function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value === undefined || value === null) return [];
  return [value as T];
}

function cleanBlocks(blocks: Block[] | undefined): Block[] {
  if (!Array.isArray(blocks)) return [];
  const cleaned: Block[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "list") {
      const items = (block.items ?? [])
        .map(cleanRuns)
        .filter((runs) => runs.length > 0);
      if (items.length > 0) cleaned.push({ type: "list", ordered: block.ordered === true, items });
    } else {
      const runs = cleanRuns(block.runs);
      if (runs.length > 0) cleaned.push({ type: "paragraph", runs });
    }
  }
  return cleaned;
}

function cleanRuns(runs: TextRun[] | undefined): TextRun[] {
  if (!Array.isArray(runs)) return [];
  return runs
    .filter((run) => run && typeof run.text === "string" && run.text.length > 0)
    .map((run) => {
      const cleaned: TextRun = { text: run.text };
      if (typeof run.link === "string" && /^https?:\/\//i.test(run.link.trim())) {
        cleaned.link = run.link.trim();
      }
      if (run.bold === true) cleaned.bold = true;
      return cleaned;
    });
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// ─── Reading the article back ────────────────────────────────────────────────

export function runsText(runs: TextRun[]): string {
  return runs.map((run) => run.text).join("");
}

export function blockText(block: Block): string {
  return block.type === "list"
    ? block.items.map(runsText).join("\n")
    : runsText(block.runs);
}

/** Every word in the article body. Excludes the title, as the length band does. */
export function articleText(article: Article): string {
  return [
    ...article.introBlocks.map(blockText),
    ...article.sections.flatMap((section) => [section.heading, ...section.blocks.map(blockText)]),
  ].join("\n\n");
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function allRuns(article: Article): TextRun[] {
  const fromBlocks = (blocks: Block[]) =>
    blocks.flatMap((block) => (block.type === "list" ? block.items.flat() : block.runs));
  return [
    ...fromBlocks(article.introBlocks),
    ...article.sections.flatMap((section) => fromBlocks(section.blocks)),
  ];
}

/** Links as they really appear in the prose, not as the model declared them. */
export function actualLinks(article: Article): Array<{ anchor: string; url: string }> {
  return allRuns(article)
    .filter((run): run is TextRun & { link: string } => Boolean(run.link))
    .map((run) => ({ anchor: run.text, url: run.link }));
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderRuns(runs: TextRun[]): string {
  return runs
    .map((run) => {
      let html = escapeHtml(run.text);
      if (run.bold) html = `<strong>${html}</strong>`;
      if (run.link) html = `<a href="${escapeHtml(run.link)}">${html}</a>`;
      return html;
    })
    .join("");
}

function renderBlockHtml(block: Block): string {
  if (block.type === "list") {
    const tag = block.ordered ? "ol" : "ul";
    const items = block.items.map((item) => `  <li>${renderRuns(item)}</li>`).join("\n");
    return `<${tag}>\n${items}\n</${tag}>`;
  }
  return `<p>${renderRuns(block.runs)}</p>`;
}

/**
 * The body as CMS-ready HTML. No inline styles, no wrapper div, no <h1> — the
 * title is a field, and every CMS renders its own. WordPress, Storyblok and
 * Webflow all take this as-is.
 */
export function renderHtml(article: Article): string {
  return [
    ...article.introBlocks.map(renderBlockHtml),
    ...article.sections.flatMap((section) => [
      `<h2>${escapeHtml(section.heading)}</h2>`,
      ...section.blocks.map(renderBlockHtml),
    ]),
  ].join("\n\n");
}

function renderRunsMarkdown(runs: TextRun[]): string {
  return runs
    .map((run) => {
      let text = run.text;
      if (run.bold) text = `**${text}**`;
      if (run.link) text = `[${text}](${run.link})`;
      return text;
    })
    .join("");
}

function renderBlockMarkdown(block: Block): string {
  if (block.type === "list") {
    return block.items
      .map((item, i) => `${block.ordered ? `${i + 1}.` : "-"} ${renderRunsMarkdown(item)}`)
      .join("\n");
  }
  return renderRunsMarkdown(block.runs);
}

/** Markdown, for the editor preview and for anyone pasting into a doc. */
export function renderMarkdown(article: Article): string {
  return [
    `# ${article.title}`,
    ...article.introBlocks.map(renderBlockMarkdown),
    ...article.sections.flatMap((section) => [
      `## ${section.heading}`,
      ...section.blocks.map(renderBlockMarkdown),
    ]),
  ].join("\n\n");
}

export function estimateReadMinutes(article: Article): number {
  return Math.max(1, Math.round(article.wordCount / 225));
}

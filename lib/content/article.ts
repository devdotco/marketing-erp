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
 *
 * 2026-09-14 — visual blocks. The model supplies DATA (a table's rows, a
 * chart's series, an image's prompt); this file, never the model, turns that
 * into markup. The model is never allowed to emit raw HTML or SVG — that is
 * exactly the failure mode the switch to structured blocks fixed for prose,
 * and letting it back in through a "visual" side door would reopen it.
 */

/** One span of text. `link` makes it a hyperlink; `bold` a list item's lead-in label. */
export interface TextRun {
  text: string;
  link?: string;
  bold?: boolean;
}

export interface ParagraphBlock {
  type: "paragraph";
  runs: TextRun[];
}

export interface ListBlock {
  type: "list";
  ordered?: boolean;
  items: TextRun[][];
}

/** A comparison table. Strings only — no markup, no HTML. */
export interface TableBlock {
  type: "table";
  caption?: string;
  headers: string[];
  /** Each row has the same length as `headers`. */
  rows: string[][];
}

/** A key-takeaway / tip / warning / stat box. */
export interface CalloutBlock {
  type: "callout";
  kind: "key_takeaway" | "tip" | "warning" | "stat";
  title?: string;
  runs: TextRun[];
}

/** A single big-number callout, e.g. "42% — of firms that never re-audit." */
export interface StatBlock {
  type: "stat";
  value: string;
  label: string;
  /** The verified source this figure comes from. See qc.ts for why this is enforced, not optional in practice. */
  sourceUrl?: string;
}

export interface ChartSeriesPoint {
  label: string;
  value: number;
}

export interface ChartBlock {
  type: "chart";
  kind: "bar" | "horizontal_bar" | "line";
  title: string;
  unit?: string;
  series: ChartSeriesPoint[];
  sourceUrl?: string;
  caption?: string;
}

/**
 * An AI-generated image slot. `id` is assigned here, never by the model — it
 * is how a generated file (lib/images/*) and a CMS media upload
 * (lib/agent-handlers/blog-writer.ts) find their way back to this exact spot
 * in the body when renderHtml is called again after generation/upload.
 */
export interface ImageBlock {
  type: "image";
  id: string;
  slot: "hero" | "inline";
  prompt: string;
  alt: string;
  caption?: string;
}

export type Block =
  | ParagraphBlock
  | ListBlock
  | TableBlock
  | CalloutBlock
  | StatBlock
  | ChartBlock
  | ImageBlock;

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
  /**
   * Prose word count ONLY (paragraph and list blocks). Excludes every visual
   * block deliberately: a chart title, three bar labels, and a table caption
   * are not fifteen words of article. Counting them would let visuals inflate
   * a draft past the brief's word-count floor without adding anything a
   * reader reads as substance. See proseText() below.
   */
  wordCount: number;
  qcNotes: string;
  /**
   * Visual blocks the model submitted that failed per-type validation (e.g. a
   * table row whose width didn't match its headers, a chart with no series,
   * an image with no alt text) and were silently dropped rather than
   * rendered broken. Surfaced so QC and the run output can say what was lost
   * instead of the article just quietly having fewer visuals than asked for.
   */
  droppedVisuals: string[];
}

/** The raw shape the model submits, before normalising. */
export interface SubmittedArticle {
  title?: string;
  slug?: string;
  meta_description?: string;
  intro_blocks?: unknown[];
  sections?: Array<{ heading?: string; blocks?: unknown[] }>;
  links_used?: Array<{ anchor?: string; url?: string; kind?: string; rationale?: string }>;
  faq?: Array<{ question?: string; answer?: string }>;
  image_briefs?: Array<{ placement?: string; description?: string; alt_text?: string }>;
  word_count?: number;
  qc_notes?: string;
  /** Visuals, submitted separately from the prose blocks. See SUBMIT_ARTICLE_TOOL's `visuals` field and buildVisualBlock. */
  visuals?: unknown[];
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

/**
 * 2026-09-14 — the visual block types (table/callout/stat/chart/image) used
 * to live as extra OPTIONAL properties on `definitions.block`, $ref'd from
 * both intro_blocks and sections[].blocks. That schema was rejected live by
 * the API: `400 invalid_request_error: "Schema is too complex."`
 * (req_011Cf3vfdtPDb472kHMna1jz, claude-sonnet-5, strict + forced tool
 * choice) — every prior run would have failed. `block` is restored below to
 * the exact prose-only shape that was proven live before visuals existed
 * (type/runs/ordered/items, nothing else). Visuals move to a separate
 * top-level `visuals` array instead, whose item schema has NO optional
 * properties at all — strict-schema grammar cost scales with optional
 * properties, not simply with property count, so a flat, fully-required
 * object is cheap however many fields it has. A visual names where it goes
 * with a flat `after_section_index` integer (no nested placement object, no
 * second $ref) and fills every field that doesn't apply to its own type with
 * "" / [] / "none" — normaliseArticle (buildVisualBlock, below) reads that as
 * absent. See test/content.test.ts's schema-shape guard, which fails the
 * build if this ever grows an optional property again.
 */
export const SUBMIT_ARTICLE_TOOL = {
  name: SUBMIT_ARTICLE_TOOL_NAME,
  /** Schema-validated input. See the note on SUBMIT_RESEARCH_TOOL for why. */
  strict: true,
  description:
    'Submit the finished article in structured form. Each section holds ordered "blocks" — paragraphs or lists. A run with a "link" field becomes a hyperlink; a list-item run with "bold" true becomes that item\'s bold lead-in label. Separately, populate the top-level "visuals" array for any tables, callouts, stats, charts or images — see its own description.',
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
      "visuals",
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
      visuals: {
        type: "array",
        minItems: 0,
        description:
          'Tables, callouts, stats, charts and images — only where the brief asks for visuals, only with data traced to a CLAIM EVIDENCE entry. Empty array otherwise. Every entry has EVERY field; fill in whichever apply to its "type" and leave the rest "" / [] / "none".',
        items: {
          type: "object",
          required: [
            "type",
            "after_section_index",
            "title",
            "caption",
            "kind",
            "body",
            "value",
            "label",
            "source_url",
            "unit",
            "headers",
            "rows",
            "series",
            "image_prompt",
            "alt",
            "slot",
          ],
          properties: {
            type: { type: "string", enum: ["table", "callout", "stat", "chart", "image"], description: "Which visual this is." },
            after_section_index: { type: "integer", description: "Placement: -1 = after the intro, 0 = after section 1, 1 = after section 2, etc." },
            title: { type: "string", description: "chart/callout title. \"\" if not applicable." },
            caption: { type: "string", description: "table/chart/image caption. \"\" if not applicable." },
            kind: {
              type: "string",
              enum: ["key_takeaway", "tip", "warning", "stat", "bar", "horizontal_bar", "line", "none"],
              description: 'callout kind (key_takeaway/tip/warning/stat) or chart kind (bar/horizontal_bar/line). "none" if not applicable.',
            },
            body: { type: "string", description: "callout text, plain — no links or formatting. \"\" if not applicable." },
            value: { type: "string", description: 'stat value, e.g. "42%". Must trace to a CLAIM EVIDENCE entry. "" if not applicable.' },
            label: { type: "string", description: "stat label. \"\" if not applicable." },
            source_url: { type: "string", description: "verified source URL for a stat/chart, copied exactly from the research. \"\" if not applicable." },
            unit: { type: "string", description: "chart unit, e.g. \"%\". \"\" if not applicable." },
            headers: { type: "array", items: { type: "string" }, description: "table column headers. [] if not applicable." },
            rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "table rows, each the same width as headers. [] if not applicable." },
            series: {
              type: "array",
              items: { type: "object", required: ["label", "value"], properties: { label: { type: "string" }, value: { type: "number" } } },
              description: "chart data points; each value must trace to a CLAIM EVIDENCE entry. [] if not applicable.",
            },
            image_prompt: { type: "string", description: "concrete image description; no real people, logos, or on-image text. \"\" if not applicable." },
            alt: { type: "string", description: "image alt text. \"\" if not applicable." },
            slot: { type: "string", enum: ["hero", "inline", "none"], description: '"hero" or "inline". "none" if not applicable.' },
          },
        },
      },
      word_count: {
        type: "integer",
        description: "Approximate word count of the prose body (paragraphs and lists only, not visuals), excluding the title.",
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
  const dropped: string[] = [];
  const idGen = { n: 0 };

  // Prose first, indexed exactly as submitted (before dropping empty
  // sections) so a visual's after_section_index lines up with what the model
  // meant, even if that section turns out to have no prose of its own.
  const sectionSlots = asArray<{ heading?: string; blocks?: unknown[] }>(submitted.sections)
    .filter((s) => s && typeof s.heading === "string")
    .map((s) => ({ heading: s.heading!.trim(), blocks: cleanBlocks(s.blocks) }));

  const introBlocks = cleanBlocks(submitted.intro_blocks);

  // Visuals arrive separately from the prose — see SUBMIT_ARTICLE_TOOL's
  // `visuals` field for why (a $ref'd block definition carrying every visual
  // type's optional fields tripped Anthropic's strict-schema complexity limit
  // on 2026-09-14: 400 "Schema is too complex", req_011Cf3vfdtPDb472kHMna1jz).
  // Each entry is placed at the end of the section (or the intro) it names.
  for (const raw of asArray<unknown>(submitted.visuals)) {
    const built = buildVisualBlock(raw, dropped, idGen);
    if (!built) continue;
    const record = raw as Record<string, unknown>;
    const requested =
      typeof record.after_section_index === "number" && Number.isFinite(record.after_section_index)
        ? Math.trunc(record.after_section_index)
        : -1;
    if (requested <= -1 || sectionSlots.length === 0) {
      introBlocks.push(built);
    } else {
      sectionSlots[Math.min(requested, sectionSlots.length - 1)].blocks.push(built);
    }
  }

  const sections = sectionSlots.filter((s) => s.blocks.length > 0);

  const article: Article = {
    title: (submitted.title ?? "").trim(),
    slug: slugify(submitted.slug || submitted.title || ""),
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
    droppedVisuals: dropped,
  };

  // Always recount, and prose only. The model's own word_count is an estimate,
  // QC holds the draft to a floor, and counting a chart's bar labels toward
  // that floor would let three words of axis text stand in for thirty of
  // article. See proseText() and the Article.wordCount doc comment.
  article.wordCount = countWords(proseText(article));
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

const CALLOUT_KINDS = new Set(["key_takeaway", "tip", "warning", "stat"]);
const CHART_KINDS = new Set(["bar", "horizontal_bar", "line"]);

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function cleanUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : undefined;
}

/**
 * Normalise one section's (or the intro's) prose blocks. Restored to the
 * exact shape proven live before visuals existed — paragraph and list only.
 * See buildVisualBlock, below, for the separate visuals array.
 */
function cleanBlocks(blocks: unknown[] | undefined): Block[] {
  if (!Array.isArray(blocks)) return [];
  const cleaned: Block[] = [];
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    if (block.type === "list") {
      const items = asArray<TextRun[]>(block.items)
        .map(cleanRuns)
        .filter((runs) => runs.length > 0);
      if (items.length > 0) cleaned.push({ type: "list", ordered: block.ordered === true, items });
    } else {
      const runs = cleanRuns(block.runs as TextRun[] | undefined);
      if (runs.length > 0) cleaned.push({ type: "paragraph", runs });
    }
  }
  return cleaned;
}

/**
 * Build one internal visual Block from a `visuals[]` entry — the flat,
 * all-required shape SUBMIT_ARTICLE_TOOL's `visuals` items use (see that
 * schema's doc comment). Fields that don't apply to this entry's `type`
 * arrive as "" / [] / "none" and are treated as absent by cleanText/cleanUrl
 * and the enum-membership checks below — same validation, and the same
 * `dropped` reasons, as the old inline block variants had.
 */
function buildVisualBlock(raw: unknown, dropped: string[], idGen: { n: number }): Block | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;

  switch (v.type) {
    case "table": {
      const headers = asArray<unknown>(v.headers)
        .filter((h): h is string => typeof h === "string" && h.trim() !== "")
        .map((h) => h.trim());
      const rows = asArray<unknown>(v.rows)
        .map((row) => asArray<unknown>(row).map((cell) => (typeof cell === "string" ? cell.trim() : "")))
        .filter((row) => row.length === headers.length && row.some((cell) => cell !== ""));
      if (headers.length === 0 || rows.length === 0) {
        dropped.push(`A table visual was dropped: ${headers.length === 0 ? "no headers" : "no row matched the header width"}.`);
        return null;
      }
      return { type: "table", caption: cleanText(v.caption), headers, rows };
    }

    case "callout": {
      const kind = typeof v.kind === "string" && CALLOUT_KINDS.has(v.kind) ? (v.kind as CalloutBlock["kind"]) : undefined;
      const bodyText = cleanText(v.body);
      if (!kind || !bodyText) {
        dropped.push(`A callout visual was dropped: ${!kind ? "invalid or missing kind" : "empty body"}.`);
        return null;
      }
      return { type: "callout", kind, title: cleanText(v.title), runs: [{ text: bodyText }] };
    }

    case "stat": {
      const value = cleanText(v.value);
      const label = cleanText(v.label);
      if (!value || !label) {
        dropped.push(`A stat visual was dropped: missing ${!value ? "value" : "label"}.`);
        return null;
      }
      return { type: "stat", value, label, sourceUrl: cleanUrl(v.source_url) };
    }

    case "chart": {
      const kind = typeof v.kind === "string" && CHART_KINDS.has(v.kind) ? (v.kind as ChartBlock["kind"]) : undefined;
      const title = cleanText(v.title);
      const series = asArray<{ label?: unknown; value?: unknown }>(v.series)
        .filter((p) => p && typeof p.label === "string" && p.label.trim() !== "" && typeof p.value === "number" && Number.isFinite(p.value))
        .map((p) => ({ label: (p.label as string).trim(), value: p.value as number }));
      if (!kind || !title || series.length === 0) {
        dropped.push(`A chart visual was dropped: ${!kind ? "invalid kind" : !title ? "no title" : "no valid series data"}.`);
        return null;
      }
      return {
        type: "chart",
        kind,
        title,
        unit: cleanText(v.unit),
        series,
        sourceUrl: cleanUrl(v.source_url),
        caption: cleanText(v.caption),
      };
    }

    case "image": {
      const slot = v.slot === "hero" || v.slot === "inline" ? (v.slot as ImageBlock["slot"]) : undefined;
      const prompt = cleanText(v.image_prompt);
      const alt = cleanText(v.alt);
      if (!slot || !prompt || !alt) {
        dropped.push(`An image visual was dropped: ${!slot ? "invalid slot" : !prompt ? "no prompt" : "no alt text"}.`);
        return null;
      }
      idGen.n += 1;
      return { type: "image", id: `img-${idGen.n}`, slot, prompt, alt, caption: cleanText(v.caption) };
    }

    default:
      dropped.push(`A visual with an unrecognised type ("${String(v.type ?? "")}") was dropped.`);
      return null;
  }
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

/** True prose blocks only — see the Article.wordCount doc comment. */
export function isProseBlock(block: Block): block is ParagraphBlock | ListBlock {
  return block.type === "paragraph" || block.type === "list";
}

/**
 * Plain-text rendering of any block, for voice/QC scanning (banned words,
 * must-cover matching) and for the section-by-section word counts in the
 * run's output. Includes visual blocks' captions and labels — those are
 * reader-facing text and a banned word in a chart title is still a banned
 * word — but see proseText() for the word-count-proper figure, which
 * deliberately excludes them.
 */
export function blockText(block: Block): string {
  switch (block.type) {
    case "list":
      return block.items.map(runsText).join("\n");
    case "paragraph":
      return runsText(block.runs);
    case "callout":
      return [block.title, runsText(block.runs)].filter(Boolean).join(": ");
    case "stat":
      return [block.label, block.value].filter(Boolean).join(": ");
    case "chart":
      return [block.title, block.caption].filter(Boolean).join(". ");
    case "table":
      return [block.caption, block.headers.join(", ")].filter(Boolean).join(". ");
    case "image":
      return [block.alt, block.caption].filter(Boolean).join(". ");
  }
}

/** Every word in the article body, visuals included — for voice/QC text scans, never for the word-count figure. */
export function articleText(article: Article): string {
  return [
    ...article.introBlocks.map(blockText),
    ...article.sections.flatMap((section) => [section.heading, ...section.blocks.map(blockText)]),
  ].join("\n\n");
}

/**
 * Prose only, for the article's actual word count. See the Article.wordCount
 * doc comment for why visual blocks are excluded: they are data and captions,
 * not article, and letting them count would let a chart substitute for
 * substance against the brief's word-count floor.
 */
function proseText(article: Article): string {
  return [
    ...article.introBlocks.filter(isProseBlock).map(blockText),
    ...article.sections.flatMap((section) => section.blocks.filter(isProseBlock).map(blockText)),
  ].join("\n\n");
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Every text run in the article's prose and callouts — the surface QC's link
 * checks and the honesty rules operate over. Deliberately does NOT include a
 * stat's or chart's `sourceUrl`: those become a real, visible "Source" link in
 * the rendered HTML (see renderStatHtml/renderChartHtml) but are a citation of
 * the VISUAL's data, not an editorial link placement, so they are capped by
 * the brief's chart/table/image limits instead of counted against
 * externalLinkCount. See lib/content/qc.ts for where that split is enforced.
 */
export function allRuns(article: Article): TextRun[] {
  const fromBlocks = (blocks: Block[]) =>
    blocks.flatMap((block) => {
      if (block.type === "list") return block.items.flat();
      if (block.type === "paragraph" || block.type === "callout") return block.runs;
      return [];
    });
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

function renderTableHtml(block: TableBlock): string {
  const caption = block.caption ? `<caption>${escapeHtml(block.caption)}</caption>` : "";
  const thead = `<thead><tr>${block.headers.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${block.rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("")}</tbody>`;
  return `<figure class="erp-table"><table>${caption}${thead}${tbody}</table></figure>`;
}

function renderCalloutHtml(block: CalloutBlock): string {
  const kindClass = block.kind.replace(/_/g, "-");
  const title = block.title ? `<p class="erp-callout__title"><strong>${escapeHtml(block.title)}</strong></p>` : "";
  return `<aside class="erp-callout erp-callout--${kindClass}">${title}<p>${renderRuns(block.runs)}</p></aside>`;
}

function renderStatHtml(block: StatBlock): string {
  const source = block.sourceUrl
    ? ` <a class="erp-stat__source" href="${escapeHtml(block.sourceUrl)}">Source</a>`
    : "";
  return `<aside class="erp-stat"><p class="erp-stat__value">${escapeHtml(block.value)}</p><p class="erp-stat__label">${escapeHtml(block.label)}${source}</p></aside>`;
}

/**
 * SVG chart. Inline, deterministic, no script, `role="img"` plus a `<title>`
 * and `<desc>` for a screen reader, and colored with `currentColor` /
 * `fill-opacity` only — no fixed hex — so it reads correctly whichever theme
 * the host page is in. A `<details>` data-table fallback covers a reader on
 * assistive tech that skips SVG content, and a site that strips SVG under
 * kses (see the file-level note in this module on WordPress kses) still gets
 * the caption and the data table.
 */
let chartSeq = 0;
function renderChartHtml(block: ChartBlock): string {
  chartSeq += 1;
  const titleId = `erp-chart-title-${chartSeq}`;
  const descId = `erp-chart-desc-${chartSeq}`;
  const max = Math.max(...block.series.map((p) => p.value), 0) || 1;
  const unit = block.unit ?? "";
  const desc = `${block.kind === "line" ? "Line chart" : "Bar chart"}: ${block.series
    .map((p) => `${p.label} ${p.value}${unit}`)
    .join(", ")}.`;

  const width = 480;
  let svgBody: string;
  let height: number;

  if (block.kind === "horizontal_bar") {
    const rowHeight = 34;
    height = block.series.length * rowHeight + 20;
    const labelWidth = 130;
    const plotWidth = width - labelWidth - 60;
    svgBody = block.series
      .map((p, i) => {
        const y = 10 + i * rowHeight;
        const barWidth = Math.max(2, (p.value / max) * plotWidth);
        return [
          `<text x="0" y="${y + rowHeight / 2 + 4}" font-size="12" fill="currentColor">${escapeHtml(truncateLabel(p.label))}</text>`,
          `<rect x="${labelWidth}" y="${y}" width="${barWidth}" height="${rowHeight - 10}" fill="currentColor" fill-opacity="0.75" rx="2"></rect>`,
          `<text x="${labelWidth + barWidth + 6}" y="${y + rowHeight / 2 + 4}" font-size="12" fill="currentColor">${escapeHtml(String(p.value))}${escapeHtml(unit)}</text>`,
        ].join("");
      })
      .join("");
  } else if (block.kind === "line") {
    height = 220;
    const plotHeight = height - 40;
    const plotWidth = width - 40;
    const stepX = block.series.length > 1 ? plotWidth / (block.series.length - 1) : 0;
    const points = block.series
      .map((p, i) => {
        const x = 20 + i * stepX;
        const y = 10 + plotHeight - (p.value / max) * plotHeight;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    const dots = block.series
      .map((p, i) => {
        const x = 20 + i * stepX;
        const y = 10 + plotHeight - (p.value / max) * plotHeight;
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="currentColor"></circle>`;
      })
      .join("");
    const labels = block.series
      .map((p, i) => {
        const x = 20 + i * stepX;
        return `<text x="${x.toFixed(1)}" y="${height - 4}" font-size="11" text-anchor="middle" fill="currentColor">${escapeHtml(truncateLabel(p.label))}</text>`;
      })
      .join("");
    svgBody = `<polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2"></polyline>${dots}${labels}`;
  } else {
    // bar (vertical)
    height = 240;
    const plotHeight = height - 40;
    const barGap = 12;
    const barWidth = Math.max(8, width / block.series.length - barGap);
    svgBody = block.series
      .map((p, i) => {
        const barHeight = Math.max(2, (p.value / max) * plotHeight);
        const x = i * (barWidth + barGap) + barGap / 2;
        const y = 10 + (plotHeight - barHeight);
        return [
          `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" fill="currentColor" fill-opacity="0.75" rx="2"></rect>`,
          `<text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="11" text-anchor="middle" fill="currentColor">${escapeHtml(String(p.value))}${escapeHtml(unit)}</text>`,
          `<text x="${(x + barWidth / 2).toFixed(1)}" y="${height - 4}" font-size="11" text-anchor="middle" fill="currentColor">${escapeHtml(truncateLabel(p.label))}</text>`,
        ].join("");
      })
      .join("");
  }

  const svg = `<svg role="img" aria-labelledby="${titleId} ${descId}" viewBox="0 0 ${width} ${height}" width="100%" height="auto" xmlns="http://www.w3.org/2000/svg"><title id="${titleId}">${escapeHtml(block.title)}</title><desc id="${descId}">${escapeHtml(desc)}</desc>${svgBody}</svg>`;

  const dataTable = `<details class="erp-chart__data"><summary>Data table</summary><table><caption>${escapeHtml(block.title)}</caption><thead><tr><th scope="col">${block.kind === "line" || block.kind === "bar" ? "Point" : "Category"}</th><th scope="col">Value${unit ? ` (${escapeHtml(unit)})` : ""}</th></tr></thead><tbody>${block.series
    .map((p) => `<tr><td>${escapeHtml(p.label)}</td><td>${escapeHtml(String(p.value))}</td></tr>`)
    .join("")}</tbody></table></details>`;

  const sourceLine = block.sourceUrl
    ? ` — <a href="${escapeHtml(block.sourceUrl)}">source</a>`
    : "";
  const captionText = block.caption ? escapeHtml(block.caption) : escapeHtml(block.title);
  const figcaption = `<figcaption>${captionText}${sourceLine}</figcaption>`;

  return `<figure class="erp-chart">${svg}${figcaption}${dataTable}</figure>`;
}

function truncateLabel(label: string): string {
  return label.length > 18 ? `${label.slice(0, 17)}…` : label;
}

function renderImageHtml(block: ImageBlock, assets: Record<string, string>): string {
  const src = assets[block.id];
  const caption = block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : "";
  if (!src) {
    // No generated (or uploaded) asset yet — image briefs only, or generation
    // hasn't run. An <img> with no real src can re-request the current page in
    // some browsers, so render a plain placeholder instead, marked with the
    // same data-image-id a later renderHtml() call (post-generation) or a CMS
    // publish pass (replaceImageSrc, below) can find.
    return `<figure class="erp-image erp-image--pending" data-image-id="${escapeHtml(block.id)}"><figcaption>Image pending: ${escapeHtml(block.alt)}</figcaption></figure>`;
  }
  return `<figure class="erp-image"><img src="${escapeHtml(src)}" alt="${escapeHtml(block.alt)}" data-image-id="${escapeHtml(block.id)}">${caption}</figure>`;
}

function renderBlockHtml(block: Block, assets: Record<string, string>): string {
  switch (block.type) {
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const items = block.items.map((item) => `  <li>${renderRuns(item)}</li>`).join("\n");
      return `<${tag}>\n${items}\n</${tag}>`;
    }
    case "paragraph":
      return `<p>${renderRuns(block.runs)}</p>`;
    case "table":
      return renderTableHtml(block);
    case "callout":
      return renderCalloutHtml(block);
    case "stat":
      return renderStatHtml(block);
    case "chart":
      return renderChartHtml(block);
    case "image":
      return renderImageHtml(block, assets);
  }
}

/**
 * The body as CMS-ready HTML. No `<script>`, no `<style>` tag, no wrapper div,
 * no `<h1>` — the title is a field, and every CMS renders its own. Inline
 * styles are deliberately avoided too: WordPress' kses sanitiser strips them
 * for any role below `unfiltered_html` (Administrator, or Editor/Author only
 * on a single-site install), so visuals lean on semantic markup plus simple
 * `erp-*` classes a theme can style, with inline SVG for charts (kses allows
 * `<svg>` and its children by default) rather than inline `style=` attributes.
 *
 * `imageAssets` maps an ImageBlock's id to the URL to embed as its `src` —
 * pass the workspace's own `/api/assets/:id` route for the run preview, or a
 * CMS's uploaded media URL when rendering the body that gets published (see
 * replaceImageSrc for updating an already-rendered body after upload instead
 * of re-rendering). Omit it, or leave an id out of it, to get the
 * "pending" placeholder — the correct behaviour before generation has run, or
 * when no image provider is connected.
 */
export function renderHtml(article: Article, imageAssets: Record<string, string> = {}): string {
  return [
    ...article.introBlocks.map((b) => renderBlockHtml(b, imageAssets)),
    ...article.sections.flatMap((section) => [
      `<h2>${escapeHtml(section.heading)}</h2>`,
      ...section.blocks.map((b) => renderBlockHtml(b, imageAssets)),
    ]),
  ].join("\n\n");
}

/**
 * Swap an already-rendered image's `src` for a CMS's uploaded media URL,
 * in place, without re-rendering the whole article. Used once per image
 * after WordPress/Payload upload succeeds — see lib/agent-handlers/blog-writer.ts.
 * Matches only the exact `<img … data-image-id="ID">` tag this module emits.
 */
export function replaceImageSrc(html: string, imageId: string, newSrc: string): string {
  const escapedId = imageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<img src="[^"]*"([^>]*data-image-id="${escapedId}")>`);
  return html.replace(re, `<img src="${escapeHtml(newSrc)}"$1>`);
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
  switch (block.type) {
    case "list":
      return block.items
        .map((item, i) => `${block.ordered ? `${i + 1}.` : "-"} ${renderRunsMarkdown(item)}`)
        .join("\n");
    case "paragraph":
      return renderRunsMarkdown(block.runs);
    case "table": {
      const header = `| ${block.headers.join(" | ")} |`;
      const divider = `| ${block.headers.map(() => "---").join(" | ")} |`;
      const rows = block.rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
      const caption = block.caption ? `\n*${block.caption}*` : "";
      return `${header}\n${divider}\n${rows}${caption}`;
    }
    case "callout": {
      const label = block.kind.replace(/_/g, " ").toUpperCase();
      const title = block.title ? ` — ${block.title}` : "";
      return `> **${label}${title}**\n> ${renderRunsMarkdown(block.runs)}`;
    }
    case "stat":
      return `**${block.value}** — ${block.label}${block.sourceUrl ? ` ([source](${block.sourceUrl}))` : ""}`;
    case "chart": {
      const unit = block.unit ?? "";
      const points = block.series.map((p) => `${p.label}: ${p.value}${unit}`).join(", ");
      const source = block.sourceUrl ? ` ([source](${block.sourceUrl}))` : "";
      return `**Chart — ${block.title}**: ${points}${source}${block.caption ? `\n*${block.caption}*` : ""}`;
    }
    case "image":
      return `![${block.alt}](pending-generation "${block.prompt}")${block.caption ? `\n*${block.caption}*` : ""}`;
  }
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

/** Every image block in the article, intro and sections, in document order. */
export function allImageBlocks(article: Article): ImageBlock[] {
  const fromBlocks = (blocks: Block[]) => blocks.filter((b): b is ImageBlock => b.type === "image");
  return [...fromBlocks(article.introBlocks), ...article.sections.flatMap((s) => fromBlocks(s.blocks))];
}

/** Every chart block, for QC's honesty checks and the visuals count in output. */
export function allChartBlocks(article: Article): ChartBlock[] {
  const fromBlocks = (blocks: Block[]) => blocks.filter((b): b is ChartBlock => b.type === "chart");
  return [...fromBlocks(article.introBlocks), ...article.sections.flatMap((s) => fromBlocks(s.blocks))];
}

/** Every table block. */
export function allTableBlocks(article: Article): TableBlock[] {
  const fromBlocks = (blocks: Block[]) => blocks.filter((b): b is TableBlock => b.type === "table");
  return [...fromBlocks(article.introBlocks), ...article.sections.flatMap((s) => fromBlocks(s.blocks))];
}

/** Every stat block. */
export function allStatBlocks(article: Article): StatBlock[] {
  const fromBlocks = (blocks: Block[]) => blocks.filter((b): b is StatBlock => b.type === "stat");
  return [...fromBlocks(article.introBlocks), ...article.sections.flatMap((s) => fromBlocks(s.blocks))];
}

/** Every callout block. */
export function allCalloutBlocks(article: Article): CalloutBlock[] {
  const fromBlocks = (blocks: Block[]) => blocks.filter((b): b is CalloutBlock => b.type === "callout");
  return [...fromBlocks(article.introBlocks), ...article.sections.flatMap((s) => fromBlocks(s.blocks))];
}

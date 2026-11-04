/**
 * Locked email templates: the master HTML stays byte-for-byte as designed, and
 * the agent may only replace what sits between edit markers.
 *
 *   <!--edit:headline text-->Pick up where you left off.<!--/edit:headline-->
 *
 * The opening marker names a key and a kind:
 *
 *  - `text`        plain text. Any markup the model returns is stripped.
 *  - `rich`        text plus <strong>, <em>, <a href> and <br>. The master's own
 *                  opening <strong …>/<a …> tags (inline styles included) are
 *                  reused, so the model never writes a style attribute.
 *  - `paragraphs`  a list of `rich` paragraphs. Each one is wrapped in the
 *                  master's <p …> tag: the first master paragraph's tag for all
 *                  but the last, the last master paragraph's tag for the last
 *                  (that is where the "margin:0" closing paragraph lives).
 *
 * The group is the key up to its first dot, so `stats.1.value` and
 * `stats.1.label` are both switched on by allowing "stats". A key may appear
 * more than once (a button label sits in both the VML fallback and the <a>);
 * every occurrence gets the same value.
 *
 * Why markers rather than asking the model for the whole document: the model
 * that rewrote the full HTML would also be free to drop the Handlebars
 * greeting, the MSO conditionals or the unsubscribe block. Here it never sees
 * them as something it can return. Pure module, no I/O: shared by the handler,
 * the template editor and the tests.
 */

export type SectionKind = "text" | "rich" | "paragraphs";

export interface TemplateSection {
  key: string;
  group: string;
  kind: SectionKind;
  /** The master's copy in the shape the model edits: a string, or a list for `paragraphs`. */
  original: string | string[];
  /** How many times the key appears in the master. */
  occurrences: number;
}

export interface ParsedTemplate {
  sections: TemplateSection[];
  /** Problems with the markers themselves. A template with any is refused on save. */
  errors: string[];
}

export type SectionValues = Record<string, string | string[]>;

/**
 * Whether a section key is editable under a campaign's allow-list. Entries are
 * either a group ("stats", every stats.* key) or one exact key ("intro.2", so
 * the Dashboard email can reword its second intro paragraph and nothing else).
 */
export function isEditable(key: string, allowed: string[]): boolean {
  return allowed.includes(key) || allowed.includes(groupOf(key));
}

const OPEN_RE = /<!--\s*edit:([a-z0-9_.-]+)\s+(text|rich|paragraphs)\s*-->/gi;
const REGION_RE = /<!--\s*edit:([a-z0-9_.-]+)\s+(text|rich|paragraphs)\s*-->([\s\S]*?)<!--\s*\/edit:\1\s*-->/gi;

export function groupOf(key: string): string {
  return key.split(".")[0]!;
}

// ─── Entities and escaping ──────────────────────────────────────────────────

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Visible text of an HTML fragment: comments and tags removed, entities decoded, whitespace collapsed. */
export function visibleText(html: string): string {
  return collapse(
    decodeEntities(
      html
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
  );
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/** A master's inline markup reduced to bare tags, the form the model reads and writes. */
function simplifyRich(inner: string): string {
  const out = inner
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?([a-z0-9]+)\b([^>]*)>/gi, (tag, name: string, attrs: string) => {
      const n = name.toLowerCase();
      const closing = tag.startsWith("</");
      if (n === "strong" || n === "b") return closing ? "</strong>" : "<strong>";
      if (n === "em" || n === "i") return closing ? "</em>" : "<em>";
      if (n === "br") return "<br>";
      if (n === "a") {
        if (closing) return "</a>";
        const href = /href\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? "";
        return `<a href="${href}">`;
      }
      return "";
    });
  // Entities stay decoded in what the model sees; escaping happens on render.
  return collapse(decodeEntities(out));
}

function paragraphsOf(inner: string): { tags: string[]; bodies: string[] } {
  const tags: string[] = [];
  const bodies: string[] = [];
  for (const m of inner.matchAll(/(<p\b[^>]*>)([\s\S]*?)<\/p>/gi)) {
    tags.push(m[1]!);
    bodies.push(m[2]!);
  }
  return { tags, bodies };
}

export function parseTemplate(html: string): ParsedTemplate {
  const errors: string[] = [];
  const byKey = new Map<string, TemplateSection>();

  const opens = [...html.matchAll(OPEN_RE)].length;
  const regions = [...html.matchAll(REGION_RE)];
  if (regions.length !== opens) {
    errors.push(`${opens - regions.length} edit marker${opens - regions.length === 1 ? " is" : "s are"} never closed. Each <!--edit:key kind--> needs a matching <!--/edit:key-->.`);
  }

  for (const m of regions) {
    const key = m[1]!.toLowerCase();
    const kind = m[2]!.toLowerCase() as SectionKind;
    const inner = m[3]!;

    if (/<!--\s*edit:/i.test(inner)) errors.push(`Section "${key}" contains another edit marker. Sections cannot nest.`);
    if (/\{\{/.test(inner)) errors.push(`Section "${key}" contains a Handlebars tag. Keep merge tags outside edit markers so the agent cannot remove them.`);

    let original: string | string[];
    if (kind === "paragraphs") {
      const { bodies } = paragraphsOf(inner);
      if (bodies.length === 0) errors.push(`Section "${key}" is marked paragraphs but holds no <p> elements.`);
      original = bodies.map(simplifyRich);
    } else if (kind === "rich") {
      original = simplifyRich(inner);
    } else {
      original = visibleText(inner);
    }

    const existing = byKey.get(key);
    if (existing) {
      if (existing.kind !== kind) errors.push(`Section "${key}" is marked both ${existing.kind} and ${kind}.`);
      existing.occurrences += 1;
      continue;
    }
    byKey.set(key, { key, group: groupOf(key), kind, original, occurrences: 1 });
  }

  if (byKey.size === 0 && errors.length === 0) {
    errors.push("No edit markers found. Wrap each editable piece in <!--edit:key text-->…<!--/edit:key--> (kinds: text, rich, paragraphs).");
  }

  return { sections: [...byKey.values()], errors };
}

/** Distinct groups in a template, in document order. */
export function templateGroups(parsed: ParsedTemplate): string[] {
  return [...new Set(parsed.sections.map((s) => s.group))];
}

// ─── Rendering ──────────────────────────────────────────────────────────────

const SAFE_HREF = /^(https:\/\/|http:\/\/|mailto:|tel:)/i;

/**
 * Model-written inline text back into HTML. Only strong/em/a/br survive, and
 * strong/a take the master's own opening tag so the inline styles stay as
 * designed. Everything else is text, escaped.
 */
export function renderRich(value: string, masterInner: string): string {
  const strongTag = /<(?:strong|b)\b[^>]*>/i.exec(masterInner)?.[0] ?? "<strong>";
  const emTag = /<(?:em|i)\b[^>]*>/i.exec(masterInner)?.[0] ?? "<em>";
  const anchorTag = /<a\b[^>]*>/i.exec(masterInner)?.[0];
  const anchorAttrs = anchorTag ? anchorTag.replace(/^<a\b/i, "").replace(/>$/, "").replace(/\s*href\s*=\s*"[^"]*"/i, "") : "";

  let out = "";
  let last = 0;
  let openAnchors = 0;
  for (const m of value.matchAll(/<\/?([a-z]+)\b([^>]*)>/gi)) {
    out += escapeText(decodeEntities(value.slice(last, m.index)));
    last = m.index! + m[0].length;
    const name = m[1]!.toLowerCase();
    const closing = m[0].startsWith("</");
    if (name === "strong" || name === "b") out += closing ? "</strong>" : strongTag;
    else if (name === "em" || name === "i") out += closing ? "</em>" : emTag;
    else if (name === "br") out += "<br>";
    else if (name === "a") {
      if (closing) {
        if (openAnchors > 0) {
          out += "</a>";
          openAnchors -= 1;
        }
      } else {
        const href = decodeEntities(/href\s*=\s*"([^"]*)"/i.exec(m[2] ?? "")?.[1] ?? "").trim();
        // A link with an unsafe or missing href becomes plain text, not a dead anchor.
        if (SAFE_HREF.test(href)) {
          out += `<a href="${escapeAttr(href)}"${anchorAttrs}>`;
          openAnchors += 1;
        }
      }
    }
  }
  out += escapeText(decodeEntities(value.slice(last)));
  return out + "</a>".repeat(openAnchors);
}

/**
 * A `text` marker may wrap one whole element, `<!--edit:title text--><title>…</title><!--/edit:title-->`,
 * because a comment INSIDE <title> renders as literal text. Then only the element's text is replaced.
 */
const WRAPPED_RE = /^(\s*<([a-z0-9]+)\b[^>]*>)([^<]*)(<\/\2>\s*)$/i;

function renderSection(kind: SectionKind, value: string | string[], masterInner: string): string {
  if (kind === "text") {
    const text = escapeText(collapse(decodeEntities((Array.isArray(value) ? value.join(" ") : value).replace(/<[^>]+>/g, " "))));
    const wrapped = WRAPPED_RE.exec(masterInner);
    if (wrapped) return `${wrapped[1]}${text}${wrapped[4]}`;
    const lead = /^\s*/.exec(masterInner)![0];
    const trail = /\s*$/.exec(masterInner)![0];
    return `${lead}${text}${trail}`;
  }
  if (kind === "rich") {
    const lead = /^\s*/.exec(masterInner)![0];
    const trail = /\s*$/.exec(masterInner)![0];
    return `${lead}${renderRich(collapse(Array.isArray(value) ? value.join(" ") : value), masterInner)}${trail}`;
  }

  const paragraphs = (Array.isArray(value) ? value : [value]).map((p) => p.trim()).filter(Boolean);
  const { tags } = paragraphsOf(masterInner);
  const firstTag = tags[0] ?? "<p>";
  const lastTag = tags[tags.length - 1] ?? firstTag;
  const indent = /\n([ \t]*)<p\b/.exec(masterInner)?.[1] ?? "";
  const body = paragraphs
    .map((p, i) => `${i === paragraphs.length - 1 ? lastTag : firstTag}${renderRich(p, masterInner)}</p>`)
    .join(`\n${indent}`);
  return `\n${indent}${body}\n${/\n([ \t]*)$/.exec(masterInner)?.[1] ?? ""}`;
}

/**
 * The master with each edited section replaced. Keys absent from `values` keep
 * the master's copy untouched, markers included, so a locked section renders
 * exactly as designed.
 */
export function renderTemplate(html: string, values: SectionValues): string {
  return html.replace(REGION_RE, (whole, rawKey: string, rawKind: string, inner: string) => {
    const key = rawKey.toLowerCase();
    const value = values[key];
    if (value === undefined) return whole;
    const open = whole.slice(0, whole.indexOf("-->") + 3);
    const close = whole.slice(whole.lastIndexOf("<!--"));
    return `${open}${renderSection(rawKind.toLowerCase() as SectionKind, value, inner)}${close}`;
  });
}

/**
 * The template with every marked region collapsed to a placeholder: what must
 * be identical between the master and any email made from it.
 */
export function lockedSkeleton(html: string): string {
  return html.replace(REGION_RE, (_whole, key: string) => `<!--edit:${key.toLowerCase()}-->`);
}

/** The current inner HTML of one section, first occurrence. */
export function sectionInner(html: string, key: string): string | null {
  for (const m of html.matchAll(REGION_RE)) if (m[1]!.toLowerCase() === key) return m[3]!;
  return null;
}

// ─── Unsubscribe ────────────────────────────────────────────────────────────

export const SENDGRID_UNSUBSCRIBE = "{{{unsubscribe}}}";
export const SENDGRID_PREFERENCES = "{{{unsubscribe_preferences}}}";

/**
 * Swap placeholder unsubscribe links for SendGrid's code-editor tags. Matches
 * SendGrid's own module classes (Unsubscribe--unsubscribeLink /
 * Unsubscribe--unsubscribePreferences) and, failing those, an anchor whose
 * text is "Unsubscribe" or "…Preferences". Only `href="#"` or an empty href is
 * replaced; a real URL someone put there on purpose is left alone.
 */
export function swapUnsubscribeLinks(html: string): string {
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, attrs: string, inner: string) => {
    const href = /href\s*=\s*"([^"]*)"/i.exec(attrs);
    if (!href || (href[1] !== "#" && href[1] !== "")) return whole;
    const text = visibleText(inner).toLowerCase();
    const isPrefs = /unsubscribe--unsubscribepreferences/i.test(attrs) || /unsubscribe preferences|email preferences|manage preferences/.test(text);
    const isUnsub = !isPrefs && (/unsubscribe--unsubscribelink/i.test(attrs) || text === "unsubscribe");
    if (!isPrefs && !isUnsub) return whole;
    const tag = isPrefs ? SENDGRID_PREFERENCES : SENDGRID_UNSUBSCRIBE;
    return whole.replace(href[0], `href="${tag}"`);
  });
}

/** Every href in the document, in order, entities decoded. */
export function hrefsOf(html: string): string[] {
  return [...html.matchAll(/<(?:a|v:roundrect)\b[^>]*\bhref\s*=\s*"([^"]*)"/gi)].map((m) => decodeEntities(m[1]!));
}

/** Handlebars tags in document order: `{{first_name}}`, `{{#if …}}`, `{{{unsubscribe}}}`. */
export function handlebarsTags(html: string): string[] {
  return [...html.matchAll(/\{\{\{?[^{}]*\}?\}\}/g)].map((m) => m[0]);
}

/** Hidden preheader text, if the template marks one with key "preheader". */
export function preheaderOf(values: SectionValues, parsed: ParsedTemplate): string {
  const v = values.preheader ?? parsed.sections.find((s) => s.key === "preheader")?.original;
  return typeof v === "string" ? v : "";
}

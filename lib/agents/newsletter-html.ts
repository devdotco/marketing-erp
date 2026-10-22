/**
 * The newsletter's email-safe HTML, built in code.
 *
 * The model used to return JSON with loose <p> fragments while the Run form
 * promised "the HTML structure and import file format". Nothing could be pasted
 * into Mailchimp. This module assembles a complete document — table layout,
 * inline styles, 600px, no external CSS — from the structured issue, and is
 * pure so it can be tested without a run.
 */

export type EspName = "Mailchimp" | "Klaviyo";

export interface EspMergeTags {
  unsubscribe: string;
  address: string;
}

const MERGE_TAGS: Record<EspName, EspMergeTags> = {
  Mailchimp: { unsubscribe: "*|UNSUB|*", address: "*|LIST:ADDRESSLINE|*" },
  Klaviyo: { unsubscribe: "{% unsubscribe_url %}", address: "{{ organization.full_address }}" },
};

/** Anything that is not Klaviyo gets Mailchimp's tags (the Run form offers only those two). */
export function espMergeTags(espTarget: string): EspMergeTags {
  return MERGE_TAGS[/klaviyo/i.test(espTarget) ? "Klaviyo" : "Mailchimp"];
}

export const UNSUBSCRIBE_PLACEHOLDER = "[[UNSUBSCRIBE_URL]]";

export function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape text that may already contain entities (&amp;, &#39;) without doubling them. */
function escapeLoose(text: string): string {
  return text
    .replace(/&(?!(?:[a-zA-Z]{2,8}|#\d{1,6}|#x[0-9a-fA-F]{1,6});)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Only http(s) and mailto may be linked. Rejects javascript:, data:, and the like. */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : null;
}

const P_STYLE = "margin:0 0 16px 0;font-size:16px;line-height:1.6;color:#222222;";
const A_STYLE = "color:#1a56db;text-decoration:underline;";
const LIST_STYLE = "margin:0 0 16px 0;padding-left:24px;font-size:16px;line-height:1.6;color:#222222;";

const TAG_STYLE: Record<string, string> = { p: P_STYLE, ul: LIST_STYLE, ol: LIST_STYLE, li: "margin:0 0 6px 0;" };
const ALLOWED = new Set(["p", "a", "strong", "em", "ul", "ol", "li"]);
const ALIASES: Record<string, string> = { b: "strong", i: "em" };

/**
 * Reduce model-written story HTML to <p>, <a href>, <strong>, <em>, <ul>, <ol>
 * and <li>. Everything else loses its tag but keeps its (escaped) text, except
 * <script>, <style> and comments, which are removed with their contents.
 * Attributes are discarded; the only one re-added is a vetted href. Plain text
 * with no tags becomes paragraphs.
 */
export function sanitizeBodyHtml(input: string): string {
  let html = String(input ?? "");
  html = html.replace(/<!--[\s\S]*?-->/g, "");
  html = html.replace(/<(script|style|iframe|object|embed|noscript)\b[\s\S]*?<\/\1\s*>/gi, "");
  html = html.replace(/<(script|style|iframe|object|embed|noscript)\b[\s\S]*$/gi, "");

  if (!/<\s*(p|ul|ol)\b/i.test(html)) {
    // Plain text or inline-only markup: break on blank lines into paragraphs.
    const parts = html.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    html = parts.map((s) => `<p>${s}</p>`).join("");
  }

  const out: string[] = [];
  const open: string[] = [];
  let last = 0;
  const tagRe = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    out.push(escapeLoose(html.slice(last, m.index)));
    last = m.index + m[0].length;
    const closing = m[1] === "/";
    let name = m[2].toLowerCase();
    name = ALIASES[name] ?? name;
    if (!ALLOWED.has(name)) continue;
    if (closing) {
      const at = open.lastIndexOf(name);
      if (at === -1) continue;
      while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }
    if (name === "a") {
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[3]);
      const url = safeUrl(href ? (href[1] ?? href[2] ?? href[3] ?? "").replace(/&amp;/g, "&") : null);
      if (!url) continue; // an anchor with no safe target is just its text
      out.push(`<a href="${escapeHtml(url)}" style="${A_STYLE}">`);
    } else {
      const style = TAG_STYLE[name];
      out.push(style ? `<${name} style="${style}">` : `<${name}>`);
    }
    open.push(name);
  }
  out.push(escapeLoose(html.slice(last)));
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join("").replace(/<p style="[^"]*"><\/p>/g, "");
}

export interface NewsletterStory {
  headline: string;
  summary?: string;
  body: string;
  sourceUrl: string | null;
  sourceName?: string;
  publishedDate?: string;
  internal?: boolean;
  readTime?: number;
}

export interface NewsletterIssue {
  newsletterName: string;
  issueNumber: number | null;
  previewText?: string;
  editorialNote: string;
  stories: NewsletterStory[];
  cta?: { headline?: string; body?: string; buttonText?: string; url?: string | null };
  footer?: string;
  espTarget: string;
}

function paragraphsOf(text: string): string {
  const parts = String(text ?? "").split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  return parts.map((p) => `<p style="${P_STYLE}">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
}

/** Replace the footer placeholder with the ESP's unsubscribe tag. Exported for the JSON `footer` field. */
export function resolveFooterText(footer: string, espTarget: string): string {
  return String(footer ?? "").split(UNSUBSCRIBE_PLACEHOLDER).join(espMergeTags(espTarget).unsubscribe);
}

const INVENTED_REPORTING =
  /\b(we (?:spoke|talked|have spoken|interviewed|surveyed|asked)\b|(?:marketers|advertisers|editors|leaders|users|customers|experts|readers) (?:we|who we) (?:spoke|talked|interviewed|surveyed|asked)|early[- ]access (?:advertisers|users|customers|testers)|people (?:we|familiar with))/i;

/** A sentence that claims first-hand reporting the model cannot have done. */
export function findInventedReporting(text: string): string | null {
  const m = INVENTED_REPORTING.exec(text);
  return m ? m[0] : null;
}

/** A complete, email-safe HTML document for the issue. */
export function buildNewsletterHtml(issue: NewsletterIssue): string {
  const tags = espMergeTags(issue.espTarget);
  const name = escapeHtml(issue.newsletterName);
  const issueLabel = issue.issueNumber ? `Issue ${issue.issueNumber}` : "";

  const storyRows = issue.stories
    .map((s) => {
      const url = safeUrl(s.sourceUrl);
      const sourceLabel = s.sourceName ? `Read at ${escapeHtml(s.sourceName)}` : "Read the source";
      const meta = s.internal
        ? `<p style="margin:0 0 8px 0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#6b7280;">From us</p>`
        : s.publishedDate
          ? `<p style="margin:0 0 8px 0;font-size:12px;color:#6b7280;">${escapeHtml(s.sourceName ?? "")}${s.sourceName ? " &middot; " : ""}${escapeHtml(s.publishedDate)}</p>`
          : "";
      const link = url
        ? `<p style="margin:0;font-size:14px;"><a href="${escapeHtml(url)}" style="${A_STYLE}">${sourceLabel} &rarr;</a></p>`
        : "";
      return `<tr><td style="padding:24px 32px;border-top:1px solid #e5e7eb;">
${meta}<h2 style="margin:0 0 12px 0;font-size:20px;line-height:1.3;color:#111111;">${escapeHtml(s.headline)}</h2>
${sanitizeBodyHtml(s.body)}${link}
</td></tr>`;
    })
    .join("\n");

  const ctaUrl = safeUrl(issue.cta?.url);
  const ctaBlock =
    issue.cta && (issue.cta.headline || issue.cta.buttonText)
      ? `<tr><td style="padding:32px;background-color:#f3f4f6;text-align:center;">
${issue.cta.headline ? `<h2 style="margin:0 0 12px 0;font-size:20px;color:#111111;">${escapeHtml(issue.cta.headline)}</h2>` : ""}
${issue.cta.body ? `<p style="margin:0 0 20px 0;font-size:16px;line-height:1.6;color:#222222;">${escapeHtml(issue.cta.body)}</p>` : ""}
${
  issue.cta.buttonText && ctaUrl
    ? `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td style="background-color:#1a56db;border-radius:6px;"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:12px 24px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;">${escapeHtml(issue.cta.buttonText)}</a></td></tr></table>`
    : ""
}
</td></tr>`
      : "";

  // The footer text may carry the placeholder; it becomes a real link to the ESP tag.
  const footerParts = String(issue.footer ?? "").split(UNSUBSCRIBE_PLACEHOLDER);
  const unsubLink = `<a href="${tags.unsubscribe}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a>`;
  const footerText = footerParts.map((p) => escapeHtml(p)).join(unsubLink);
  const footerHasUnsub = footerParts.length > 1;

  const preview = issue.previewText
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(issue.previewText)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}${issueLabel ? ` - ${issueLabel}` : ""}</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
${preview}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f4f6;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;">
<tr><td style="padding:28px 32px;background-color:#111827;">
<h1 style="margin:0;font-size:26px;line-height:1.2;color:#ffffff;">${name}</h1>
${issueLabel ? `<p style="margin:6px 0 0 0;font-size:13px;color:#d1d5db;">${escapeHtml(issueLabel)}</p>` : ""}
</td></tr>
<tr><td style="padding:28px 32px;">
${paragraphsOf(issue.editorialNote)}
</td></tr>
${storyRows}
${ctaBlock}
<tr><td style="padding:24px 32px;font-size:12px;line-height:1.5;color:#6b7280;">
<p style="margin:0 0 8px 0;">${footerText}</p>
${footerHasUnsub ? "" : `<p style="margin:0 0 8px 0;">${unsubLink}</p>`}
<p style="margin:0;">${tags.address}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** Match a search-result URL loosely: scheme, www, fragment and trailing slash do not matter. */
export function urlKey(url: string): string {
  return String(url ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "");
}

export interface CandidateStory {
  headline: string;
  sourceUrl?: string | null;
}

/**
 * Keep only external stories whose URL a web search actually returned. The kept
 * story's sourceUrl is replaced by the search result's own string (verbatim).
 */
export function verifyStories<T extends CandidateStory>(
  candidates: T[],
  returnedUrls: Iterable<string>,
): { kept: T[]; warnings: string[] } {
  const byKey = new Map<string, string>();
  for (const u of returnedUrls) byKey.set(urlKey(u), u);
  const kept: T[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = c?.sourceUrl ? urlKey(c.sourceUrl) : "";
    const real = key ? byKey.get(key) : undefined;
    if (!real) {
      warnings.push(
        `Dropped "${c?.headline ?? "untitled"}": its sourceUrl (${c?.sourceUrl ?? "none"}) was not returned by the web search.`,
      );
      continue;
    }
    if (seen.has(key)) {
      warnings.push(`Dropped "${c.headline}": duplicate of another story's source.`);
      continue;
    }
    seen.add(key);
    kept.push({ ...c, sourceUrl: real });
  }
  return { kept, warnings };
}

/** "older" when a parseable date is outside the window, "unknown" when it cannot be read. */
export function lookbackStatus(
  publishedDate: string | undefined,
  days: number,
  now = new Date(),
): "ok" | "older" | "unknown" {
  const t = publishedDate ? Date.parse(publishedDate) : NaN;
  if (!Number.isFinite(t)) return "unknown";
  return now.getTime() - t > days * 86_400_000 + 86_400_000 ? "older" : "ok";
}

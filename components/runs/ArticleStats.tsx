/**
 * The at-a-glance panel beside a Blog Writer draft: is it long enough, did the
 * requested links make it in, is the keyword where it should be. A reviewer used
 * to have to read the whole preview to answer any of those — and links weren't
 * even visible in it — so drafts got approved (or doubted) on a guess.
 *
 * Pure server component: everything is computed from the run's own output and
 * input, no fetches.
 */

type LinkRow = { anchor: string; url: string };
type Citation = { url?: string; usedInArticle?: boolean };

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

function textOf(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hostOf(url: string): string | null {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Same site if one host is the other or a subdomain of it (app.vdr.ai belongs to vdr.ai). */
function sameSite(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function lines(value: unknown): string[] {
  return typeof value === "string" ? value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) : [];
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (haystack.match(new RegExp(`\\b${escaped}\\b`, "gi")) ?? []).length;
}

export function ArticleStats({ output, input }: { output: Record<string, unknown>; input: Record<string, unknown> | null }) {
  const html = String(output.content ?? "");
  const text = textOf(html);
  const words = typeof output.wordCount === "number" ? output.wordCount : (text.match(WORD) ?? []).length;
  const target = Number(input?.wordCount) || null;
  const readMinutes = typeof output.estimatedReadMinutes === "number" ? output.estimatedReadMinutes : Math.max(1, Math.round(words / 230));
  const outline = Array.isArray(output.outline) ? (output.outline as Array<{ heading: string; words: number }>) : [];
  const paragraphs = (html.match(/<p[\s>]/gi) ?? []).length;
  const images = (html.match(/<img[\s>]/gi) ?? []).length;
  const tables = (html.match(/<table[\s>]/gi) ?? []).length;

  // Links, classified against what the brief called "ours": its internal link
  // targets and its CTA. The QC counter treated the CTA as external, which is
  // how "4 external links vs 3" appeared on a draft that had exactly 3 sources.
  const ownHosts = [...lines(input?.internalLinkTargets), String(input?.ctaUrl ?? "")]
    .map(hostOf)
    .filter((h): h is string => Boolean(h));
  const links = Array.isArray(output.links) ? (output.links as LinkRow[]).filter((l) => l?.url) : [];
  const internal = links.filter((l) => {
    const h = hostOf(l.url);
    return h ? ownHosts.some((own) => sameSite(h, own)) : false;
  });
  const external = links.filter((l) => !internal.includes(l));
  const requestedTargets = lines(input?.internalLinkTargets);
  const missingTargets = requestedTargets.filter((t) => {
    const h = hostOf(t);
    return !links.some((l) => l.url.replace(/\/+$/, "") === t.replace(/\/+$/, "") || (h && hostOf(l.url) === h));
  });
  const ctaUrl = typeof input?.ctaUrl === "string" ? input.ctaUrl.trim() : "";
  const ctaPresent = ctaUrl ? links.some((l) => l.url.replace(/\/+$/, "") === ctaUrl.replace(/\/+$/, "")) : null;
  const requestedExternal = Number(input?.externalLinkCount);

  // Keyword placement.
  const keyword = String(output.focusKeyword ?? input?.targetKeyword ?? "").trim();
  const title = String(output.title ?? "");
  const meta = String(output.metaDescription ?? "");
  const first100 = (text.match(WORD) ?? []).slice(0, 100).join(" ");
  const occurrences = countOccurrences(text, keyword);
  const density = words ? (occurrences / words) * 100 : 0;
  const headingsWithKeyword = outline.filter((s) => countOccurrences(s.heading, keyword) > 0).length;

  const citations = Array.isArray(output.citations) ? (output.citations as Citation[]) : [];
  const citationsUsed = citations.filter((c) => c.usedInArticle).length;

  const quality = output.qualityReport as { pass?: boolean; defects?: string[]; repairRounds?: number } | undefined;

  const lengthOk = target ? words >= target : null;

  return (
    <div className="card article-stats">
      <h3 className="article-stats__title">Article stats</h3>

      <Section label="Length">
        <Row name="Words" value={words.toLocaleString()} note={target ? `target ${target.toLocaleString()}` : undefined} state={lengthOk === null ? undefined : lengthOk ? "ok" : "bad"} />
        {target && !lengthOk && <p className="article-stats__warn">{(target - words).toLocaleString()} words short of the brief</p>}
        <Row name="Reading time" value={`${readMinutes} min`} />
        <Row name="Sections" value={String(outline.length)} />
        <Row name="Paragraphs" value={String(paragraphs)} />
      </Section>

      <Section label="Links">
        <Row name="Internal" value={String(internal.length)} state={missingTargets.length ? "bad" : internal.length ? "ok" : undefined} />
        {missingTargets.map((t) => (
          <p key={t} className="article-stats__warn">Missing: {t}</p>
        ))}
        <Row
          name="External"
          value={String(external.length)}
          note={Number.isFinite(requestedExternal) && requestedExternal > 0 ? `requested ${requestedExternal}` : undefined}
          state={Number.isFinite(requestedExternal) && requestedExternal > 0 ? (external.length === requestedExternal ? "ok" : "warn") : undefined}
        />
        {ctaPresent !== null && <Row name="Call to action" value={ctaPresent ? "Linked" : "Missing"} state={ctaPresent ? "ok" : "bad"} />}
        {links.length > 0 && (
          <details className="article-stats__details">
            <summary>All {links.length} links</summary>
            <ul>
              {links.map((l, i) => (
                <li key={`${l.url}-${i}`}>
                  <span className={`article-stats__tag ${internal.includes(l) ? "is-internal" : ""}`}>{internal.includes(l) ? "int" : "ext"}</span>
                  <a href={l.url} target="_blank" rel="noopener noreferrer">{l.anchor || l.url}</a>
                  <span className="article-stats__url">{hostOf(l.url)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Section>

      {keyword && (
        <Section label={`Keyword · “${keyword}”`}>
          <Row name="In title" value={countOccurrences(title, keyword) ? "Yes" : "No"} state={countOccurrences(title, keyword) ? "ok" : "warn"} />
          <Row name="In first 100 words" value={countOccurrences(first100, keyword) ? "Yes" : "No"} state={countOccurrences(first100, keyword) ? "ok" : "warn"} />
          <Row name="In meta description" value={countOccurrences(meta, keyword) ? "Yes" : "No"} state={countOccurrences(meta, keyword) ? "ok" : "warn"} />
          <Row name="In headings" value={`${headingsWithKeyword} of ${outline.length}`} />
          <Row name="Uses" value={`${occurrences} (${density.toFixed(2)}%)`} />
        </Section>
      )}

      <Section label="SEO">
        <Row name="Title length" value={`${title.length} chars`} state={title.length >= 30 && title.length <= 65 ? "ok" : "warn"} />
        <Row name="Meta description" value={`${meta.length} chars`} state={meta.length >= 120 && meta.length <= 160 ? "ok" : "warn"} />
      </Section>

      <Section label="Sources & visuals">
        <Row name="Sources verified" value={String(citations.length)} />
        <Row name="Cited in article" value={String(citationsUsed)} />
        <Row name="Images" value={String(images)} state={images ? undefined : "warn"} />
        <Row name="Tables" value={String(tables)} />
      </Section>

      {quality && (
        <Section label="Quality">
          <Row name="Checks" value={quality.pass ? "Passed" : `${quality.defects?.length ?? 0} to review`} state={quality.pass ? "ok" : "warn"} />
          <Row name="Repair rounds" value={String(quality.repairRounds ?? 0)} />
        </Section>
      )}

      {outline.length > 0 && (
        <details className="article-stats__details">
          <summary>Outline</summary>
          <ol>
            {outline.map((s, i) => (
              <li key={i}>
                {s.heading} <span className="article-stats__url">{s.words} words</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="article-stats__section">
      <p className="article-stats__label">{label}</p>
      {children}
    </div>
  );
}

function Row({ name, value, note, state }: { name: string; value: string; note?: string; state?: "ok" | "warn" | "bad" }) {
  return (
    <div className="article-stats__row">
      <span>{name}</span>
      <span className={`article-stats__value ${state ? `is-${state}` : ""}`}>
        {value}
        {note && <span className="article-stats__note"> · {note}</span>}
      </span>
    </div>
  );
}

/**
 * The pages a campaign reads for facts before writing ("nothing invented":
 * every offer, stat and outlet in the email must be on one of these, read
 * during the same run).
 *
 * Server-side fetch of customer-typed URLs, so the same SSRF guard as the
 * WordPress connector: public addresses only, and no redirects (a public host
 * must not 30x us somewhere private). A page that fails is reported, not
 * fatal; the handler decides what a run with no readable pages may change.
 */
import { assertPublicUrl } from "@/lib/integrations/public-url";
import { visibleText } from "./template";

export interface SourcePage {
  url: string;
  ok: boolean;
  text: string;
  error?: string;
}

const MAX_CHARS = 14_000;

export function pageText(html: string): string {
  const main = /<main\b[\s\S]*?<\/main>/i.exec(html)?.[0] ?? html;
  return visibleText(
    main
      .replace(/<(nav|footer|header|svg|noscript|form)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/li|\/h[1-6]|\/tr|\/div)\b[^>]*>/gi, "$&\n"),
  ).slice(0, MAX_CHARS);
}

export async function readSourcePages(urls: string[]): Promise<SourcePage[]> {
  return Promise.all(
    urls.map(async (url): Promise<SourcePage> => {
      try {
        await assertPublicUrl(url);
        const res = await fetch(url, {
          redirect: "error",
          headers: { "user-agent": "marketing.erp.io email agent (+https://app.erp.io/marketing)", accept: "text/html" },
          signal: AbortSignal.timeout(15_000),
          cache: "no-store",
        });
        if (!res.ok) return { url, ok: false, text: "", error: `HTTP ${res.status}` };
        const text = pageText(await res.text());
        if (text.length < 200) return { url, ok: false, text, error: "the page had almost no readable text" };
        return { url, ok: true, text };
      } catch (err) {
        return { url, ok: false, text: "", error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}

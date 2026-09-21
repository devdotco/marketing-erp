/**
 * Which AI surface sent a human here.
 *
 * The other half of the question crawler data raises. Crawl counts say an
 * engine read the page; referrals say a person acted on the answer. Only the
 * second one is worth money, and it is the figure Profound's own Google
 * Analytics integration exists to produce.
 *
 * Read from the request Referer, which is what a Cloudflare log line carries.
 * That makes it independent of any JavaScript tag — a visitor with an ad
 * blocker still shows up, and there is nothing for a consent banner to
 * suppress.
 *
 * A caveat worth stating where people will read it: some assistants strip or
 * omit the referrer, and a native app has no referrer at all. So this
 * undercounts and must never be presented as a total. It is directional, and
 * the UI says so.
 */

export interface AiReferrer {
  /** Stable key and display label. */
  key: string;
  /** Hostnames that mean this surface. Matched on exact host or subdomain. */
  hosts: string[];
}

export const AI_REFERRERS: AiReferrer[] = [
  { key: "ChatGPT", hosts: ["chatgpt.com", "chat.openai.com", "openai.com"] },
  { key: "Perplexity", hosts: ["perplexity.ai"] },
  { key: "Claude", hosts: ["claude.ai"] },
  { key: "Gemini", hosts: ["gemini.google.com", "bard.google.com"] },
  { key: "Copilot", hosts: ["copilot.microsoft.com", "bing.com"] },
  { key: "Grok", hosts: ["grok.com", "x.ai"] },
  { key: "DeepSeek", hosts: ["deepseek.com"] },
  { key: "Meta AI", hosts: ["meta.ai"] },
  { key: "You.com", hosts: ["you.com"] },
  { key: "Poe", hosts: ["poe.com"] },
];

/**
 * The AI surface a referrer URL belongs to, or null for everything else.
 *
 * Subdomain-aware but not suffix-naive: "notbing.com" must not match "bing.com",
 * so a host qualifies only when it equals the entry or ends with a dot followed
 * by it.
 */
export function identifyReferrer(referer: string): AiReferrer | null {
  if (!referer) return null;
  let host: string;
  try {
    host = new URL(referer).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  for (const entry of AI_REFERRERS) {
    if (entry.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return entry;
  }
  return null;
}

/**
 * Which AI crawler made a request, and whether that claim can be checked.
 *
 * Two things this file is careful about, because getting either wrong produces
 * a confident number that is wrong:
 *
 * 1. A user agent is a claim, not an identity. Anyone can send
 *    "GPTBot/1.0". Every entry therefore declares HOW it can be verified, and
 *    a hit is only ever counted as verified when that check actually ran and
 *    passed. Everything else is counted, and reported, as unverified.
 *
 *    Every operator that publishes anything to check against is wired to it.
 *    Seven do — OpenAI, Anthropic, Perplexity, Google, Microsoft and Apple —
 *    covering 12 of the 19 crawlers here, including every one that matters for
 *    AI answers. `npm run check:crawler-ranges` fetches each feed and fails if
 *    one stops parsing, so a silently-dead URL cannot quietly turn verified
 *    traffic into unverified traffic.
 *
 *    Published ranges are preferred over reverse DNS wherever both exist.
 *    rDNS needs two DNS round trips per address inside a log ingest; a range
 *    list is one cached fetch per six hours and then pure arithmetic.
 *
 * 2. Some well-known AI names are robots.txt TOKENS, not user agents.
 *    `Google-Extended` and `Applebot-Extended` never appear in a request —
 *    they exist only so a site can opt out of AI training in robots.txt, while
 *    the actual fetching is done by Googlebot and Applebot. Listing them as
 *    crawlers would produce a permanently empty row that looks like nobody is
 *    crawling you, which is worse than not showing the row at all.
 */

export type BotPurpose =
  /** Collects pages to train on. */
  | "training"
  /** Builds the index an assistant searches. */
  | "search"
  /** Fetches a page because a user asked about it, right now. */
  | "user";

export type Verification =
  /**
   * The operator publishes its IP ranges as JSON.
   *
   * `rdnsSuffixes` is a documented fallback, used only when the feed cannot be
   * fetched. Without it, an outage at Google would turn a day of genuinely
   * verified crawling into a day of "unverified" — a drop in the one number on
   * the page that is supposed to mean something, caused by their CDN rather
   * than by anything about this site.
   */
  | { method: "ip-ranges"; url: string; rdnsSuffixes?: string[] }
  /** Reverse DNS resolves into a domain the operator controls. */
  | { method: "reverse-dns"; suffixes: string[] }
  /** The operator publishes nothing. The claim cannot be checked. */
  | { method: "none" };

export interface AiCrawler {
  /** Stable key, used as the Observation subject and the display label. */
  key: string;
  operator: string;
  purpose: BotPurpose;
  /** Matched case-insensitively against the user agent. */
  token: string;
  verification: Verification;
}

/**
 * Ordered most specific first. "ChatGPT-User" must be tested before "GPT",
 * and "Claude-SearchBot" before "ClaudeBot", or the broader token swallows
 * the narrower one and three distinct behaviours collapse into one row.
 */
/** Anthropic publishes one feed covering ClaudeBot, Claude-User and Claude-SearchBot. */
const ANTHROPIC_BOTS = "https://claude.com/crawling/bots.json";

export const AI_CRAWLERS: AiCrawler[] = [
  // ── OpenAI: three agents, three quite different meanings ──────────────────
  { key: "ChatGPT-User", operator: "OpenAI", purpose: "user", token: "ChatGPT-User",
    verification: { method: "ip-ranges", url: "https://openai.com/chatgpt-user.json" } },
  { key: "OAI-SearchBot", operator: "OpenAI", purpose: "search", token: "OAI-SearchBot",
    verification: { method: "ip-ranges", url: "https://openai.com/searchbot.json" } },
  { key: "GPTBot", operator: "OpenAI", purpose: "training", token: "GPTBot",
    verification: { method: "ip-ranges", url: "https://openai.com/gptbot.json" } },

  // ── Anthropic ─────────────────────────────────────────────────────────────
  // All three Anthropic bots share one published feed.
  { key: "Claude-User", operator: "Anthropic", purpose: "user", token: "Claude-User",
    verification: { method: "ip-ranges", url: ANTHROPIC_BOTS } },
  { key: "Claude-SearchBot", operator: "Anthropic", purpose: "search", token: "Claude-SearchBot",
    verification: { method: "ip-ranges", url: ANTHROPIC_BOTS } },
  { key: "ClaudeBot", operator: "Anthropic", purpose: "training", token: "ClaudeBot",
    verification: { method: "ip-ranges", url: ANTHROPIC_BOTS } },

  // ── Perplexity ────────────────────────────────────────────────────────────
  { key: "Perplexity-User", operator: "Perplexity", purpose: "user", token: "Perplexity-User",
    verification: { method: "ip-ranges", url: "https://www.perplexity.ai/perplexity-user.json" } },
  { key: "PerplexityBot", operator: "Perplexity", purpose: "search", token: "PerplexityBot",
    verification: { method: "ip-ranges", url: "https://www.perplexity.ai/perplexitybot.json" } },

  // ── Google and Microsoft: reverse DNS is the published method ─────────────
  // Note: Google-Extended and Applebot-Extended are robots.txt tokens only and
  // are deliberately absent — see this file's header.
  // GoogleOther is in the special-crawlers feed, not the Googlebot one.
  { key: "GoogleOther", operator: "Google", purpose: "training", token: "GoogleOther",
    verification: { method: "ip-ranges", url: "https://developers.google.com/static/search/apis/ipranges/special-crawlers.json", rdnsSuffixes: [".googlebot.com", ".google.com"] } },
  { key: "Googlebot", operator: "Google", purpose: "search", token: "Googlebot",
    verification: { method: "ip-ranges", url: "https://developers.google.com/static/search/apis/ipranges/googlebot.json", rdnsSuffixes: [".googlebot.com", ".google.com"] } },
  { key: "Bingbot", operator: "Microsoft", purpose: "search", token: "bingbot",
    verification: { method: "ip-ranges", url: "https://www.bing.com/toolbox/bingbot.json", rdnsSuffixes: [".search.msn.com"] } },

  // ── Everyone else ─────────────────────────────────────────────────────────
  // These genuinely publish nothing to check against — each was checked, not
  // assumed. Their traffic is counted and reported as unverified, which is the
  // honest answer; claiming verification would be a lie and dropping them
  // would hide real crawling.
  { key: "Applebot", operator: "Apple", purpose: "search", token: "Applebot",
    verification: { method: "ip-ranges", url: "https://search.developer.apple.com/applebot.json", rdnsSuffixes: [".applebot.apple.com"] } },
  { key: "Amazonbot", operator: "Amazon", purpose: "search", token: "Amazonbot", verification: { method: "none" } },
  { key: "Meta-ExternalAgent", operator: "Meta", purpose: "training", token: "meta-externalagent", verification: { method: "none" } },
  { key: "Bytespider", operator: "ByteDance", purpose: "training", token: "Bytespider", verification: { method: "none" } },
  { key: "CCBot", operator: "Common Crawl", purpose: "training", token: "CCBot", verification: { method: "none" } },
  { key: "cohere-ai", operator: "Cohere", purpose: "training", token: "cohere-ai", verification: { method: "none" } },
  { key: "YouBot", operator: "You.com", purpose: "search", token: "YouBot", verification: { method: "none" } },
  { key: "Diffbot", operator: "Diffbot", purpose: "training", token: "Diffbot", verification: { method: "none" } },
];

const BY_KEY = new Map(AI_CRAWLERS.map((c) => [c.key, c]));

export function crawlerByKey(key: string): AiCrawler | undefined {
  return BY_KEY.get(key);
}

/**
 * The AI crawler a user agent claims to be, or null.
 *
 * Returns the first match in AI_CRAWLERS order, which is why that order is
 * most-specific-first.
 */
export function identifyCrawler(userAgent: string): AiCrawler | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  for (const crawler of AI_CRAWLERS) {
    if (ua.includes(crawler.token.toLowerCase())) return crawler;
  }
  return null;
}

/** Human-readable purpose, for the UI. */
export const PURPOSE_LABEL: Record<BotPurpose, string> = {
  training: "Training",
  search: "Search index",
  user: "Answering someone now",
};

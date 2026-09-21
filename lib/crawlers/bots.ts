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
  /** The operator publishes its IP ranges as JSON. */
  | { method: "ip-ranges"; url: string }
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
export const AI_CRAWLERS: AiCrawler[] = [
  // ── OpenAI: three agents, three quite different meanings ──────────────────
  { key: "ChatGPT-User", operator: "OpenAI", purpose: "user", token: "ChatGPT-User",
    verification: { method: "ip-ranges", url: "https://openai.com/chatgpt-user.json" } },
  { key: "OAI-SearchBot", operator: "OpenAI", purpose: "search", token: "OAI-SearchBot",
    verification: { method: "ip-ranges", url: "https://openai.com/searchbot.json" } },
  { key: "GPTBot", operator: "OpenAI", purpose: "training", token: "GPTBot",
    verification: { method: "ip-ranges", url: "https://openai.com/gptbot.json" } },

  // ── Anthropic ─────────────────────────────────────────────────────────────
  { key: "Claude-User", operator: "Anthropic", purpose: "user", token: "Claude-User", verification: { method: "none" } },
  { key: "Claude-SearchBot", operator: "Anthropic", purpose: "search", token: "Claude-SearchBot", verification: { method: "none" } },
  { key: "ClaudeBot", operator: "Anthropic", purpose: "training", token: "ClaudeBot", verification: { method: "none" } },

  // ── Perplexity ────────────────────────────────────────────────────────────
  { key: "Perplexity-User", operator: "Perplexity", purpose: "user", token: "Perplexity-User", verification: { method: "none" } },
  { key: "PerplexityBot", operator: "Perplexity", purpose: "search", token: "PerplexityBot", verification: { method: "none" } },

  // ── Google and Microsoft: reverse DNS is the published method ─────────────
  // Note: Google-Extended and Applebot-Extended are robots.txt tokens only and
  // are deliberately absent — see this file's header.
  { key: "GoogleOther", operator: "Google", purpose: "training", token: "GoogleOther",
    verification: { method: "reverse-dns", suffixes: [".googlebot.com", ".google.com"] } },
  { key: "Googlebot", operator: "Google", purpose: "search", token: "Googlebot",
    verification: { method: "reverse-dns", suffixes: [".googlebot.com", ".google.com"] } },
  { key: "Bingbot", operator: "Microsoft", purpose: "search", token: "bingbot",
    verification: { method: "reverse-dns", suffixes: [".search.msn.com"] } },

  // ── Everyone else ─────────────────────────────────────────────────────────
  { key: "Applebot", operator: "Apple", purpose: "search", token: "Applebot",
    verification: { method: "reverse-dns", suffixes: [".applebot.apple.com"] } },
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

/**
 * The pure half of crawler analytics: CIDR matching, bot and referrer
 * identification, and log-line normalisation. No network, no database.
 * Run with `npm run test:crawlers`.
 *
 * CIDR matching gets the most coverage because it is the thing standing behind
 * the word "verified" in the UI. A matcher that is quietly wrong tells a
 * customer a spoofed crawler is genuine, which is worse than not verifying at
 * all — an unverified count is honest, a wrong verified count is not.
 */
import { ipInCidr, ipInAny, parseCidr, parseIp } from "@/lib/crawlers/cidr";
import { identifyCrawler, AI_CRAWLERS } from "@/lib/crawlers/bots";
import { identifyReferrer } from "@/lib/crawlers/referrers";
import { dayOf, normalisePath, looksLikeAsset } from "@/lib/crawlers/ingest";

let failures = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!cond) failures += 1;
};

const cidr = (s: string) => {
  const c = parseCidr(s);
  if (!c) throw new Error(`bad cidr in test: ${s}`);
  return c;
};

// ── IPv4 ────────────────────────────────────────────────────────────────────
{
  const c = cidr("10.1.2.0/24");
  check("v4: an address inside the range matches", ipInCidr("10.1.2.3", c));
  check("v4: the network address matches", ipInCidr("10.1.2.0", c));
  check("v4: the broadcast address matches", ipInCidr("10.1.2.255", c));
  check("v4: the next range over does not match", !ipInCidr("10.1.3.0", c));

  // The regression a string-prefix matcher always fails.
  check("v4: 10.1.20.x is NOT inside 10.1.2.0/24", !ipInCidr("10.1.20.3", c), "10.1.20.3");

  check("v4: a non-byte-aligned prefix works", ipInCidr("192.168.1.130", cidr("192.168.1.128/25")));
  check("v4: and excludes the half below it", !ipInCidr("192.168.1.127", cidr("192.168.1.128/25")));
  check("v4: /32 matches exactly one address", ipInCidr("8.8.8.8", cidr("8.8.8.8/32")));
  check("v4: /32 excludes its neighbour", !ipInCidr("8.8.8.9", cidr("8.8.8.8/32")));
  check("v4: /0 matches everything", ipInCidr("1.2.3.4", cidr("0.0.0.0/0")));

  // A range written with host bits set still means its network.
  check("v4: 1.2.3.4/24 is normalised to 1.2.3.0/24", ipInCidr("1.2.3.99", cidr("1.2.3.4/24")));
}

// ── IPv6 ────────────────────────────────────────────────────────────────────
{
  const c = cidr("2600:1f18::/32");
  check("v6: an address inside the range matches", ipInCidr("2600:1f18:1234::1", c));
  check("v6: a different prefix does not match", !ipInCidr("2600:1f19::1", c));
  check("v6: compressed and expanded forms are the same address",
    parseIp("2001:db8::1")?.value === parseIp("2001:0db8:0000:0000:0000:0000:0000:0001")?.value);
  check("v6: a non-nibble-aligned prefix works", ipInCidr("2001:db8:8000::1", cidr("2001:db8:8000::/33")));
  check("v6: and excludes the half below it", !ipInCidr("2001:db8:7fff::1", cidr("2001:db8:8000::/33")));

  // Families must never cross.
  check("a v4 address is not inside a v6 range", !ipInCidr("1.2.3.4", cidr("2600:1f18::/32")));
  check("a v6 address is not inside a v4 range", !ipInCidr("2600:1f18::1", cidr("10.0.0.0/8")));

  // A dual-stack edge often hands over the mapped form.
  check("an IPv4-mapped v6 address matches the equivalent v4 range",
    ipInCidr("::ffff:10.1.2.3", cidr("10.1.2.0/24")), "::ffff:10.1.2.3");
}

// ── malformed input returns null rather than throwing or half-matching ──────
{
  check("rejects an octet above 255", parseIp("1.2.3.256") === null);
  check("rejects too few octets", parseIp("1.2.3") === null);
  check("rejects a leading zero, which is octal to some resolvers", parseIp("1.2.3.01") === null);
  check("rejects junk", parseIp("not an ip") === null);
  check("rejects a prefix above the family maximum", parseCidr("10.0.0.0/33") === null);
  check("rejects a v6 prefix above 128", parseCidr("2600::/129") === null);
  check("rejects two :: groups", parseIp("2001::db8::1") === null);
  check("a malformed ip never matches", !ipInCidr("garbage", cidr("0.0.0.0/0")));
  check("ipInAny is false against an empty list", !ipInAny("1.2.3.4", []));
}

// ── bot identification ──────────────────────────────────────────────────────
{
  check("identifies GPTBot", identifyCrawler("Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)")?.key === "GPTBot");
  check("identifies ClaudeBot", identifyCrawler("Mozilla/5.0 (compatible; ClaudeBot/1.0)")?.key === "ClaudeBot");
  check("a normal browser is not a crawler", identifyCrawler("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1") === null);
  check("an empty user agent is not a crawler", identifyCrawler("") === null);

  // Ordering: the specific token must win over the broader one, or three
  // distinct behaviours collapse into one row.
  check("ChatGPT-User beats GPTBot", identifyCrawler("Mozilla/5.0 ChatGPT-User/1.0")?.key === "ChatGPT-User");
  check("Claude-SearchBot beats ClaudeBot", identifyCrawler("Claude-SearchBot/1.0")?.key === "Claude-SearchBot");
  check("Perplexity-User beats PerplexityBot", identifyCrawler("Perplexity-User/1.0")?.key === "Perplexity-User");
  check("GoogleOther beats Googlebot", identifyCrawler("Mozilla/5.0 (compatible; GoogleOther)")?.key === "GoogleOther");

  // Robots.txt tokens are not user agents and must not be listed as crawlers.
  check("Google-Extended is not a crawler entry", !AI_CRAWLERS.some((c) => c.key === "Google-Extended"));
  check("Applebot-Extended is not a crawler entry", !AI_CRAWLERS.some((c) => c.key === "Applebot-Extended"));

  check("every crawler key is unique", new Set(AI_CRAWLERS.map((c) => c.key)).size === AI_CRAWLERS.length);
}

// ── referrer identification ─────────────────────────────────────────────────
{
  check("identifies ChatGPT", identifyReferrer("https://chatgpt.com/c/abc")?.key === "ChatGPT");
  check("identifies a subdomain", identifyReferrer("https://www.perplexity.ai/search?q=x")?.key === "Perplexity");
  check("an ordinary site is not an AI referrer", identifyReferrer("https://news.ycombinator.com/") === null);
  check("an empty referrer is not an AI referrer", identifyReferrer("") === null);
  check("junk does not throw", identifyReferrer("not a url") === null);

  // Suffix matching must not be naive.
  check("notbing.com is NOT Copilot", identifyReferrer("https://notbing.com/x") === null, "notbing.com");
}

// ── log line normalisation ──────────────────────────────────────────────────
{
  check("path drops the query string", normalisePath("/pricing?utm_source=x") === "/pricing");
  check("path drops a trailing slash", normalisePath("/blog/post/") === "/blog/post");
  check("root stays root", normalisePath("/") === "/");
  check("a missing path becomes root", normalisePath(undefined) === "/");
  check("path is capped", normalisePath("/" + "a".repeat(900)).length === 512);

  check("an asset is an asset", looksLikeAsset("/styles/app.css"));
  check("a Next build file is an asset", looksLikeAsset("/_next/static/chunk.js"));
  check("a page is not an asset", !looksLikeAsset("/pricing"));

  // Logpush emits the timestamp in whichever unit the job was configured for.
  // Guessing wrong by a factor of a thousand files every hit under 1970.
  check("RFC3339 timestamp", dayOf("2026-09-20T11:22:33Z") === "2026-09-20");
  check("nanoseconds", dayOf(1789903353000000000) === "2026-09-20", dayOf(1789903353000000000));
  check("microseconds", dayOf(1789903353000000) === "2026-09-20", dayOf(1789903353000000));
  check("milliseconds", dayOf(1789903353000) === "2026-09-20", dayOf(1789903353000));
  check("seconds", dayOf(1789903353) === "2026-09-20", dayOf(1789903353));
  check("a missing timestamp falls back to today rather than 1970",
    dayOf(undefined) === new Date().toISOString().slice(0, 10), dayOf(undefined));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

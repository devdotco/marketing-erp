import { promises as dns } from "node:dns";
import { ipInAny, parseCidr, type Cidr } from "./cidr";
import type { AiCrawler } from "./bots";

/**
 * Did the request really come from the crawler its user agent claims?
 *
 * Verification is best-effort and bounded, and the result is three-valued on
 * purpose. "Unverified" is not "fake": most operators publish nothing to check
 * against, and reporting their traffic as unverified is honest where reporting
 * it as verified would be a lie and dropping it would hide real crawling.
 *
 * Bounded because this runs inside a log ingest. A batch can carry thousands
 * of lines; doing a DNS round trip per line would turn a 200ms request into a
 * minute, and Cloudflare would give up and retry it. So: results are cached by
 * IP for the life of the process, and a single batch spends a fixed budget of
 * lookups. Lines past the budget are counted, just not verified — which is the
 * same state as an operator that publishes nothing.
 */

export type VerifyResult = "verified" | "unverified" | "spoofed";

const ipCache = new Map<string, VerifyResult>();
const CACHE_MAX = 5_000;

/** Published IP-range lists, fetched once per process with a TTL. */
const rangeCache = new Map<string, { at: number; cidrs: Cidr[] }>();
const RANGE_TTL_MS = 6 * 60 * 60 * 1000;

/** Lookups one batch may spend. See the module note. */
export const VERIFY_BUDGET_PER_BATCH = 50;

export function newVerifyBudget(): { remaining: number } {
  return { remaining: VERIFY_BUDGET_PER_BATCH };
}

export async function verifyCrawler(
  crawler: AiCrawler,
  ip: string,
  budget: { remaining: number },
): Promise<VerifyResult> {
  if (crawler.verification.method === "none") return "unverified";
  if (!ip) return "unverified";

  const key = `${crawler.key}:${ip}`;
  const cached = ipCache.get(key);
  if (cached) return cached;

  if (budget.remaining <= 0) return "unverified";
  budget.remaining -= 1;

  let result: VerifyResult = "unverified";
  try {
    if (crawler.verification.method === "reverse-dns") {
      result = await verifyReverseDns(ip, crawler.verification.suffixes);
    } else if (crawler.verification.method === "ip-ranges") {
      const cidrs = await publishedRanges(crawler.verification.url);
      // An empty list means the fetch failed, not that the IP is bogus.
      // Calling that "spoofed" would invent an attack out of a network blip.
      result = cidrs.length === 0 ? "unverified" : ipInAny(ip, cidrs) ? "verified" : "spoofed";
    }
  } catch {
    result = "unverified";
  }

  if (ipCache.size >= CACHE_MAX) ipCache.clear();
  ipCache.set(key, result);
  return result;
}

/**
 * Forward-confirmed reverse DNS, which is the check Google and Bing document.
 *
 * The reverse lookup alone proves nothing — whoever controls the IP's PTR
 * record can put any name there. It only counts when the name resolves back to
 * the same IP, which requires controlling the forward zone too.
 */
async function verifyReverseDns(ip: string, suffixes: string[]): Promise<VerifyResult> {
  let names: string[];
  try {
    names = await dns.reverse(ip);
  } catch {
    // No PTR record at all. Common, and not evidence of anything.
    return "unverified";
  }

  const claimed = names.find((name) => suffixes.some((s) => name.toLowerCase().endsWith(s)));
  if (!claimed) return "spoofed";

  try {
    const forward = await dns.resolve(claimed);
    return forward.includes(ip) ? "verified" : "spoofed";
  } catch {
    return "unverified";
  }
}

/**
 * The operator's published ranges.
 *
 * Shape varies: OpenAI publishes `{ prefixes: [{ ipv4Prefix }, { ipv6Prefix }] }`,
 * which is the same shape Google uses. Anything unrecognised yields an empty
 * list, which downgrades to "unverified" rather than accusing the crawler.
 */
async function publishedRanges(url: string): Promise<Cidr[]> {
  const hit = rangeCache.get(url);
  if (hit && Date.now() - hit.at < RANGE_TTL_MS) return hit.cidrs;

  const cidrs: Cidr[] = [];
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (res.ok) {
      const body = (await res.json()) as { prefixes?: Array<Record<string, unknown>> };
      for (const entry of body.prefixes ?? []) {
        const raw = entry.ipv4Prefix ?? entry.ipv6Prefix ?? entry.prefix;
        if (typeof raw !== "string") continue;
        const cidr = parseCidr(raw);
        if (cidr) cidrs.push(cidr);
      }
    }
  } catch {
    // Leave it empty; the caller treats that as unverified.
  }

  rangeCache.set(url, { at: Date.now(), cidrs });
  return cidrs;
}

/** Test seam: drop memoised state between cases. */
export function resetVerifyCaches(): void {
  ipCache.clear();
  rangeCache.clear();
}

/**
 * Payload CMS integration: reading a workspace's published posts (for internal
 * linking) and building the absolute URLs and candidate ranking used to feed
 * them into the Blog Writer's brief.
 *
 * Works against ANY customer's Payload 3 instance, not just our own
 * payload.dev.co — base URL, auth collection, posts collection, tenant id and
 * field mapping are all stored on the Integration (see lib/integrations/catalog.ts
 * PAYLOAD entry / normaliseKeyCredentials). Auth is API keys, not email/password:
 * Payload's Authorization header for a key is `<auth-collection-slug> API-Key
 * <key>` (https://payloadcms.com/docs/authentication/api-keys) — no password is
 * ever stored.
 *
 * payload.dev.co (our own multi-tenant instance) sits behind Cloudflare, which
 * 403s ("error code: 1010") requests that don't look like they came from a
 * browser — every fetch here sends a normal User-Agent to avoid that.
 *
 * The network calls (`listPublishedPosts`) are the only part that isn't pure;
 * `payloadPostUrl` and `rankInternalLinkCandidates` take plain data in and out
 * and are covered by test/content.test.ts with no network involved.
 */
import { assertPublicUrl } from "@/lib/integrations/public-url";

export interface PayloadCredentials {
  baseUrl: string;
  apiKey: string;
  authCollection: string;
  postsCollection: string;
  tenantId?: string;
  siteUrl: string;
  bodyField: string;
  bodyFormat: "html" | "lexical";
}

/** One post as read back from Payload, trimmed to what internal linking needs. */
export interface PayloadPost {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  /** Absolute URL on the public site — see payloadPostUrl. */
  url: string;
}

const TIMEOUT_MS = 10_000;

// Cloudflare's bot-fingerprint rule (see docs/CLAUDE memory: "payload.dev.co
// blocks urllib") keys off looking like a browser at all — a plain UA is
// enough; this doesn't need to be exact or current.
const USER_AGENT = "Mozilla/5.0 (compatible; marketing-erp/1.0; +https://marketing.erp.io)";

export function payloadAuthHeader(creds: Pick<PayloadCredentials, "authCollection" | "apiKey">): string {
  return `${creds.authCollection} API-Key ${creds.apiKey}`;
}

export function payloadHeaders(creds: Pick<PayloadCredentials, "authCollection" | "apiKey">): HeadersInit {
  return {
    Authorization: payloadAuthHeader(creds),
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
}

/**
 * The absolute, public URL for a post. Payload's own base URL is the CMS host
 * (often not public-facing the way the site is), so this resolves against the
 * configured Site URL, not baseUrl — matching our own estate, where
 * payload.dev.co is the CMS and dev.co is where posts actually render.
 *
 * Prefers `fullPath` (the site's actual URL path — e.g. dev.co uses paths like
 * `/chatbots` that don't follow a `/blog/<slug>` pattern) and falls back to
 * `/blog/<slug>` for a Payload with no fullPath field, which is the
 * convention on the rest of our brand blogs.
 */
export function payloadPostUrl(
  siteUrl: string,
  post: { fullPath?: string | null; slug?: string | null },
): string | null {
  const path = post.fullPath || (post.slug ? `/blog/${post.slug}` : "");
  if (!path) return null;
  try {
    return new URL(path, siteUrl).toString();
  } catch {
    return null;
  }
}

interface RawPayloadDoc {
  id: string | number;
  title?: unknown;
  slug?: unknown;
  excerpt?: unknown;
  fullPath?: unknown;
}

/**
 * List published posts, paginated, capped at `maxPosts` so a large blog can
 * never blow up the call (or, downstream, the prompt that reads its output).
 * Read-only: `where[_status][equals]=published`, and `where[tenant][equals]=`
 * scopes to a tenant when the multi-tenant plugin is in play (the field is
 * always named `tenant` — https://payloadcms.com/docs/plugins/multi-tenant).
 */
export async function listPublishedPosts(
  creds: PayloadCredentials,
  maxPosts = 150,
): Promise<PayloadPost[]> {
  await assertPublicUrl(creds.baseUrl);

  const pageSize = Math.min(100, maxPosts);
  const out: PayloadPost[] = [];
  let page = 1;

  while (out.length < maxPosts) {
    const params = new URLSearchParams();
    params.set("limit", String(Math.min(pageSize, maxPosts - out.length)));
    params.set("page", String(page));
    params.set("depth", "0");
    params.set("where[_status][equals]", "published");
    if (creds.tenantId) params.set("where[tenant][equals]", creds.tenantId);

    const res = await fetch(`${creds.baseUrl}/api/${creds.postsCollection}?${params.toString()}`, {
      headers: payloadHeaders(creds),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Payload returned ${res.status} listing ${creds.postsCollection}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    }
    const data = (await res.json()) as { docs?: RawPayloadDoc[]; hasNextPage?: boolean };
    for (const doc of data.docs ?? []) {
      const url = payloadPostUrl(creds.siteUrl, {
        fullPath: typeof doc.fullPath === "string" ? doc.fullPath : null,
        slug: typeof doc.slug === "string" ? doc.slug : null,
      });
      if (!url) continue;
      out.push({
        id: String(doc.id),
        title: typeof doc.title === "string" ? doc.title : "",
        slug: typeof doc.slug === "string" ? doc.slug : "",
        excerpt: typeof doc.excerpt === "string" ? doc.excerpt : "",
        url,
      });
      if (out.length >= maxPosts) break;
    }
    if (!data.hasNextPage || !data.docs || data.docs.length === 0) break;
    page += 1;
  }

  return out;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "is", "are",
  "was", "were", "be", "how", "what", "why", "your", "you", "it", "this", "that", "as", "at",
  "by", "from", "into", "about", "can", "do", "does", "will", "not", "no", "yes", "if", "so",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

export interface RankableBrief {
  targetKeyword: string;
  secondaryKeywords: string[];
  topicBrief: string;
  workingTitle: string;
}

/**
 * Pick the N Payload posts most relevant to a brief by plain keyword overlap
 * — no extra model call, so this stays free and the prompt stays small (the
 * content pipeline is sensitive to prompt size — see lib/content/research.ts
 * and lib/content/qc.ts). Every entry returned becomes a QC-enforced internal
 * link target (lib/content/qc.ts treats brief.internalLinks as required, not
 * a suggestion) — keep `limit` low so the writer can actually work them all
 * in.
 *
 * Never returns a post whose URL is already in `existingUrls` — this
 * augments what the user typed, it never replaces it.
 */
export function rankInternalLinkCandidates(
  brief: RankableBrief,
  posts: PayloadPost[],
  existingUrls: Iterable<string>,
  limit = 3,
): PayloadPost[] {
  const briefTokens = tokenize(
    [brief.targetKeyword, ...brief.secondaryKeywords, brief.topicBrief, brief.workingTitle].join(" "),
  );
  const seen = new Set([...existingUrls].map((u) => u.toLowerCase()));

  if (briefTokens.size === 0) return [];

  const scored = posts
    .filter((post) => post.title.trim() !== "" && !seen.has(post.url.toLowerCase()))
    .map((post) => {
      const postTokens = tokenize(`${post.title} ${post.excerpt}`);
      let overlap = 0;
      for (const token of postTokens) if (briefTokens.has(token)) overlap += 1;
      return { post, score: overlap };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((s) => s.post);
}

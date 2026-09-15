/**
 * Read-only discovery against a customer's Payload 3 instance, for the
 * two-step connect form (POST /api/integrations/payload/discover).
 *
 * Every call is a GET, sends the key only in the Authorization header, and
 * never returns or logs it. Documents are read at depth 0 and only field
 * NAMES/labels come back to the browser — never post bodies.
 *
 * Endpoints (see lib/integrations/payload-discovery.ts for the response shapes
 * as Payload 3.86 actually sanitises them):
 *  a) GET /api/<authCollection>/me  — does the key belong to a user?
 *     https://payloadcms.com/docs/authentication/operations#me
 *  b) GET /api/access               — which collections can it read/create?
 *     https://payloadcms.com/docs/authentication/operations#access
 *  c) GET /api/tenants?limit=100    — multi-tenant plugin's default slug
 *     https://payloadcms.com/docs/plugins/multi-tenant
 *  d) GET /api/<posts>?limit=1      — sniff one post for the body field
 *     https://payloadcms.com/docs/rest-api/overview
 *
 * `fetch` and `assertPublicUrl` are injectable so test/content.test.ts can run
 * the whole flow against canned responses with no network.
 */
import { assertPublicUrl as realAssertPublicUrl } from "@/lib/integrations/public-url";
import { payloadHeaders } from "@/lib/integrations/payload";
import {
  elevatedRole,
  mediaCollectionOptions,
  normalisePayloadBaseUrl,
  parseAccessCollections,
  postsCollectionOptions,
  sniffBodyFormat,
  suggestMediaCollection,
  suggestPostsCollection,
  tenantOptions,
  tenantOptionsFromUser,
  type PayloadDiscovery,
} from "@/lib/integrations/payload-discovery";

const TIMEOUT_MS = 10_000;
const TENANT_LIMIT = 100;

export interface PayloadDiscoverInput {
  baseUrl: string;
  authCollection: string;
  apiKey: string;
  /** Re-sniff the body field for this collection instead of the suggested one. */
  postsCollection?: string;
}

export interface PayloadDiscoverDeps {
  fetch?: typeof fetch;
  assertPublicUrl?: (url: string) => Promise<void>;
}

const KEY_REJECTED =
  "Payload didn't recognise that API key. Check it was copied whole and hasn't been regenerated, and that the Auth collection matches the collection it was generated on (usually users). Note: the \"API\" tab on a user's page in the Payload admin is a JSON viewer, not a key — a key comes from the user's edit form (\"Enable API Key\", then generate), which only exists once API keys are enabled on that collection.";
const CLOUDFLARE_1010 =
  "Payload's edge network blocked this request as non-browser traffic (Cloudflare error 1010). Try again, and contact whoever runs the Payload instance if it persists.";
const NOT_PAYLOAD =
  "That address didn't answer like a Payload API — check the Base URL is the Payload instance itself (where /admin lives), not the public website in front of it.";

type Got = { status: number; json: unknown; isJson: boolean; text: string };

function slugOk(slug: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(slug);
}

export async function discoverPayload(input: PayloadDiscoverInput, deps: PayloadDiscoverDeps = {}): Promise<PayloadDiscovery> {
  const doFetch = deps.fetch ?? fetch;
  const assertPublic = deps.assertPublicUrl ?? realAssertPublicUrl;

  const base = normalisePayloadBaseUrl(input.baseUrl);
  if (!base.ok) return { ok: false, step: "url", error: base.error };
  const baseUrl = base.url;
  const authCollection = (input.authCollection.trim() || "users").toLowerCase();
  if (!slugOk(authCollection)) {
    return { ok: false, step: "auth", error: `"${authCollection}" isn't a collection name — it's the slug of the collection your API user lives in, usually users.` };
  }
  const apiKey = input.apiKey.trim();
  if (!apiKey) return { ok: false, step: "auth", error: "Paste the API key." };

  try {
    await assertPublic(baseUrl);
  } catch (err) {
    return { ok: false, step: "url", error: (err as Error).message.replace(/^Site URL/, "Payload base URL") };
  }

  const headers = payloadHeaders({ authCollection, apiKey });
  const get = async (path: string): Promise<Got> => {
    const res = await doFetch(`${baseUrl}${path}`, { headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    if (isJson) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, json, isJson, text };
  };

  // a) Who is this key?
  let me: Got;
  try {
    me = await get(`/api/${authCollection}/me`);
  } catch (err) {
    return { ok: false, step: "network", error: networkError(err) };
  }
  if (me.status === 403 && me.text.includes("1010")) return { ok: false, step: "network", error: CLOUDFLARE_1010 };
  if (me.status === 404) {
    return me.isJson
      ? { ok: false, step: "auth", error: `Payload has no auth collection called "${authCollection}". It's the collection your API user lives in — usually users.` }
      : { ok: false, step: "url", error: NOT_PAYLOAD };
  }
  if (!me.isJson) return { ok: false, step: "url", error: NOT_PAYLOAD };
  if (me.status === 401 || me.status === 403) return { ok: false, step: "auth", error: KEY_REJECTED };
  if (me.status >= 400) return { ok: false, step: "network", error: `Payload returned ${me.status} checking the key.` };
  const user = (me.json as { user?: unknown } | null)?.user;
  if (!user || typeof user !== "object") return { ok: false, step: "auth", error: KEY_REJECTED };

  const warnings: string[] = [];
  const role = elevatedRole(user);
  if (role) {
    warnings.push(
      `This key belongs to a user with the "${role}" role, so it can reach more than one site. Safer: a dedicated API user assigned to only this site's tenant.`,
    );
  }
  const email = typeof (user as { email?: unknown }).email === "string" ? ((user as { email: string }).email) : null;

  // b) What can it see?
  let access: Extract<PayloadDiscovery, { ok: true }>["access"];
  try {
    const got = await get("/api/access");
    const parsed = got.status === 200 && got.isJson ? parseAccessCollections(got.json) : null;
    access = parsed
      ? { available: true, collections: parsed }
      : {
          available: false,
          reason:
            got.status === 404 || !got.isJson
              ? "This Payload instance doesn't expose /api/access, so its collections can't be listed — type the collection names below instead."
              : `Payload returned ${got.status} listing collections — type the collection names below instead.`,
        };
  } catch {
    access = { available: false, reason: "Couldn't list collections — type the collection names below instead." };
  }

  const postsCollections = access.available ? postsCollectionOptions(access.collections, authCollection) : [];
  const mediaCollections = access.available ? mediaCollectionOptions(access.collections, authCollection) : [];
  if (access.available && postsCollections.length === 0) {
    warnings.push("This API key can't read any content collections. Give its user read access to your posts collection, then check again.");
  }
  const requested = input.postsCollection?.trim().toLowerCase();
  const postsCollection =
    requested && slugOk(requested) && (!access.available || postsCollections.includes(requested))
      ? requested
      : access.available
        ? suggestPostsCollection(postsCollections)
        : "posts";
  if (access.available && postsCollection) {
    const posts = access.collections.find((c) => c.slug === postsCollection);
    if (posts && !posts.create) {
      warnings.push(`This key can read "${postsCollection}" but not create in it — internal linking will work, publishing drafts won't.`);
    }
  }

  // c) Tenants — when the access map says they're readable, or when there's no
  // access map to ask (a 404 here costs nothing and changes nothing).
  let tenants: Extract<PayloadDiscovery, { ok: true }>["tenants"] = { available: false, reason: null };
  const tenantsReadable = access.available ? access.collections.some((c) => c.slug === "tenants") : true;
  if (tenantsReadable) {
    try {
      const got = await get(`/api/tenants?limit=${TENANT_LIMIT}&depth=0`);
      const body = got.json as { docs?: unknown[]; totalDocs?: number } | null;
      if (got.status === 200 && Array.isArray(body?.docs)) {
        const options = tenantOptions(body.docs);
        tenants = { available: true, options, truncated: (body.totalDocs ?? 0) > body.docs.length };
      } else if (access.available) {
        tenants = { available: false, reason: `Payload returned ${got.status} listing tenants — enter the tenant ID by hand.` };
      }
    } catch {
      tenants = { available: false, reason: "Couldn't list tenants — enter the tenant ID by hand." };
    }
  }
  // Can't list tenants (or the list came back empty)? The key's own user
  // document still says which tenants it's assigned to.
  const assigned = tenantOptionsFromUser(user);
  if (assigned.length > 0 && !(tenants.available && tenants.options.length > 0)) {
    tenants = { available: true, options: assigned, truncated: false };
  }

  // d) Sniff one post for the body field; e) its `tenant` field also proves multi-tenancy.
  let postHasTenant = false;
  let body = sniffBodyFormat(null);
  if (postsCollection) {
    try {
      const got = await get(`/api/${postsCollection}?limit=1&depth=0`);
      const doc = (got.json as { docs?: unknown[] } | null)?.docs?.[0];
      if (got.status === 200 && doc && typeof doc === "object") {
        body = sniffBodyFormat(doc);
        postHasTenant = "tenant" in doc;
      } else if (got.status === 200) {
        body = { ...body, note: `"${postsCollection}" has no posts this key can see yet, so the body field is the default (HTML in bodyHtml). Check it under Advanced.` };
      } else if (got.status === 404 && !access.available) {
        warnings.push(`Payload has no "${postsCollection}" collection at that Base URL — type your posts collection's name below (the collection, not a post's slug).`);
      }
    } catch {
      // Sniffing is best-effort; the defaults stand.
    }
  }

  const multiTenant = (tenants.available && tenants.options.length > 0) || postHasTenant;
  if (multiTenant && tenants.available && tenants.options.length === 0) {
    tenants = { available: false, reason: "Posts are tenant-scoped, but this key can't list tenants — enter the tenant ID by hand." };
  }
  if (tenants.available && tenants.truncated) {
    warnings.push(`Only the first ${TENANT_LIMIT} tenants are listed. A key scoped to one site's tenant avoids this.`);
  }

  return {
    ok: true,
    baseUrl,
    authCollection,
    user: { email, elevatedRole: role },
    access,
    postsCollections,
    postsCollection,
    mediaCollections,
    mediaCollection: access.available ? suggestMediaCollection(mediaCollections) : "media",
    multiTenant,
    tenants,
    body,
    warnings,
  };
}

function networkError(err: unknown): string {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return `Payload didn't respond within ${TIMEOUT_MS / 1000}s. Check the Base URL and try again.`;
  }
  const cause = (err as { cause?: { message?: string } })?.cause?.message ?? "";
  if (/redirect/i.test(cause) || /redirect/i.test((err as Error)?.message ?? "")) {
    return "That address redirects somewhere else. Use the final address the Payload admin loads on (for example with or without www).";
  }
  return `Couldn't reach Payload at that address: ${cause || (err instanceof Error ? err.message : String(err))}`;
}

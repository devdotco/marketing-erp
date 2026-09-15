/**
 * Pure, client-safe helpers behind the two-step Payload connect form: turning
 * what a Payload 3 instance says about itself into dropdown options, so the
 * form can offer choices instead of free-text boxes people fill in wrong
 * (a post slug typed as the collection, a guessed tenant id, an /admin URL).
 *
 * No network and no server imports — the page imports this directly, the
 * discover route (lib/integrations/payload-discover.ts) feeds it, and
 * test/content.test.ts covers it.
 *
 * Response shapes were read from Payload 3.86's source, not just the docs:
 *  - GET /api/access (https://payloadcms.com/docs/authentication/operations#access)
 *    runs `sanitizePermissions`, which rewrites `{ permission: true }` to plain
 *    `true`, DELETES operations that are denied, and keeps
 *    `{ permission: true, where: {...} }` when access is a query constraint
 *    (e.g. a multi-tenant "only your tenants" rule). So a denied read is an
 *    absent key, not `false`.
 *  - GET /api/<auth-slug>/me (https://payloadcms.com/docs/authentication/operations#me)
 *    answers 200 `{ user: null }` for an unknown key — it never 401s — and
 *    `{ user: {...}, collection, strategy: "api-key" }` for a good one.
 */

export interface PayloadCollectionAccess {
  slug: string;
  read: boolean;
  create: boolean;
  update: boolean;
  /** Access is granted through a query constraint (typically tenant-scoped), not unconditionally. */
  scoped: boolean;
}

export interface PayloadTenantOption {
  /** The tenant document id, as a string — what `where[tenant][equals]` takes. */
  id: string;
  name: string;
  domain: string | null;
  slug: string | null;
  /** "Name — domain" (or "Name — slug", or just the name). */
  label: string;
  /** A public https origin derived from the tenant's domain/siteUrl field, when it has one. */
  siteUrl: string | null;
}

export interface PayloadBodySniff {
  bodyFormat: "html" | "lexical";
  bodyField: string;
  /** "content" = seen a populated value; "field" = the field exists but was empty; "default" = nothing to go on. */
  source: "content" | "field" | "default";
  note: string;
}

export type PayloadDiscovery =
  | { ok: false; step: "url" | "auth" | "network"; error: string }
  | {
      ok: true;
      baseUrl: string;
      authCollection: string;
      user: { email: string | null; elevatedRole: string | null };
      access: { available: true; collections: PayloadCollectionAccess[] } | { available: false; reason: string };
      postsCollections: string[];
      postsCollection: string | null;
      mediaCollections: string[];
      mediaCollection: string | null;
      multiTenant: boolean;
      tenants: { available: true; options: PayloadTenantOption[]; truncated: boolean } | { available: false; reason: string | null };
      body: PayloadBodySniff;
      warnings: string[];
    };

/** Payload's own bookkeeping collections — never somewhere posts live. */
const INTERNAL_COLLECTION = /^payload-/;

/**
 * What the "Payload base URL" field will actually be saved as — the same
 * reduction to an origin normaliseKeyCredentials does, plus adding the https://
 * someone forgot. Shown under the field so "https://payload.dev.co/admin"
 * visibly becomes "https://payload.dev.co" before anything is checked.
 */
export function normalisePayloadBaseUrl(raw: string): { ok: true; url: string; changed: boolean } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "Enter the address of your Payload instance, like https://payload.example.com" };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: "That isn't a valid web address — it should look like https://payload.example.com" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "Payload base URL must use https" };
  if (!url.hostname.includes(".")) return { ok: false, error: "That isn't a public web address — it should look like https://payload.example.com" };
  return { ok: true, url: url.origin, changed: url.origin !== trimmed };
}

function permissionOf(value: unknown): { granted: boolean; scoped: boolean } {
  if (value === true) return { granted: true, scoped: false };
  if (value && typeof value === "object" && "permission" in value) {
    const v = value as { permission?: unknown; where?: unknown };
    const granted = v.permission === true;
    return { granted, scoped: granted && v.where !== undefined };
  }
  return { granted: false, scoped: false };
}

/**
 * GET /api/access body → one entry per collection the key can at least read.
 * Returns null when the body isn't an access map at all (so the caller falls
 * back to free text rather than showing an empty dropdown).
 */
export function parseAccessCollections(body: unknown): PayloadCollectionAccess[] | null {
  if (!body || typeof body !== "object") return null;
  const collections = (body as { collections?: unknown }).collections;
  // A key with no access to anything still gets `collections` stripped to
  // nothing by sanitizePermissions' empty-object cleanup — that is a real
  // (empty) answer, distinct from a response that isn't an access map.
  if (collections === undefined) return "canAccessAdmin" in body || "globals" in body ? [] : null;
  if (!collections || typeof collections !== "object" || Array.isArray(collections)) return null;

  const out: PayloadCollectionAccess[] = [];
  for (const [slug, perms] of Object.entries(collections as Record<string, unknown>)) {
    if (INTERNAL_COLLECTION.test(slug)) continue;
    const all = perms === true;
    const obj = (perms && typeof perms === "object" ? perms : {}) as Record<string, unknown>;
    const read = all ? { granted: true, scoped: false } : permissionOf(obj.read);
    if (!read.granted) continue;
    const create = all ? { granted: true, scoped: false } : permissionOf(obj.create);
    const update = all ? { granted: true, scoped: false } : permissionOf(obj.update);
    out.push({ slug, read: true, create: create.granted, update: update.granted, scoped: read.scoped || create.scoped || update.scoped });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

const POSTISH = /(^|-)(posts?|articles?|blogs?|news|stories)(-|$)/;
const MEDIAISH = /(^|-)(media|uploads?|images?|assets?|files?)(-|$)/;

/**
 * Collections worth offering as "Posts collection": everything readable except
 * the auth collection and the tenants collection, post-like names first.
 */
export function postsCollectionOptions(collections: PayloadCollectionAccess[], authCollection: string): string[] {
  return collections
    .map((c) => c.slug)
    .filter((slug) => slug !== authCollection && slug !== "tenants")
    .sort((a, b) => Number(POSTISH.test(b)) - Number(POSTISH.test(a)) || a.localeCompare(b));
}

export function suggestPostsCollection(options: string[]): string | null {
  if (options.includes("posts")) return "posts";
  return options.find((slug) => POSTISH.test(slug)) ?? null;
}

/**
 * Media collection options: collections the key can create in (Blog Writer
 * uploads images), media-like names first. `/api/access` can't tell an upload
 * collection from any other, so the default leans on the conventional name.
 */
export function mediaCollectionOptions(collections: PayloadCollectionAccess[], authCollection: string): string[] {
  return collections
    .filter((c) => c.create && c.slug !== authCollection && c.slug !== "tenants")
    .map((c) => c.slug)
    .sort((a, b) => Number(MEDIAISH.test(b)) - Number(MEDIAISH.test(a)) || a.localeCompare(b));
}

export function suggestMediaCollection(options: string[]): string | null {
  if (options.includes("media")) return "media";
  return options.find((slug) => MEDIAISH.test(slug)) ?? null;
}

/** "investmentbank.com", "https://www.x.com/blog/" → "https://investmentbank.com", "https://www.x.com/blog". */
export function siteUrlFromDomain(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (!url.hostname.includes(".")) return null;
    return `https://${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Tenant documents (depth 0) → dropdown options labelled "Name — domain". */
export function tenantOptions(docs: unknown[]): PayloadTenantOption[] {
  const out: PayloadTenantOption[] = [];
  for (const raw of docs) {
    if (!raw || typeof raw !== "object") continue;
    const doc = raw as Record<string, unknown>;
    if (typeof doc.id !== "string" && typeof doc.id !== "number") continue;
    const id = String(doc.id);

    let domain = str(doc.primaryDomain) ?? str(doc.domain) ?? str(doc.hostname);
    if (!domain && Array.isArray(doc.domains)) {
      for (const d of doc.domains) {
        domain = str(d) ?? (d && typeof d === "object" ? str((d as Record<string, unknown>).domain) : null);
        if (domain) break;
      }
    }
    const explicitSite = str(doc.siteUrl) ?? str(doc.url);
    const siteUrl = (explicitSite && siteUrlFromDomain(explicitSite)) ?? (domain ? siteUrlFromDomain(domain) : null);
    if (!domain && siteUrl) domain = new URL(siteUrl).host;

    const slug = str(doc.slug);
    const name = str(doc.name) ?? str(doc.title) ?? str(doc.label) ?? slug ?? `Tenant ${id}`;
    const detail = domain ?? (slug && slug !== name ? slug : null);
    out.push({ id, name, domain, slug, label: detail ? `${name} — ${detail}` : name, siteUrl });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Tenants the key's own user is assigned to, read off the /me document — the
 * fallback when /api/tenants can't be listed. That happens on payload.dev.co
 * for exactly the recommended setup: a tenant-scoped user's read access on
 * `tenants` is a `where` on a field the tenants collection doesn't have.
 * Handles the multi-tenant plugin's default `tenants: [{ tenant }]` and
 * payload.dev.co's `tenantAssignments: [{ tenant, roles }]`, with `tenant`
 * either populated (an object) or a bare id.
 */
export function tenantOptionsFromUser(user: unknown): PayloadTenantOption[] {
  if (!user || typeof user !== "object") return [];
  const u = user as Record<string, unknown>;
  // id → doc; a populated tenant object beats a bare id for the same tenant.
  const byId = new Map<string, { doc: unknown; populated: boolean }>();
  for (const key of ["tenantAssignments", "tenants"]) {
    const list = u[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const tenant = item && typeof item === "object" && "tenant" in item ? (item as { tenant: unknown }).tenant : item;
      if (typeof tenant === "string" || typeof tenant === "number") {
        if (!byId.has(String(tenant))) byId.set(String(tenant), { doc: { id: tenant, name: `Tenant ${tenant}` }, populated: false });
      } else if (tenant && typeof tenant === "object") {
        const id = (tenant as { id?: unknown }).id;
        if ((typeof id === "string" || typeof id === "number") && !byId.get(String(id))?.populated) {
          byId.set(String(id), { doc: tenant, populated: true });
        }
      }
    }
  }
  return tenantOptions([...byId.values()].map((v) => v.doc));
}

const HTML_FIELD_NAMES =["bodyHtml", "html", "contentHtml", "body_html", "content", "body"];
/** Only unambiguous names count when the sniffed value is empty — an empty `content` could just as well be rich text. */
const HTML_ONLY_FIELD_NAMES = ["bodyHtml", "html", "contentHtml", "body_html"];
const LEXICAL_FIELD_NAMES = ["content", "body", "richText", "bodyRichText"];

const isLexical = (v: unknown): boolean =>
  !!v && typeof v === "object" && !Array.isArray(v) && !!(v as { root?: unknown }).root && typeof (v as { root?: unknown }).root === "object";

/**
 * Guess which field on a post holds the article body and in what format, from
 * one document read at depth 0. HTML wins over Lexical when both exist,
 * because only HTML can be published into automatically.
 */
export function sniffBodyFormat(doc: unknown): PayloadBodySniff {
  const fallback: PayloadBodySniff = {
    bodyFormat: "html",
    bodyField: "bodyHtml",
    source: "default",
    note: "Couldn't inspect a post, so this is the default (an HTML string field called bodyHtml). Check it matches your posts collection.",
  };
  if (!doc || typeof doc !== "object") return fallback;
  const d = doc as Record<string, unknown>;

  for (const name of HTML_FIELD_NAMES) {
    if (typeof d[name] === "string" && (d[name] as string).trim()) {
      return { bodyFormat: "html", bodyField: name, source: "content", note: `Found HTML in the "${name}" field of an existing post.` };
    }
  }
  for (const name of HTML_ONLY_FIELD_NAMES) {
    if (name in d) {
      return { bodyFormat: "html", bodyField: name, source: "field", note: `Posts have a "${name}" field (empty on the post inspected) — assuming it takes HTML.` };
    }
  }
  const lexicalName = LEXICAL_FIELD_NAMES.find((n) => isLexical(d[n])) ?? Object.keys(d).find((n) => isLexical(d[n]));
  if (lexicalName) {
    return {
      bodyFormat: "lexical",
      bodyField: lexicalName,
      source: "content",
      note: `Found Lexical rich text in the "${lexicalName}" field. Internal linking works; publishing new posts into Lexical isn't supported yet.`,
    };
  }
  return fallback;
}

/**
 * Why a typed collection name is probably wrong, or null. Catches the two
 * real mistakes: pasting a URL, and pasting a post's slug
 * ("ai-virtual-data-room") where the collection ("posts") belongs.
 * `known` is the readable collection list when discovery produced one.
 */
export function collectionNameProblem(value: string, known?: string[]): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (known?.includes(v)) return null;
  if (/[/:]/.test(v) || v.includes(".")) {
    return "That looks like a URL — this field wants just the collection's name, like posts.";
  }
  if (/\s/.test(v)) return "Collection names don't contain spaces — it's the slug, like posts.";
  const usual = known?.includes("posts") || !known ? " The collection is usually \"posts\"." : "";
  const hyphens = (v.match(/-/g) ?? []).length;
  if (hyphens >= 2 || (hyphens === 1 && known && !known.includes(v))) {
    return `"${v}" looks like a post slug, not a collection — this field wants the collection's name.${usual}`;
  }
  if (known && known.length > 0) {
    return `This API key can't read a "${v}" collection. It can read: ${known.join(", ")}.`;
  }
  return null;
}

/**
 * A role on the key's user that reaches beyond one site. Payload has no
 * standard role field; these are the common shapes (payload.dev.co uses
 * `globalRole`).
 */
export function elevatedRole(user: unknown): string | null {
  if (!user || typeof user !== "object") return null;
  const u = user as Record<string, unknown>;
  const roles = [u.globalRole, u.role, ...(Array.isArray(u.roles) ? u.roles : [u.roles])].filter(
    (r): r is string => typeof r === "string",
  );
  return roles.find((r) => /super|admin/i.test(r)) ?? null;
}

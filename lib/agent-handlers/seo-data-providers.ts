import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { AgentInputError } from "@/lib/ai/errors";

/**
 * Live Ahrefs/Semrush fetchers shared by the five SEO handlers (keyword
 * research, prospector, backlink monitor, competitor watch, topic planner).
 *
 * Ahrefs v3 lives on api.ahrefs.com (not the v2 host apiv2.ahrefs.com the
 * handlers used to call) and authenticates with `Authorization: Bearer`, not
 * a `token=` query param — both of those were wrong before this file existed,
 * so every "LIVE AHREFS DATA" block was actually a 404 swallowed by a bare
 * `catch {}` and silently downgrading to simulation. `select` and `date` are
 * required by the v3 API or it 400s.
 * https://docs.ahrefs.com/en/api/reference/site-explorer
 */

const AHREFS_BASE = "https://api.ahrefs.com/v3";
const SEMRUSH_BASE = "https://api.semrush.com";
// SearchAtlas federates its API across many per-service subdomains under one
// OpenAPI spec (https://docs.searchatlas.com/searchatlas-api.json) — these two
// are the hosts for the endpoints this file calls.
const SEARCHATLAS_KEYWORD_BASE = "https://keyword.searchatlas.com";
const SEARCHATLAS_CA_BASE = "https://ca.searchatlas.com";

function ahrefsHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Strip a scheme and trailing slash — Ahrefs/Semrush `target`/`domain` params want a bare host. */
export function bareDomain(input: string): string {
  return input.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim();
}

export async function fetchAhrefsOrganicKeywords(apiKey: string, target: string): Promise<unknown> {
  const params = new URLSearchParams({
    target,
    mode: "domain",
    date: today(),
    select: "keyword,volume,keyword_difficulty,cpc,best_position,serp_features",
    limit: "100",
  });
  const res = await fetch(`${AHREFS_BASE}/site-explorer/organic-keywords?${params}`, {
    headers: ahrefsHeaders(apiKey),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Ahrefs organic-keywords ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export async function fetchAhrefsBacklinks(apiKey: string, target: string): Promise<unknown> {
  const params = new URLSearchParams({
    target,
    mode: "domain",
    select: "url_from,url_to,domain_rating_source,anchor,is_dofollow,first_seen,last_seen",
    limit: "100",
  });
  const res = await fetch(`${AHREFS_BASE}/site-explorer/all-backlinks?${params}`, {
    headers: ahrefsHeaders(apiKey),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Ahrefs all-backlinks ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export async function fetchSemrushPhraseThis(apiKey: string, phrase: string, database: string): Promise<string> {
  // No Po (position) here — phrase_this is a bare keyword overview, not tied
  // to a ranking domain, so it doesn't carry a position column.
  const params = new URLSearchParams({
    type: "phrase_this",
    phrase,
    key: apiKey,
    export_columns: "Ph,Nq,Cp,Co",
    database,
  });
  const res = await fetch(`${SEMRUSH_BASE}/?${params}`, { signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  if (!res.ok || text.startsWith("ERROR")) throw new Error(`Semrush phrase_this: ${text.slice(0, 300)}`);
  return text;
}

export async function fetchSemrushDomainOrganic(apiKey: string, domain: string, database = "us"): Promise<string> {
  const params = new URLSearchParams({
    type: "domain_organic",
    domain,
    key: apiKey,
    export_columns: "Ph,Po,Nq,Cp",
    database,
  });
  const res = await fetch(`${SEMRUSH_BASE}/?${params}`, { signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  if (!res.ok || text.startsWith("ERROR")) throw new Error(`Semrush domain_organic: ${text.slice(0, 300)}`);
  return text;
}

function searchAtlasHeaders(apiKey: string): Record<string, string> {
  return { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SearchAtlas's Keyword Gap Analysis — "Identifies keywords that competitor
 * websites rank for but the primary website does not."
 * https://docs.searchatlas.com/ (POST/GET /api/v4/keyword-gap-analysis/, host
 * keyword.searchatlas.com)
 *
 * Unlike Ahrefs/Semrush above, this is async on SearchAtlas's side: POST
 * either returns 200 with analysis metadata (id, no results yet) or 202 with
 * `{ should_repoll: true }` while it's still processing, and the *data*
 * (columns/values/chart_data) only ever comes back from GET
 * /{id}/ once that also stops returning 202. The 202 response schema
 * SearchAtlas documents doesn't include the id, so if the first POST comes
 * back 202 without one, this re-POSTs (the endpoint is described as
 * idempotent — "Returns an existing project if the URL was recently
 * analyzed" is documented for the sibling /api/v2/competitor-research/
 * endpoint, and this one caches on the same primary+competitor+country key)
 * until a response carries an id to poll.
 */
export async function fetchSearchAtlasKeywordGap(
  apiKey: string,
  primaryDomain: string,
  competitorDomains: string[],
  countryCode = "us",
): Promise<unknown> {
  const headers = searchAtlasHeaders(apiKey);
  const body = JSON.stringify({
    primary_website: { url: primaryDomain, scope: "root_domain" },
    competitor_websites: competitorDomains.slice(0, 4).map((url) => ({ url, scope: "root_domain" })),
    country_code: countryCode,
  });
  const createUrl = `${SEARCHATLAS_KEYWORD_BASE}/api/v4/keyword-gap-analysis/`;

  const deadline = Date.now() + 25_000;
  let id: number | undefined;
  while (id === undefined && Date.now() < deadline) {
    const res = await fetch(createUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
    if (!res.ok && res.status !== 202) {
      throw new Error(`SearchAtlas keyword-gap-analysis ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json().catch(() => ({}))) as { id?: number; should_repoll?: boolean };
    if (typeof data.id === "number") {
      id = data.id;
      break;
    }
    await sleep(3000);
  }
  if (id === undefined) throw new Error("SearchAtlas keyword gap analysis didn't return an analysis id in time");

  while (Date.now() < deadline) {
    const res = await fetch(`${createUrl}${id}/`, { headers, signal: AbortSignal.timeout(10_000) });
    if (res.status === 202) {
      await sleep(3000);
      continue;
    }
    if (!res.ok) throw new Error(`SearchAtlas keyword-gap-analysis/${id} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
  throw new Error("SearchAtlas keyword gap analysis is still processing — try again shortly.");
}

/**
 * SearchAtlas's Topical Authority Map — "Generates a topical authority map
 * for the given content topic. The map clusters related keywords and
 * generates article title suggestions." https://docs.searchatlas.com/
 * (POST/GET /api/topical-authority-map/, host ca.searchatlas.com)
 *
 * Also async: the 201 create response carries `id` and `task_status`
 * (PENDING/STARTED/SUCCESS/FAILURE) directly — no repoll-for-an-id problem
 * like the keyword-gap endpoint above — so this just polls the same object
 * until task_status settles.
 */
export async function fetchSearchAtlasTopicalMap(
  apiKey: string,
  contentTopic: string,
  countryCode = "us",
): Promise<unknown> {
  const headers = searchAtlasHeaders(apiKey);
  const detailUrl = (id: number) => `${SEARCHATLAS_CA_BASE}/api/topical-authority-map/${id}/`;

  const createRes = await fetch(`${SEARCHATLAS_CA_BASE}/api/topical-authority-map/`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content_topic: contentTopic,
      clusters_count: 5,
      keywords_count: 5,
      titles_count: 5,
      language_code: "en",
      country_code: countryCode,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!createRes.ok) {
    throw new Error(`SearchAtlas topical-authority-map ${createRes.status}: ${(await createRes.text()).slice(0, 300)}`);
  }
  let map = (await createRes.json()) as { id: number; task_status: string; formatted_data: unknown };

  const deadline = Date.now() + 25_000;
  while (map.task_status !== "SUCCESS" && map.task_status !== "FAILURE" && Date.now() < deadline) {
    await sleep(3000);
    const res = await fetch(detailUrl(map.id), { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`SearchAtlas topical-authority-map/${map.id} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    map = await res.json();
  }
  if (map.task_status === "FAILURE") throw new Error("SearchAtlas topical map generation failed");
  if (map.task_status !== "SUCCESS") throw new Error("SearchAtlas topical map is still processing — try again shortly.");
  return map.formatted_data;
}

export type SeoLiveOutcome =
  | { source: "live"; provider: "AHREFS" | "SEMRUSH" | "SEARCH_ATLAS"; section: string }
  | { source: "simulation" };

/**
 * Try Ahrefs, then Semrush, then SearchAtlas, for one piece of SEO data.
 *
 * Mirrors the credential-fault handling `resolveAnthropic` uses: a connected
 * integration that fails is not the same as no integration at all. If any
 * provider is connected and its call works, use it. If at least one is
 * connected and every connected one fails, the run fails with a legible,
 * non-retryable error — the old behaviour quietly asked Claude to invent
 * "LIVE AHREFS DATA" wholesale and handed it back labelled the same as if it
 * were real. Only when NONE is connected does the caller fall back to
 * Claude's own simulated estimate, same as before.
 */
export async function resolveSeoLiveData(
  workspaceId: string,
  describe: (data: unknown, provider: "AHREFS" | "SEMRUSH" | "SEARCH_ATLAS") => string,
  calls: {
    ahrefs?: (apiKey: string) => Promise<unknown>;
    semrush?: (apiKey: string) => Promise<string>;
    searchAtlas?: (apiKey: string) => Promise<unknown>;
  },
): Promise<SeoLiveOutcome> {
  const [ahrefsIntegration, semrushIntegration, searchAtlasIntegration] = await Promise.all([
    calls.ahrefs
      ? prisma.integration.findUnique({ where: { workspaceId_provider: { workspaceId, provider: "AHREFS" } } })
      : null,
    calls.semrush
      ? prisma.integration.findUnique({ where: { workspaceId_provider: { workspaceId, provider: "SEMRUSH" } } })
      : null,
    calls.searchAtlas
      ? prisma.integration.findUnique({ where: { workspaceId_provider: { workspaceId, provider: "SEARCH_ATLAS" } } })
      : null,
  ]);

  const failures: string[] = [];

  if (ahrefsIntegration?.encryptedCredentials && calls.ahrefs) {
    try {
      const creds = await decryptCredentials<{ apiKey: string }>(ahrefsIntegration.encryptedCredentials);
      const data = await calls.ahrefs(creds.apiKey);
      return { source: "live", provider: "AHREFS", section: describe(data, "AHREFS") };
    } catch (err) {
      failures.push(`Ahrefs: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (semrushIntegration?.encryptedCredentials && calls.semrush) {
    try {
      const creds = await decryptCredentials<{ apiKey: string }>(semrushIntegration.encryptedCredentials);
      const data = await calls.semrush(creds.apiKey);
      return { source: "live", provider: "SEMRUSH", section: describe(data, "SEMRUSH") };
    } catch (err) {
      failures.push(`Semrush: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (searchAtlasIntegration?.encryptedCredentials && calls.searchAtlas) {
    try {
      const creds = await decryptCredentials<{ apiKey: string }>(searchAtlasIntegration.encryptedCredentials);
      const data = await calls.searchAtlas(creds.apiKey);
      return { source: "live", provider: "SEARCH_ATLAS", section: describe(data, "SEARCH_ATLAS") };
    } catch (err) {
      failures.push(`SearchAtlas: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures.length > 0) {
    throw new AgentInputError(
      `Connected SEO data source${failures.length > 1 ? "s" : ""} failed to respond: ${failures.join("; ")}`,
      "Check the key under Settings → Integrations — it may be expired, revoked, or on a plan without API access. Disconnect it if you'd rather this agent fall back to AI-estimated data.",
      "seo_integration_unavailable",
    );
  }

  return { source: "simulation" };
}

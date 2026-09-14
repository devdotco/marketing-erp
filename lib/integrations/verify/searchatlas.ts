import type { KeyVerifier } from "./types";

/**
 * One cheap, read-only, zero-credit call that proves the stored key works —
 * same rationale as the Ahrefs/Semrush verifiers in ./seo-content.ts.
 *
 * SearchAtlas's OpenAPI spec (https://docs.searchatlas.com/searchatlas-api.json)
 * federates ~800 endpoints across many per-service subdomains, all under one
 * `X-API-Key` header (https://docs.searchatlas.com/). /api/credits/status/ on
 * api.builder.searchatlas.com is documented as "Returns the current AI credit
 * balance including total, consumed, and remaining credits" — a balance check,
 * not a data pull, so it doesn't spend any of the credits the live agent calls
 * (Topical Authority Map, Keyword Gap Analysis) consume.
 */

const TIMEOUT_MS = 10_000;

const searchAtlas: KeyVerifier = async (credentials) => {
  try {
    const res = await fetch("https://api.builder.searchatlas.com/api/credits/status/", {
      headers: { "X-API-Key": credentials.apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "SearchAtlas rejected that API key — check it was copied whole from Dashboard → Settings → API Settings and hasn't been revoked." };
    }
    if (!res.ok) {
      return { ok: false, reason: `SearchAtlas returned ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { ok: false, reason: `SearchAtlas didn't respond within ${TIMEOUT_MS / 1000}s. Try again — if it keeps happening, check the provider's status page.` };
    }
    return { ok: false, reason: `Couldn't reach SearchAtlas: ${err instanceof Error ? err.message : String(err)}` };
  }
};

export const VERIFIERS: Partial<Record<string, KeyVerifier>> = {
  SEARCH_ATLAS: searchAtlas,
};

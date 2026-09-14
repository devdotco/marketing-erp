import type { KeyVerifier } from "./types";

/** Every verifier here makes exactly one free, read-only call — never a search,
 * enrich, or send — so saving a key never spends the customer's credits or
 * touches their campaigns. 10s covers a slow upstream without hanging the
 * connect form indefinitely. */
const TIMEOUT_MS = 10_000;

/**
 * Apollo.io. `auth/health` is documented as a free call that just confirms the
 * key authenticates — unlike `mixed_people/api_search` (needs a Master Key) or
 * `people/match` (costs a credit), so it can't tell us the key has search
 * access. Outbound Scout's own error message covers that gap when it happens.
 */
const verifyApollo: KeyVerifier = async (credentials) => {
  const apiKey = credentials.apiKey?.trim();
  if (!apiKey) return { ok: false, reason: "The API key is empty." };

  let res: Response;
  try {
    res = await fetch("https://api.apollo.io/api/v1/auth/health", {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: `Couldn't reach Apollo.io: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "Apollo rejected that key. Check it was copied whole and has not been revoked." };
  }
  if (!res.ok) {
    return { ok: false, reason: `Apollo returned an unexpected error (${res.status}). Try again in a moment.` };
  }
  return { ok: true };
};

/**
 * Instantly v2. Listing campaigns costs nothing and needs no campaign to
 * exist — an empty array is still a 200. v1 keys are rejected outright by v2
 * endpoints, which is exactly the mistake this exists to catch before a
 * campaign send fails on it.
 */
const verifyInstantly: KeyVerifier = async (credentials) => {
  const apiKey = credentials.apiKey?.trim();
  if (!apiKey) return { ok: false, reason: "The API key is empty." };

  let res: Response;
  try {
    res = await fetch("https://api.instantly.ai/api/v2/campaigns?limit=1", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: `Couldn't reach Instantly: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      reason: "Instantly rejected that key. It must be a v2 key from Settings → Integrations → API Keys (v1 keys don't work here), and v2 access needs Instantly's Growth plan or higher.",
    };
  }
  if (!res.ok) {
    return { ok: false, reason: `Instantly returned an unexpected error (${res.status}). Try again in a moment.` };
  }
  return { ok: true };
};

/** Aimfox. `/accounts` lists the LinkedIn seats on the workspace — read-only,
 * no campaign or lead required, works even for a Read-only-permission key. */
const verifyAimfox: KeyVerifier = async (credentials) => {
  const apiKey = credentials.apiKey?.trim();
  if (!apiKey) return { ok: false, reason: "The API key is empty." };

  let res: Response;
  try {
    res = await fetch("https://api.aimfox.com/api/v2/accounts", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: `Couldn't reach Aimfox: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "Aimfox rejected that key. Check it was copied whole and has not been revoked." };
  }
  if (!res.ok) {
    return { ok: false, reason: `Aimfox returned an unexpected error (${res.status}). Try again in a moment.` };
  }
  return { ok: true };
};

/**
 * GoHighLevel v2. `GET /locations/{locationId}` proves both halves of what
 * this integration needs in one call: the token authenticates, AND it can see
 * the specific sub-account the location ID names — a token valid for a
 * different location in the same agency would otherwise look fine right up
 * until the first contact write 403s.
 */
const verifyGoHighLevel: KeyVerifier = async (credentials) => {
  const apiKey = credentials.apiKey?.trim();
  const locationId = credentials.locationId?.trim();
  if (!apiKey) return { ok: false, reason: "The private integration token is empty." };
  if (!locationId) return { ok: false, reason: "The location ID is empty." };

  let res: Response;
  try {
    res = await fetch(`https://services.leadconnectorhq.com/locations/${encodeURIComponent(locationId)}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: "2021-07-28",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: `Couldn't reach GoHighLevel: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      reason: "GoHighLevel rejected that token, or the token isn't authorised for this location ID. Both come from Settings → Private Integrations / Business Profile in the same sub-account.",
    };
  }
  if (res.status === 404) {
    return { ok: false, reason: "GoHighLevel couldn't find a location with that ID. Check Settings → Business Profile in the sub-account you want to connect." };
  }
  if (!res.ok) {
    return { ok: false, reason: `GoHighLevel returned an unexpected error (${res.status}). Try again in a moment.` };
  }
  return { ok: true };
};

export const VERIFIERS: Partial<Record<string, KeyVerifier>> = {
  APOLLO: verifyApollo,
  INSTANTLY: verifyInstantly,
  AIMFOX: verifyAimfox,
  GO_HIGH_LEVEL: verifyGoHighLevel,
};

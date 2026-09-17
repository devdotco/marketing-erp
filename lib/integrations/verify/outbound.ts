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

export const VERIFIERS: Partial<Record<string, KeyVerifier>> = {
  APOLLO: verifyApollo,
  INSTANTLY: verifyInstantly,
  AIMFOX: verifyAimfox,
};

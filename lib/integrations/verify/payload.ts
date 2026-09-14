import type { KeyVerifier } from "./types";
import { assertPublicUrl } from "@/lib/integrations/public-url";
import { payloadHeaders } from "@/lib/integrations/payload";

/**
 * One cheap, read-only call — list the posts collection with limit=1 (and the
 * tenant filter, when set) — that proves the base URL, auth collection, posts
 * collection and API key all actually line up before the key is stored.
 *
 * payload.dev.co (our own instance) sits behind Cloudflare, which 403s
 * "error code: 1010" for requests that don't look like a browser — this sends
 * a normal User-Agent (via payloadHeaders) to avoid tripping that for our own
 * tenants, and to be safe against any customer's Payload behind a similar edge.
 */

const TIMEOUT_MS = 10_000;

const payload: KeyVerifier = async (credentials) => {
  const postsCollection = credentials.postsCollection || "posts";
  try {
    try {
      await assertPublicUrl(credentials.baseUrl);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }

    const params = new URLSearchParams({ limit: "1", depth: "0" });
    if (credentials.tenantId) params.set("where[tenant][equals]", credentials.tenantId);

    const res = await fetch(`${credentials.baseUrl}/api/${postsCollection}?${params.toString()}`, {
      headers: payloadHeaders({
        authCollection: credentials.authCollection || "users",
        apiKey: credentials.apiKey,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.status === 401) {
      return {
        ok: false,
        reason: "Payload rejected that API key — check it was copied whole and hasn't been revoked, and that the Auth collection slug matches the collection it was generated on (default: users).",
      };
    }
    if (res.status === 403) {
      const text = await res.text().catch(() => "");
      if (text.includes("1010")) {
        return { ok: false, reason: "Payload's edge network blocked this request as non-browser traffic (Cloudflare error 1010). This should not normally happen — try again, and contact the site owner if it persists." };
      }
      return { ok: false, reason: "Payload accepted the key but refused this request — it may lack read access to that collection, or the Tenant ID may be wrong." };
    }
    if (res.status === 404) {
      return { ok: false, reason: `Payload couldn't find a "${postsCollection}" collection at that Base URL — check the Posts collection slug.` };
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return { ok: false, reason: "That URL didn't return JSON from the Payload API — check the Base URL points at the Payload instance itself, not a proxy or the marketing site in front of it." };
    }
    if (!res.ok) {
      return { ok: false, reason: `Payload returned ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { ok: false, reason: `Payload didn't respond within ${TIMEOUT_MS / 1000}s. Try again — if it keeps happening, check the Base URL.` };
    }
    return { ok: false, reason: `Couldn't reach Payload: ${err instanceof Error ? err.message : String(err)}` };
  }
};

export const VERIFIERS: Partial<Record<string, KeyVerifier>> = {
  PAYLOAD: payload,
};

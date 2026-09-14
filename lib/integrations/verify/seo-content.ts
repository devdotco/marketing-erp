import type { KeyVerifier } from "./types";
import { assertPublicUrl } from "@/lib/integrations/public-url";
import { storyblokManagementBase } from "@/lib/integrations/catalog";

/**
 * One cheap, read-only call per provider that proves the stored credential
 * actually works — so a bad key/URL/ID fails at connect time as a form error
 * instead of at run time as a mysteriously "simulated" agent output (or,
 * worse, a silently-fabricated one — see the handlers in lib/agent-handlers
 * for why that distinction matters here).
 */

const TIMEOUT_MS = 10_000;

function networkErrorReason(provider: string, err: unknown): string {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return `${provider} didn't respond within ${TIMEOUT_MS / 1000}s. Try again — if it keeps happening, check the provider's status page.`;
  }
  return `Couldn't reach ${provider}: ${err instanceof Error ? err.message : String(err)}`;
}

const ahrefs: KeyVerifier = async (credentials) => {
  try {
    // Free endpoint — 0 API units — documented specifically as safe to poll.
    // https://docs.ahrefs.com/en/api/reference/subscription-info/get-limits-and-usage
    const res = await fetch("https://api.ahrefs.com/v3/subscription-info/limits-and-usage", {
      headers: { Authorization: `Bearer ${credentials.apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "Ahrefs rejected that API key — check it was copied whole and hasn't expired (keys expire after 1 year)." };
    }
    if (!res.ok) {
      return { ok: false, reason: `Ahrefs returned ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: networkErrorReason("Ahrefs", err) };
  }
};

const semrush: KeyVerifier = async (credentials) => {
  try {
    // 0-unit balance check — https://developer.semrush.com/api/v4/get-started/api-units-balance/
    const res = await fetch(
      `https://www.semrush.com/users/countapiunits.html?key=${encodeURIComponent(credentials.apiKey)}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    const text = (await res.text()).trim();
    if (!res.ok || text.startsWith("ERROR")) {
      return { ok: false, reason: `Semrush rejected that key: ${text.slice(0, 200) || res.status}` };
    }
    if (!/^\d+$/.test(text)) {
      return { ok: false, reason: `Semrush returned an unexpected response: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: networkErrorReason("Semrush", err) };
  }
};

const wordpress: KeyVerifier = async (credentials) => {
  try {
    // The server fetches this customer-typed URL with their credentials — never
    // let it point inward. See lib/integrations/public-url.ts.
    try {
      await assertPublicUrl(credentials.siteUrl);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
    const res = await fetch(`${credentials.siteUrl}/wp-json/wp/v2/users/me`, {
      redirect: "error",
      headers: { Authorization: "Basic " + Buffer.from(`${credentials.username}:${credentials.applicationPassword}`).toString("base64") },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) {
      return { ok: false, reason: "WordPress rejected those credentials — check the username and the application password (Users → Profile → Application Passwords; not your login password)." };
    }
    if (res.status === 403) {
      return { ok: false, reason: "WordPress accepted the credentials but refused this request — a security plugin (Wordfence, iThemes Security, etc.) may be blocking the REST API." };
    }
    if (res.status === 404) {
      return { ok: false, reason: "No WordPress REST API found at that URL (404). Check the Site URL, and that a plugin hasn't disabled the REST API." };
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return { ok: false, reason: "That URL didn't return JSON from wp-json — likely a firewall, caching layer, or security plugin stripping the request before it reaches WordPress." };
    }
    if (!res.ok) {
      return { ok: false, reason: `WordPress returned ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    const user = await res.json() as { capabilities?: Record<string, boolean> };
    if (user.capabilities && user.capabilities.publish_posts === false) {
      return { ok: false, reason: "That WordPress user can't publish posts — use an account with at least the Author role." };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: networkErrorReason("WordPress", err) };
  }
};

const storyblok: KeyVerifier = async (credentials) => {
  try {
    const base = storyblokManagementBase(credentials.region || "eu");
    const res = await fetch(`${base}/spaces/${encodeURIComponent(credentials.spaceId)}`, {
      // Personal access tokens go in Authorization as-is — no "Bearer " prefix.
      headers: { Authorization: credentials.managementToken },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) {
      return { ok: false, reason: "Storyblok rejected that personal access token — check it was copied whole and hasn't been revoked." };
    }
    if (res.status === 404) {
      return { ok: false, reason: "Storyblok couldn't find that Space ID — check it, and check the Region matches where the space was created." };
    }
    if (!res.ok) {
      return { ok: false, reason: `Storyblok returned ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: networkErrorReason("Storyblok", err) };
  }
};

const webflow: KeyVerifier = async (credentials) => {
  try {
    const headers = { Authorization: `Bearer ${credentials.apiToken}` };
    const siteRes = await fetch(`https://api.webflow.com/v2/sites/${encodeURIComponent(credentials.siteId)}`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (siteRes.status === 401) {
      return { ok: false, reason: "Webflow rejected that API token — check it was copied whole and hasn't been revoked." };
    }
    if (siteRes.status === 404) {
      return { ok: false, reason: "Webflow couldn't find that Site ID, or this token doesn't have access to it (needs the sites:read scope)." };
    }
    if (!siteRes.ok) {
      return { ok: false, reason: `Webflow returned ${siteRes.status} for that Site ID: ${(await siteRes.text()).slice(0, 200)}` };
    }

    const collectionRes = await fetch(`https://api.webflow.com/v2/collections/${encodeURIComponent(credentials.collectionId)}`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (collectionRes.status === 404) {
      return { ok: false, reason: "Webflow couldn't find that Collection ID, or this token doesn't have access to it (needs the cms:read/cms:write scopes)." };
    }
    if (!collectionRes.ok) {
      return { ok: false, reason: `Webflow returned ${collectionRes.status} for that Collection ID: ${(await collectionRes.text()).slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: networkErrorReason("Webflow", err) };
  }
};

const mailchimp: KeyVerifier = async (credentials) => {
  try {
    const res = await fetch(`https://${credentials.server}.api.mailchimp.com/3.0/ping`, {
      headers: { Authorization: "Basic " + Buffer.from(`anystring:${credentials.apiKey}`).toString("base64") },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) {
      return { ok: false, reason: "Mailchimp rejected that API key — check it was copied whole and hasn't been regenerated." };
    }
    if (!res.ok) {
      return { ok: false, reason: `Mailchimp returned ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: networkErrorReason("Mailchimp", err) };
  }
};

const klaviyo: KeyVerifier = async (credentials) => {
  try {
    const res = await fetch("https://a.klaviyo.com/api/accounts/", {
      headers: {
        Authorization: `Klaviyo-API-Key ${credentials.apiKey}`,
        revision: "2025-04-15",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "Klaviyo rejected that private API key — check it was copied whole and has Campaigns read/write access." };
    }
    if (!res.ok) {
      return { ok: false, reason: `Klaviyo returned ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: networkErrorReason("Klaviyo", err) };
  }
};

const cartesia: KeyVerifier = async (credentials) => {
  try {
    const res = await fetch("https://api.cartesia.ai/voices?limit=1", {
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        "Cartesia-Version": "2025-04-16",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) {
      return { ok: false, reason: "Cartesia rejected that API key — check it was copied whole and hasn't been revoked." };
    }
    if (!res.ok) {
      return { ok: false, reason: `Cartesia returned ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: networkErrorReason("Cartesia", err) };
  }
};

const transistor: KeyVerifier = async (credentials) => {
  try {
    const res = await fetch("https://api.transistor.fm/v1/shows?pagination[per]=1", {
      headers: { "x-api-key": credentials.apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "Transistor rejected that API key — check Account → API Key and that it was copied whole." };
    }
    if (!res.ok) {
      return { ok: false, reason: `Transistor returned ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    const data = await res.json() as { data?: unknown[] };
    if (!data.data || data.data.length === 0) {
      return { ok: false, reason: "That key works, but this Transistor account has no shows yet — create one in Transistor first so Podcast has somewhere to publish episodes." };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: networkErrorReason("Transistor", err) };
  }
};

export const VERIFIERS: Partial<Record<string, KeyVerifier>> = {
  AHREFS: ahrefs,
  SEMRUSH: semrush,
  WORDPRESS: wordpress,
  STORYBLOK: storyblok,
  WEBFLOW: webflow,
  MAILCHIMP: mailchimp,
  KLAVIYO: klaviyo,
  CARTESIA: cartesia,
  TRANSISTOR: transistor,
};

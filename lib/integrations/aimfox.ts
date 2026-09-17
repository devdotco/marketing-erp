/**
 * Aimfox API (api.aimfox.com/api/v2, Bearer key) — the raw HTTP calls shared by any agent that
 * sends LinkedIn engagement through a connected Aimfox seat. Did not exist before LinkedIn
 * Engager (lib/agent-handlers/linkedin-engager.ts): Outbound LinkedIn
 * (lib/agent-handlers/outbound-linkedin-delivery.ts) has its own inline `fetch` calls for the one
 * endpoint it needs (POST /campaigns/{id}/audience) and was mid-edit by a concurrent task when
 * this file was created, so those calls were deliberately left as-is rather than refactored onto
 * this client — see the LinkedIn Engager task report for that note. A future pass could
 * consolidate both onto this file.
 *
 * Endpoint inventory below is what api.aimfox.com/api/v2 documents at docs.aimfox.com (fetched via
 * a JS-rendering proxy on 2026-09-14, since the docs site itself serves an empty shell to a plain
 * fetch) and cross-checked against Aimfox's own n8n node, which lists the same resources. The
 * request BODY shape for the two conversation endpoints was not visible in what could be fetched
 * (the rendered page truncated before their schema), so `startAimfoxConversation` and
 * `sendAimfoxMessage` take a `Record<string, unknown>` body the caller assembles — treat the field
 * names used in lib/agent-handlers/linkedin-engager-delivery.ts as a best-effort guess (mirrored
 * off the one Aimfox body shape this codebase HAS confirmed working, the campaign-audience add's
 * `profile_url`), not a verified contract. No live call has been made against them — see the task
 * report.
 *
 * Confirmed NOT to exist anywhere in Aimfox's API: reading a LinkedIn post, liking a post, or
 * commenting on a post. Aimfox is an outreach-automation tool (connection requests + DM sequences
 * driven off Campaigns, plus ad-hoc messaging on top of Conversations) — it has no surface at all
 * for the engagement-with-a-feed-post use case. Anything in this codebase that drafts a comment or
 * a like is a manual, copy-and-post action for that reason, never a call through this file.
 *
 * Rate limit: 60 requests/minute across all endpoints, any key. A 429 means stop, not retry
 * immediately — see lib/agent-handlers/linkedin-engager-delivery.ts's batch executor.
 *
 * No removeAimfoxCampaignAudience / pauseAimfoxLead export exists here on purpose (2026-09-17,
 * checked for lib/webhooks/outbound-pause.ts's "stop on positive signal" feature). A "Remove
 * Profile From Campaign" action DOES exist in Aimfox's product surface — it's listed as a Campaign
 * operation (alongside Add Profile to Campaign, Pause, Resume) in Aimfox's own official n8n
 * integration node ("built and maintained by Aimfox partners and verified by n8n" —
 * help.aimfox.com/en/articles/13859154-aimfox-x-n8n-integration), and Aimfox's Make.com app lists
 * a separate "Pause a Campaign" / "Resume a Campaign" pair (whole-campaign, not per-lead —
 * apps.make.com/aimfox). So a per-lead removal almost certainly has a real REST endpoint behind
 * it. But docs.aimfox.com serves a JS-rendered empty shell to a plain, unauthenticated fetch (same
 * problem the header above already notes for the conversation endpoints), and neither the n8n node
 * listing nor the Make app page exposes the underlying HTTP method/path/body — only the product
 * label. Per this task's own instruction not to guess an endpoint, this file adds no function for
 * it. lib/webhooks/outbound-pause.ts records "cannot pause Aimfox" as a known limitation instead
 * of fabricating a call. Whoever next has authenticated access to docs.aimfox.com (or Aimfox
 * support) should confirm the real contract and fill this in — likely `DELETE
 * /campaigns/{id}/audience` mirroring addAimfoxCampaignAudience's `POST`, but that is a guess and
 * must be verified before use.
 *
 * Every function does exactly one HTTP call and returns the parsed body or throws a plain `Error`
 * (message prefixed `http_<status>:` on a non-2xx response, `unreachable:` on a network failure) —
 * callers build their own `AgentInputError` with context, matching lib/integrations/apollo.ts.
 */

const AIMFOX_API_BASE = "https://api.aimfox.com/api/v2";
const TIMEOUT_MS = 15_000;

export class AimfoxApiError extends Error {
  readonly status: number;
  readonly rateLimited: boolean;

  constructor(status: number, detail: string) {
    super(`http_${status}: ${detail.slice(0, 300)}`);
    this.name = "AimfoxApiError";
    this.status = status;
    this.rateLimited = status === 429;
  }
}

function aimfoxHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function aimfoxFetch(path: string, apiKey: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${AIMFOX_API_BASE}${path}`, {
      ...init,
      headers: { ...aimfoxHeaders(apiKey), ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Parses a non-2xx Aimfox response into an `AimfoxApiError`, so every caller gets the same
 * `.status` / `.rateLimited` fields instead of regexing a message string. */
async function throwOnError(res: Response): Promise<void> {
  if (res.ok) return;
  const detail = await res.text().catch(() => "");
  throw new AimfoxApiError(res.status, detail);
}

export interface AimfoxAccount {
  id: string;
  name?: string;
  [key: string]: unknown;
}

/** GET /accounts — the LinkedIn seats on this workspace. Free, read-only; the same call
 * lib/integrations/verify/outbound.ts uses to verify a key on connect, and what LinkedIn Engager
 * validates its configured sending account against while staging (before any approval). */
export async function listAimfoxAccounts(apiKey: string): Promise<AimfoxAccount[]> {
  const res = await aimfoxFetch("/accounts", apiKey, { method: "GET" });
  await throwOnError(res);
  const body = (await res.json().catch(() => ({}))) as { items?: AimfoxAccount[]; data?: AimfoxAccount[] };
  return body.items ?? body.data ?? [];
}

export interface AimfoxCampaign {
  id: string;
  name: string;
  [key: string]: unknown;
}

/** GET /campaigns — read-only lookup, used to resolve a campaign by name before staging a
 * connection-request action (Aimfox only sends connection requests through a Campaign's
 * audience — see addAimfoxCampaignAudience below). Mirrors the same call already made by
 * lib/agent-handlers/outbound-linkedin.ts's resolveAimfoxCampaignId. */
export async function listAimfoxCampaigns(apiKey: string): Promise<AimfoxCampaign[]> {
  const res = await aimfoxFetch("/campaigns", apiKey, { method: "GET" });
  await throwOnError(res);
  const body = (await res.json().catch(() => ({}))) as { items?: AimfoxCampaign[]; data?: AimfoxCampaign[] };
  return body.items ?? body.data ?? [];
}

/** POST /campaigns/{id}/audience — the only way Aimfox's API sends a connection request. Adding a
 * profile here is not inert: Aimfox's own automation picks it up and sends the request (with the
 * note carried in `custom_variables`, per the shape this codebase already assumes in
 * lib/agent-handlers/outbound-linkedin-delivery.ts) on its own schedule from the seat behind the
 * campaign. Only ever call this after approval. */
export async function addAimfoxCampaignAudience(
  apiKey: string,
  campaignId: string,
  body: Record<string, unknown>,
): Promise<{ id?: string }> {
  const res = await aimfoxFetch(`/campaigns/${encodeURIComponent(campaignId)}/audience`, apiKey, {
    method: "POST",
    body: JSON.stringify(body),
  });
  await throwOnError(res);
  return (await res.json().catch(() => ({}))) as { id?: string };
}

/** POST /accounts/{account_id}/conversations — opens a new thread with a lead and sends the first
 * message in it, independent of any campaign. Body shape is the unverified part of this file — see
 * the header comment. Only ever call this after approval. */
export async function startAimfoxConversation(
  apiKey: string,
  accountId: string,
  body: Record<string, unknown>,
): Promise<{ id?: string; conversation_urn?: string }> {
  const res = await aimfoxFetch(`/accounts/${encodeURIComponent(accountId)}/conversations`, apiKey, {
    method: "POST",
    body: JSON.stringify(body),
  });
  await throwOnError(res);
  return (await res.json().catch(() => ({}))) as { id?: string; conversation_urn?: string };
}

/** POST /accounts/{account_id}/conversations/{conversation_urn} — sends a message into an existing
 * thread. Body shape is the unverified part of this file — see the header comment. Only ever call
 * this after approval. */
export async function sendAimfoxMessage(
  apiKey: string,
  accountId: string,
  conversationUrn: string,
  body: Record<string, unknown>,
): Promise<{ id?: string }> {
  const res = await aimfoxFetch(
    `/accounts/${encodeURIComponent(accountId)}/conversations/${encodeURIComponent(conversationUrn)}`,
    apiKey,
    { method: "POST", body: JSON.stringify(body) },
  );
  await throwOnError(res);
  return (await res.json().catch(() => ({}))) as { id?: string };
}

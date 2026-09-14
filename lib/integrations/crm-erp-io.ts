/**
 * erp.io CRM (app.erp.io/crm) — the raw HTTP calls the Email Marketing agent's CRM channel
 * makes. Auth is a per-tenant API key created in the CRM (Settings → API Keys, or the
 * `marketing:create-key` script there until that UI ships) — see lib/integrations/catalog.ts
 * (CRM_ERP_IO) and ~/Projects/crm-erp-io/src/lib/crm/marketing-api-keys.ts on the CRM side.
 *
 * The CRM moved from crm.erp.io to app.erp.io/crm — crm.erp.io now 308s and
 * "crm.erp.io/crm/..." 404s, so the default below is the new host with the /crm path already
 * included, matching what the API routes actually resolve to.
 */

import { assertPublicUrl } from "./public-url";

export const DEFAULT_CRM_URL = "https://app.erp.io/crm";

const TIMEOUT_MS = 15_000;

function crmHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function crmFetch(baseUrl: string, path: string, apiKey: string, init?: RequestInit): Promise<Response> {
  // Re-checked on every call, not only when the URL was saved: DNS can point a once-public host
  // somewhere private months later, and this request carries the workspace's API key.
  await assertPublicUrl(baseUrl);
  try {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...crmHeaders(apiKey), ...(init?.headers ?? {}) },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** GET /api/marketing-erp/ping — the one free, read-only call the connect-form verifier uses. */
export async function crmPing(baseUrl: string, apiKey: string): Promise<Response> {
  return crmFetch(baseUrl, "/api/marketing-erp/ping", apiKey, { method: "GET" });
}

export interface CrmSequenceStep {
  subject: string;
  body: string;
  delayDays?: number;
}

/** POST /api/marketing-erp/sequences — stages a DRAFT sequence with these steps. The CRM refuses
 * to create anything but DRAFT here (see crm-erp-io's sequence-admin.ts) — nothing sends until
 * the activate call below runs, which only ever happens on approval. */
export async function crmCreateSequence(
  baseUrl: string,
  apiKey: string,
  input: { name: string; fromAddress?: string; fromName?: string; steps: CrmSequenceStep[] },
): Promise<Response> {
  return crmFetch(baseUrl, "/api/marketing-erp/sequences", apiKey, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** POST /api/marketing-erp/sequences/:id/activate — flips the sequence DRAFT → ACTIVE and
 * enrolls every person in the given ContactSegment. This is the send-triggering call; only ever
 * call it from an approval path. Idempotent on the CRM side (activation re-validates and
 * re-applies the same status; enrollment upserts on (sequenceId, personId)) — see that route's
 * own comment for why a retried or duplicated call here is safe. */
export async function crmActivateSequence(
  baseUrl: string,
  apiKey: string,
  sequenceId: string,
  segmentId: string,
): Promise<Response> {
  return crmFetch(baseUrl, `/api/marketing-erp/sequences/${encodeURIComponent(sequenceId)}/activate`, apiKey, {
    method: "POST",
    body: JSON.stringify({ segmentId }),
  });
}

/**
 * erp.io CRM (app.erp.io/crm) — the raw HTTP calls the Email Marketing agent's CRM channel makes.
 *
 * Two ways to authenticate, chosen by lib/integrations/crm-connection.ts, never by a caller:
 *
 *   - `service` (the normal path): a per-request Ed25519 assertion signed by this app, naming the
 *     workspace's shell organization. The CRM resolves the tenant from that verified org alone, so
 *     a workspace reaches exactly its own org's CRM workspace and nobody pastes anything.
 *   - `key` (super-admin fallback for a workspace with no shell org): a per-tenant API key created
 *     in the CRM. See crm-erp-io src/lib/crm/marketing-api-keys.ts.
 *
 * The CRM moved from crm.erp.io to app.erp.io/crm — crm.erp.io now 308s and "crm.erp.io/crm/..."
 * 404s, so the default below is the new host with the /crm path already included.
 */

import { assertPublicUrl } from "./public-url";
import { signCrmAssertion } from "./service-assertion";

export const DEFAULT_CRM_URL = "https://app.erp.io/crm";

const TIMEOUT_MS = 15_000;

export type CrmAuth = { kind: "service"; shellOrgId: string } | { kind: "key"; apiKey: string };
export type CrmTarget = {
  baseUrl: string;
  auth: CrmAuth;
  timeoutMs?: number;
  /**
   * A workspace's stored per-tenant key, kept as a fallback while the signed path
   * rolls out: if the CRM answers 401 to the signed assertion (its
   * MARKETING_SERVICE_PUBLIC_KEY not deployed yet), the call is retried once with
   * the key, so deploying Marketing first cannot break Email Marketing delivery.
   */
  fallbackKey?: string;
};

/** Pure: whether a signed call that got `status` should be retried with the stored key. */
export function shouldRetryWithKey(status: number, target: CrmTarget): boolean {
  return status === 401 && target.auth.kind === "service" && !!target.fallbackKey;
}

async function crmFetch(target: CrmTarget, path: string, init: { method: "GET" | "POST"; body?: string }): Promise<Response> {
  const res = await crmFetchOnce(target, path, init);
  if (!shouldRetryWithKey(res.status, target)) return res;
  console.warn("[crm-erp-io] signed assertion refused (401) — retrying with the stored key; deploy MARKETING_SERVICE_PUBLIC_KEY on the CRM");
  return crmFetchOnce({ ...target, auth: { kind: "key", apiKey: target.fallbackKey! }, fallbackKey: undefined }, path, init);
}

async function crmFetchOnce(target: CrmTarget, path: string, init: { method: "GET" | "POST"; body?: string }): Promise<Response> {
  // Re-checked on every call, not only when the URL was saved: DNS can point a once-public host
  // somewhere private months later, and this request carries a credential.
  await assertPublicUrl(target.baseUrl);
  const body = init.body ?? "";
  const authorization = target.auth.kind === "key"
    ? `Bearer ${target.auth.apiKey}`
    // Signed per request and bound to exactly this method, path and body.
    : `ErpService ${await signCrmAssertion({ shellOrgId: target.auth.shellOrgId, method: init.method, path, body })}`;
  try {
    return await fetch(`${target.baseUrl}${path}`, {
      method: init.method,
      body: init.method === "GET" ? undefined : body,
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(target.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** GET /api/marketing-erp/ping — free and read-only; answers with the CRM workspace's name. */
export async function crmPing(target: CrmTarget): Promise<Response> {
  return crmFetch(target, "/api/marketing-erp/ping", { method: "GET" });
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
  target: CrmTarget,
  input: { name: string; fromAddress?: string; fromName?: string; steps: CrmSequenceStep[] },
): Promise<Response> {
  return crmFetch(target, "/api/marketing-erp/sequences", { method: "POST", body: JSON.stringify(input) });
}

/** POST /api/marketing-erp/sequences/:id/activate — flips the sequence DRAFT → ACTIVE and
 * enrolls every person in the given ContactSegment. This is the send-triggering call; only ever
 * call it from an approval path. Idempotent on the CRM side (activation re-validates and
 * re-applies the same status; enrollment upserts on (sequenceId, personId)) — see that route's
 * own comment for why a retried or duplicated call here is safe. */
export async function crmActivateSequence(target: CrmTarget, sequenceId: string, segmentId: string): Promise<Response> {
  return crmFetch(target, `/api/marketing-erp/sequences/${encodeURIComponent(sequenceId)}/activate`, {
    method: "POST",
    body: JSON.stringify({ segmentId }),
  });
}

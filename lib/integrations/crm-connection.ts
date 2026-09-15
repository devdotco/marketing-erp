import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { DEFAULT_CRM_URL, crmPing, type CrmTarget } from "./crm-erp-io";
import { serviceSigningConfigured } from "./service-assertion";

/**
 * How a workspace reaches the erp.io CRM — decided here, once, for every caller
 * (the Email Marketing run, its approval, the Integrations page).
 *
 * The rule, in order:
 *   1. The workspace belongs to a shell org and this server can sign → SERVICE.
 *      Automatic: the mirror guarantees that org has a CRM workspace, and the CRM
 *      resolves it from the signed org. A legacy key row, if any, is ignored.
 *   2. A legacy pasted key exists → KEY. Only super admins can add one (see
 *      app/api/integrations/connect), and it exists for a workspace with no org,
 *      or to keep a key-connected workspace working across the deploy.
 *   3. Otherwise not connected, with the reason a person can act on.
 *
 * The service base URL comes from this server's environment (`CRM_URL`), never
 * from anything a workspace typed: a signed org assertion goes only to the CRM
 * we run.
 */

export type CrmConnection =
  | { ok: true; via: "service"; target: CrmTarget }
  | { ok: true; via: "key"; target: CrmTarget }
  | { ok: false; code: "no_org" | "service_unconfigured"; reason: string };

export function crmServiceBaseUrl(): string {
  return (process.env.CRM_URL || DEFAULT_CRM_URL).replace(/\/+$/, "");
}

/** Pure: the decision above, from what is known about the workspace and this server. */
export function chooseCrmConnection(input: {
  shellOrgId: string | null | undefined;
  serviceConfigured: boolean;
  legacy: { apiKey: string; crmUrl?: string } | null;
  serviceBaseUrl: string;
}): CrmConnection {
  const org = input.shellOrgId?.trim();
  if (org && input.serviceConfigured) {
    return {
      ok: true,
      via: "service",
      target: {
        baseUrl: input.serviceBaseUrl,
        auth: { kind: "service", shellOrgId: org },
        // Rollout safety: a stored key is retried once if the CRM refuses the
        // signature. Always sent to this server's CRM_URL, never the stored URL.
        ...(input.legacy?.apiKey ? { fallbackKey: input.legacy.apiKey } : {}),
      },
    };
  }
  if (input.legacy?.apiKey) {
    return { ok: true, via: "key", target: { baseUrl: input.legacy.crmUrl || DEFAULT_CRM_URL, auth: { kind: "key", apiKey: input.legacy.apiKey } } };
  }
  if (org) {
    return { ok: false, code: "service_unconfigured", reason: "this server has no CRM signing key (MARKETING_SERVICE_PRIVATE_KEY), so it cannot call the CRM for this workspace." };
  }
  return { ok: false, code: "no_org", reason: "this workspace is not tied to an erp.io organization, so it has no CRM workspace." };
}

export async function resolveCrmConnection(workspaceId: string): Promise<CrmConnection> {
  const [workspace, integration] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { shellOrgId: true } }),
    prisma.integration.findUnique({ where: { workspaceId_provider: { workspaceId, provider: "CRM_ERP_IO" } } }),
  ]);
  const legacy = integration
    ? await decryptCredentials<{ apiKey: string; crmUrl?: string }>(integration.encryptedCredentials).catch(() => null)
    : null;
  return chooseCrmConnection({
    shellOrgId: workspace?.shellOrgId,
    serviceConfigured: serviceSigningConfigured(),
    legacy,
    serviceBaseUrl: crmServiceBaseUrl(),
  });
}

export type CrmLinkStatus =
  | { linked: true; via: "service" | "key"; crmWorkspace: string }
  | { linked: false; reason: string };

/**
 * What the Integrations page says about the CRM: "Linked to <CRM workspace>",
 * or why not. One cheap, read-only ping with a short timeout — this renders in a
 * page, and a slow CRM must not make the page slow.
 */
const LINK_STATUS_TTL_MS = 5 * 60 * 1000;
const linkStatusCache = new Map<string, { at: number; value: CrmLinkStatus; refreshing?: boolean }>();

/**
 * Cached per workspace and connection for five minutes. The ping blocked the
 * Integrations page for up to its timeout and wrote a replay receipt in the CRM
 * on every render; now a stale answer is served at once and refreshed in the
 * background, and only a first visit waits (at most 2s).
 */
export async function crmLinkStatus(workspaceId: string, now = Date.now()): Promise<CrmLinkStatus> {
  const connection = await resolveCrmConnection(workspaceId);
  if (!connection.ok) return { linked: false, reason: capitalise(connection.reason) };

  const auth = connection.target.auth;
  const cacheKey = `${workspaceId}:${connection.via}:${auth.kind === "service" ? auth.shellOrgId : "key"}`;
  const hit = linkStatusCache.get(cacheKey);
  if (hit && now - hit.at < LINK_STATUS_TTL_MS) return hit.value;
  if (hit && !hit.refreshing) {
    hit.refreshing = true;
    void pingLinkStatus(connection)
      .then((value) => linkStatusCache.set(cacheKey, { at: Date.now(), value }))
      .catch(() => { hit.refreshing = false; });
    return hit.value;
  }
  const value = await pingLinkStatus(connection);
  linkStatusCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

async function pingLinkStatus(connection: Extract<CrmConnection, { ok: true }>): Promise<CrmLinkStatus> {
  let res: Response;
  try {
    res = await crmPing({ ...connection.target, timeoutMs: 2_000 });
  } catch {
    return { linked: false, reason: "Couldn't reach the CRM just now. Campaigns will retry when they run." };
  }
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { tenant?: string };
    return { linked: true, via: connection.via, crmWorkspace: body.tenant ?? "your CRM workspace" };
  }
  const code = ((await res.json().catch(() => ({}))) as { code?: string }).code;
  if (res.status === 404 && code === "no_linked_crm_workspace") {
    return { linked: false, reason: "This organization's CRM workspace hasn't been created yet. It is created automatically — check again in a few minutes." };
  }
  if (res.status === 401) {
    return {
      linked: false,
      reason: connection.via === "service"
        ? "The CRM didn't accept this server's signature. MARKETING_SERVICE_PUBLIC_KEY on the CRM must match this server's key."
        : "The CRM rejected the stored API key. It may have been revoked.",
    };
  }
  return { linked: false, reason: `The CRM answered ${res.status}.` };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

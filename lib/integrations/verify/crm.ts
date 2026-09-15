import type { KeyVerifier } from "./types";
import { assertPublicUrl } from "@/lib/integrations/public-url";
import { crmPing, DEFAULT_CRM_URL } from "@/lib/integrations/crm-erp-io";

/**
 * erp.io CRM — the LEGACY pasted-key path only. A workspace tied to an erp.io organization never
 * needs this: it reaches its CRM workspace with a signed service assertion (see
 * lib/integrations/crm-connection.ts). `GET /api/marketing-erp/ping` is free and read-only.
 */
const verifyCrmErpIo: KeyVerifier = async (credentials) => {
  const apiKey = credentials.apiKey?.trim();
  if (!apiKey) return { ok: false, reason: "The API key is empty." };

  const baseUrl = credentials.crmUrl?.trim() || DEFAULT_CRM_URL;
  try {
    await assertPublicUrl(baseUrl);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  let res: Response;
  try {
    res = await crmPing({ baseUrl, auth: { kind: "key", apiKey } });
  } catch (err) {
    return { ok: false, reason: `Couldn't reach the erp.io CRM at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      reason: "The CRM rejected that key. Check it was copied whole and has not been revoked — create a new one from the CRM with `npm run marketing:create-key` (Settings → API Keys, once that UI ships) if needed.",
    };
  }
  if (res.status === 404) {
    return { ok: false, reason: `No marketing-erp endpoint found at ${baseUrl} — check the CRM URL. It should point at the CRM instance itself (default https://app.erp.io/crm), not a proxy in front of it.` };
  }
  if (!res.ok) {
    return { ok: false, reason: `The CRM returned an unexpected error (${res.status}). Try again in a moment.` };
  }
  return { ok: true };
};

export const VERIFIERS: Partial<Record<string, KeyVerifier>> = {
  CRM_ERP_IO: verifyCrmErpIo,
};

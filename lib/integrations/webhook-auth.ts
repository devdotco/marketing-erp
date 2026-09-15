/**
 * Per-workspace webhook tokens — the database half. See lib/security/webhook-token.ts
 * for why a URL token rather than a signature.
 *
 * The token lives inside the integration's encrypted credentials JSON as
 * `webhookToken`, next to the API key it belongs with: disconnecting the
 * integration deletes it, and it is never stored in plaintext.
 */
import { prisma } from "@/lib/prisma";
import { decryptCredentials, encryptCredentials } from "@/lib/crypto";
import { appUrl } from "@/lib/base-path";
import { constantTimeEqual } from "@/lib/security/compare";
import {
  allowUnsignedWebhooks,
  generateWebhookToken,
  parseWebhookToken,
  webhookAuthMode,
  type WebhookProvider,
} from "@/lib/security/webhook-token";

export const WEBHOOK_TOKEN_HEADER = "x-webhook-token";

/** The workspace this token authenticates for this provider, or null. Never throws. */
export async function resolveWebhookWorkspace(provider: WebhookProvider, token: string): Promise<string | null> {
  const parsed = parseWebhookToken(token);
  if (!parsed) return null;
  try {
    const integration = await prisma.integration.findUnique({
      where: { workspaceId_provider: { workspaceId: parsed.workspaceId, provider } },
      select: { encryptedCredentials: true },
    });
    if (!integration) return null;
    const creds = await decryptCredentials<{ webhookToken?: string }>(integration.encryptedCredentials);
    return constantTimeEqual(token, creds.webhookToken) ? parsed.workspaceId : null;
  } catch (err) {
    console.error(`[webhooks] ${provider}: token lookup failed:`, (err as Error).message);
    return null;
  }
}

/**
 * The token to keep when an integration's credentials are re-saved: the one
 * already stored (so reconnecting with a rotated API key does not silently break
 * the webhook the admin pasted into the vendor), or a fresh one.
 */
export async function webhookTokenForSave(workspaceId: string, provider: WebhookProvider): Promise<string> {
  const existing = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId, provider } },
    select: { encryptedCredentials: true },
  });
  if (existing) {
    const creds = await decryptCredentials<{ webhookToken?: string }>(existing.encryptedCredentials).catch(() => null);
    if (creds?.webhookToken && parseWebhookToken(creds.webhookToken)?.workspaceId === workspaceId) return creds.webhookToken;
  }
  return generateWebhookToken(workspaceId);
}

/**
 * The workspace's webhook token, creating one if the integration predates
 * tokens; `rotate` replaces it. Null when the integration is not connected.
 */
export async function ensureWebhookToken(
  workspaceId: string,
  provider: WebhookProvider,
  { rotate = false }: { rotate?: boolean } = {},
): Promise<string | null> {
  const integration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId, provider } },
    select: { id: true, encryptedCredentials: true },
  });
  if (!integration) return null;
  const creds = await decryptCredentials<Record<string, unknown>>(integration.encryptedCredentials);
  const current = typeof creds.webhookToken === "string" ? creds.webhookToken : "";
  if (!rotate && parseWebhookToken(current)?.workspaceId === workspaceId) return current;

  const webhookToken = generateWebhookToken(workspaceId);
  await prisma.integration.update({
    where: { id: integration.id },
    data: { encryptedCredentials: await encryptCredentials({ ...creds, webhookToken }) },
  });
  return webhookToken;
}

export function webhookUrl(provider: WebhookProvider, token: string): string {
  return appUrl(`/api/webhooks/${provider.toLowerCase()}/${token}`);
}

/**
 * Authenticate an inbound webhook. The token comes from the URL path
 * (`/api/webhooks/<provider>/<token>`) or, for the bare URL, the
 * `x-webhook-token` header.
 *
 *  - `{ workspaceId }`: verified — match prospects in this workspace only.
 *  - `{ workspaceId: null }`: unsigned, accepted only because
 *    WEBHOOKS_ALLOW_UNSIGNED=true (a migration grace window). Logged.
 *  - `{ reject }`: answer with this status and do nothing.
 */
export async function authenticateWebhook(
  provider: WebhookProvider,
  token: string | null,
): Promise<{ workspaceId: string | null } | { reject: number }> {
  const mode = webhookAuthMode(token, allowUnsignedWebhooks(process.env));
  if (mode === "reject") return { reject: 401 };
  if (mode === "unsigned-grace") {
    console.warn(
      `[webhooks] ${provider}: accepted an UNSIGNED delivery because WEBHOOKS_ALLOW_UNSIGNED=true. ` +
        `Reconfigure the webhook with this workspace's tokenised URL and unset the flag.`,
    );
    return { workspaceId: null };
  }
  const workspaceId = await resolveWebhookWorkspace(provider, token!);
  return workspaceId ? { workspaceId } : { reject: 401 };
}

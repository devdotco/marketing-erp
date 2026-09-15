/**
 * Per-workspace webhook tokens — the pure half (no database). Server-only.
 *
 * Neither Instantly nor Aimfox signs webhook deliveries (no HMAC): the only
 * delivery auth either offers is the URL and custom headers you configure. So
 * each workspace gets its own random secret, carried in the webhook URL path
 * (or an `x-webhook-token` header).
 *
 * Shape: `<workspaceId>.<secret>`. The workspace id is not the secret — it only
 * says whose stored token to compare against, so verifying is one row read
 * rather than decrypting every workspace's credentials. The secret half is 32
 * random bytes, and the whole presented token is compared in constant time
 * against the whole stored one.
 */
import { randomBytes } from "node:crypto";

export const WEBHOOK_PROVIDERS = ["INSTANTLY", "AIMFOX"] as const;
export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

export function isWebhookProvider(provider: string): provider is WebhookProvider {
  return (WEBHOOK_PROVIDERS as readonly string[]).includes(provider);
}

export function generateWebhookToken(workspaceId: string): string {
  return `${workspaceId}.${randomBytes(32).toString("base64url")}`;
}

/** The workspace a token claims to belong to, or null if it isn't token-shaped at all. */
export function parseWebhookToken(token: string | null | undefined): { workspaceId: string } | null {
  if (!token || token.length > 200) return null;
  const match = /^([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{40,})$/.exec(token);
  return match ? { workspaceId: match[1]! } : null;
}

/** Only the literal string "true" opens the grace window — unset, "1", "yes" all keep it shut. */
export function allowUnsignedWebhooks(env: Record<string, string | undefined>): boolean {
  return env.WEBHOOKS_ALLOW_UNSIGNED === "true";
}

/**
 * How a webhook request is authenticated:
 *  - a token was presented → verify it; a bad token is rejected and never falls
 *    back to the unsigned path
 *  - no token, WEBHOOKS_ALLOW_UNSIGNED=true → process, logged as a warning
 *  - no token otherwise → reject
 */
export function webhookAuthMode(token: string | null | undefined, allowUnsigned: boolean): "verify" | "unsigned-grace" | "reject" {
  if (token) return "verify";
  return allowUnsigned ? "unsigned-grace" : "reject";
}

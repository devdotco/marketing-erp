/**
 * Microsoft 365 OAuth for the Outreach / Inbox Responder handlers' Graph mail
 * access. Same shape as lib/integrations/google.ts on purpose — same
 * expiring-access-token, refresh-before-use problem, same "workspace owns the
 * grant, not the clicking user" reasoning — generalised rather than
 * duplicated where the two actually differ (Microsoft has no resource picker
 * here: a mailbox is just "me", there's nothing to choose).
 *
 * Redirect URI, which must be registered on the Microsoft Entra app
 * registration:
 *
 *   https://app.erp.io/marketing/api/integrations/microsoft/callback
 *
 * Tenant "common" — personal and work/school accounts both work; the
 * workspace connecting Outlook doesn't need to be on Entra ID at all.
 *
 * No `next/*` imports: the agent worker bundles this file.
 */
import type { Integration } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptCredentials, encryptCredentials } from "@/lib/crypto";
import { appUrl } from "@/lib/base-path";
import { CONNECT_METHODS } from "./catalog";

/** Carries `nonce.PROVIDER.workspaceId` from /start to /callback. */
export const MICROSOFT_STATE_COOKIE = "microsoft_integration_state";

const TENANT = "common";
const AUTH_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;

export type MicrosoftCredentials = {
  access_token: string;
  refresh_token: string;
  /** Epoch ms. */
  expires_at: number;
  scope: string;
};

export function microsoftRedirectUri(): string {
  return appUrl("/api/integrations/microsoft/callback");
}

export function microsoftScopes(provider: string): string[] | null {
  const method = CONNECT_METHODS[provider]?.method;
  return method?.kind === "microsoft" ? method.scopes : null;
}

function clientConfig() {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Microsoft OAuth is not configured on this server");
  return { clientId, clientSecret };
}

export function microsoftAuthUrl(provider: string, state: string): string {
  const scopes = microsoftScopes(provider);
  if (!scopes) throw new Error(`${provider} is not a Microsoft integration`);
  const params = new URLSearchParams({
    client_id: clientConfig().clientId,
    redirect_uri: microsoftRedirectUri(),
    response_type: "code",
    response_mode: "query",
    scope: scopes.join(" "),
    // Without prompt=consent a re-connect on an account that already
    // consented once can silently reuse the old grant, which is fine — but
    // if scopes changed since, that grant won't cover the new one and the
    // token exchange fails opaquely. Forcing consent keeps it a form error.
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${params}`;
}

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const { clientId, clientSecret } = clientConfig();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...body }),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || data.error) {
    const err = new Error(data.error_description || data.error || `Microsoft token endpoint ${res.status}`);
    (err as Error & { code?: string }).code = data.error;
    throw err;
  }
  return data;
}

export async function exchangeMicrosoftCode(code: string, provider: string): Promise<MicrosoftCredentials> {
  const scopes = microsoftScopes(provider);
  if (!scopes) throw new Error(`${provider} is not a Microsoft integration`);
  const t = await tokenRequest({
    code,
    grant_type: "authorization_code",
    redirect_uri: microsoftRedirectUri(),
    scope: scopes.join(" "),
  });
  if (!t.refresh_token) {
    // Only happens if offline_access wasn't actually granted — catalog.ts
    // always requests it, so this means the consent screen let it get unticked.
    throw new Error("Microsoft did not return a refresh token. Reconnect and leave every requested permission checked.");
  }
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + t.expires_in * 1000,
    scope: t.scope ?? scopes.join(" "),
  };
}

/**
 * Decrypt a Microsoft integration, refreshing and persisting the access token
 * when it is within a minute of expiry. Throws a legible error when the grant
 * has been revoked, so the run fails with a reason rather than a 401 the
 * handler would otherwise swallow into simulated output.
 */
export async function microsoftCredentials(integration: Integration): Promise<MicrosoftCredentials> {
  const creds = await decryptCredentials<MicrosoftCredentials>(integration.encryptedCredentials);
  if (creds.expires_at && creds.expires_at > Date.now() + 60_000) return creds;

  if (!creds.refresh_token) {
    throw new Error(`${integration.provider} connection has no refresh token — reconnect it on the Integrations page`);
  }

  let t: TokenResponse;
  try {
    t = await tokenRequest({ refresh_token: creds.refresh_token, grant_type: "refresh_token" });
  } catch (err) {
    if ((err as Error & { code?: string }).code === "invalid_grant") {
      throw new Error(`${integration.provider} access was revoked or expired — reconnect it on the Integrations page`);
    }
    throw err;
  }

  const next: MicrosoftCredentials = {
    ...creds,
    access_token: t.access_token,
    expires_at: Date.now() + t.expires_in * 1000,
    // Microsoft rotates the refresh token on every use; the old one is void.
    refresh_token: t.refresh_token ?? creds.refresh_token,
    scope: t.scope ?? creds.scope,
  };
  await prisma.integration.update({
    where: { id: integration.id },
    data: { encryptedCredentials: await encryptCredentials(next), expiresAt: new Date(next.expires_at) },
  });
  return next;
}

/**
 * Unlike Google, the Microsoft identity platform has no user-facing REST
 * endpoint a confidential client can call to revoke a specific grant — only
 * the account holder (via myaccount.microsoft.com) or a tenant admin can.
 * Deleting the stored row (done unconditionally by the caller) is the whole
 * of what this app can do; this exists so that fact is documented, not
 * silently absent, and so a future revocation API lands in one place.
 */
export async function revokeMicrosoftGrant(_integration: Integration): Promise<void> {
  return;
}

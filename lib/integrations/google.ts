/**
 * Google OAuth for workspace integrations (Search Console, Analytics 4,
 * Business Profile, Ads).
 *
 * Separate from the NextAuth Google sign-in on purpose: signing in asks for
 * identity only, and an integration belongs to the WORKSPACE, not to whoever
 * happened to click. Same OAuth client, different redirect URI — which must be
 * registered on that client in Google Cloud:
 *
 *   https://app.erp.io/marketing/api/integrations/google/callback
 *
 * Google access tokens live an hour. The handlers used to read `access_token`
 * straight out of storage, so a connection would have worked for an hour and
 * then every GSC agent would 401 and — because they catch and fall through —
 * quietly produce a simulated report instead. `googleCredentials()` refreshes
 * first; handlers must go through it.
 *
 * No `next/*` imports: the agent worker bundles this file.
 */
import type { Integration } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptCredentials, encryptCredentials } from "@/lib/crypto";
import { appUrl } from "@/lib/base-path";
import { AgentInputError } from "@/lib/ai/errors";
import { CONNECT_METHODS } from "./catalog";

/** Carries `nonce.PROVIDER.workspaceId` from /start to /callback. */
export const GOOGLE_STATE_COOKIE = "google_integration_state";

const AUTH_URL ="https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export type GoogleCredentials = {
  access_token: string;
  refresh_token: string;
  /** Epoch ms. */
  expires_at: number;
  scope: string;
  /** Search Console only: the chosen property, `sc-domain:x` or a URL prefix. */
  property_url?: string;
  /** GA4 only: the chosen property, digits only — no `properties/` prefix. */
  property_id?: string;
  /** Google Ads only: the chosen customer, digits only — no dashes. */
  customer_id?: string;
  /** Google Business Profile only: the chosen account, digits only. */
  account_id?: string;
  /** Google Business Profile only: the chosen location, digits only — no `locations/` prefix. */
  location_id?: string;
};

export function googleRedirectUri(): string {
  return appUrl("/api/integrations/google/callback");
}

export function googleScopes(provider: string): string[] | null {
  const method = CONNECT_METHODS[provider]?.method;
  return method?.kind === "google" ? method.scopes : null;
}

function clientConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not configured on this server");
  return { clientId, clientSecret };
}

export function googleAuthUrl(provider: string, state: string): string {
  const scopes = googleScopes(provider);
  if (!scopes) throw new Error(`${provider} is not a Google integration`);
  const params = new URLSearchParams({
    client_id: clientConfig().clientId,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: scopes.join(" "),
    // offline + consent: without both, a re-connect returns no refresh token
    // and the integration would die an hour later.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${params}`;
}

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
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
    const err = new Error(data.error_description || data.error || `Google token endpoint ${res.status}`);
    (err as Error & { code?: string }).code = data.error;
    throw err;
  }
  return data;
}

export async function exchangeGoogleCode(code: string): Promise<GoogleCredentials> {
  const t = await tokenRequest({
    code,
    grant_type: "authorization_code",
    redirect_uri: googleRedirectUri(),
  });
  if (!t.refresh_token) {
    throw new Error("Google did not return a refresh token. Remove erp.io from your Google account's third-party access and try again.");
  }
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + t.expires_in * 1000,
    scope: t.scope,
  };
}

/** True when every scope the provider needs was actually granted (the consent screen lets people untick them). */
export function hasGrantedScopes(provider: string, granted: string): boolean {
  const have = new Set(granted.split(/\s+/));
  return (googleScopes(provider) ?? []).every((s) => have.has(s));
}

/**
 * Decrypt a Google integration, refreshing and persisting the access token when
 * it is within a minute of expiry. Throws a legible error when the grant has
 * been revoked, so the run fails with a reason rather than guessing.
 */
export async function googleCredentials(integration: Integration): Promise<GoogleCredentials> {
  const creds = await decryptCredentials<GoogleCredentials>(integration.encryptedCredentials);
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

  const next: GoogleCredentials = {
    ...creds,
    access_token: t.access_token,
    expires_at: Date.now() + t.expires_in * 1000,
    // Google may rotate it; keep the old one when it does not.
    refresh_token: t.refresh_token ?? creds.refresh_token,
    scope: t.scope ?? creds.scope,
  };
  await prisma.integration.update({
    where: { id: integration.id },
    data: { encryptedCredentials: await encryptCredentials(next), expiresAt: new Date(next.expires_at) },
  });
  return next;
}

/** Best effort: a disconnect should also end Google's side of the grant. */
export async function revokeGoogleGrant(integration: Integration): Promise<void> {
  try {
    const creds = await decryptCredentials<GoogleCredentials>(integration.encryptedCredentials);
    const token = creds.refresh_token || creds.access_token;
    if (!token) return;
    await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch {
    // The row is deleted regardless; an unrevoked grant is visible and removable in the Google account.
  }
}

export type GscSite = { siteUrl: string; permissionLevel: string };

/** Search Console properties this grant can read (unverified entries excluded — they return no data). */
export async function listGscSites(accessToken: string): Promise<GscSite[]> {
  const res = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Search Console API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { siteEntry?: GscSite[] };
  return (data.siteEntry ?? [])
    .filter((s) => s.permissionLevel !== "siteUnverifiedUser")
    .sort((a, b) => a.siteUrl.localeCompare(b.siteUrl));
}

/**
 * Every GA4/GSC/GBP/Ads handler used to wrap its live call in try/catch and
 * silently fall back to simulated output on ANY failure — including on a
 * CONNECTED integration whose token was fine but whose call 401'd, 403'd, or
 * hit a deleted property. That is indistinguishable from "not connected" to
 * whoever reads the report, and it is worse than not connecting at all: the
 * output says "source: live" while the client-facing report the 5 GSC
 * handlers were already producing quietly went back to fabricated numbers.
 *
 * Rule: not connected → simulating is fine. Connected but the call failed →
 * fail the run and say which provider and why, so a human reconnects it
 * instead of shipping a report full of invented figures.
 */
export function liveCallFailed(provider: string, detail: string): AgentInputError {
  return new AgentInputError(
    `${provider} is connected, but the live call failed: ${detail}`,
    `Reconnect ${provider} on the Integrations page, or confirm the selected property/account/location still exists and still grants access.`,
    "integration_call_failed",
  );
}

/** Google Ads REST endpoints all live under this version path. Bump when it sunsets. */
export const GOOGLE_ADS_API_VERSION = "v25";

/**
 * Google Ads is the one Google API in this fleet that needs more than the
 * OAuth token: every call also needs an approved developer token
 * (https://ads.google.com/aw/apicenter), and a call made through a manager
 * account needs to say which manager is asking. Missing the developer token
 * is a server misconfiguration, not something reconnecting the integration
 * fixes — so it gets its own message.
 */
export function googleAdsHeaders(accessToken: string): Record<string, string> {
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!developerToken) {
    throw new Error(
      "GOOGLE_ADS_DEVELOPER_TOKEN is not configured on this server — Google Ads needs an approved developer token before any account can be read. An administrator must set it (see https://ads.google.com/aw/apicenter).",
    );
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": developerToken,
    "Content-Type": "application/json",
  };
  // Only needed when the developer token's manager account differs from the
  // customer being queried. Most single-account connections don't set this.
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    headers["login-customer-id"] = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, "");
  }
  return headers;
}

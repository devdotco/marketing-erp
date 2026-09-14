/**
 * Meta (Facebook Pages + Instagram) OAuth for the Meta Poster handler.
 *
 * Deliberately NOT the same shape as google.ts / microsoft.ts: a Facebook Page
 * access token minted from a long-lived USER token does not expire under
 * normal conditions (Meta only kills it if the user changes password, revokes
 * the app, or loses the Page role) — see
 * https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
 * So there is no refresh step, and — on purpose — the long-lived user token
 * itself is never persisted to the database: only the Page token the handler
 * actually needs. It lives for a few minutes in an encrypted, httpOnly cookie
 * while the person picks which Page to connect (an account can admin more
 * than one), then it's gone. That also means disconnecting can't call Meta to
 * revoke the grant the way Google's flow does — there's no stored token with
 * the rights to do it — so DELETE just removes the row; see
 * app/api/integrations/connect/route.ts.
 *
 * Redirect URI, which must be registered on the Meta App's Facebook Login
 * product (Valid OAuth Redirect URIs):
 *
 *   https://app.erp.io/marketing/api/integrations/meta/callback
 *
 * All five permissions below need Meta App Review (Advanced Access) before
 * anyone outside the app's own admins/testers/developers can grant them —
 * until then this flow only works for Meta accounts added as testers on the
 * app.
 *
 * No `next/*` imports: the agent worker does not use this file (Meta Poster
 * uses the stored Page token directly, not a refresher), but keep the
 * convention so a future handler that needs live account listing can.
 */
import { appUrl } from "@/lib/base-path";
import { CONNECT_METHODS } from "./catalog";

/** Carries `nonce.PROVIDER.workspaceId` from /start to /callback. */
export const META_STATE_COOKIE = "meta_integration_state";
/** Carries the Page choices (with their tokens) from /callback to the connect page's picker step. */
export const META_PICKER_COOKIE = "meta_integration_picker";

// Pinned deliberately — Meta ships a new Graph API version every few months
// and retires old ones roughly two years out; bump this by hand, don't chase
// "latest" automatically, so a version bump is a reviewable diff. Exported so
// meta-poster.ts's publish calls use the exact same version as this OAuth
// flow rather than a second hardcoded copy that can drift out of sync.
export const META_GRAPH_VERSION = "v23.0";
const OAUTH_DIALOG_URL = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`;
const GRAPH_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

export type MetaCredentials = {
  page_access_token: string;
  page_id: string;
  page_name: string;
  ig_user_id?: string;
  ig_username?: string;
};

export function metaRedirectUri(): string {
  return appUrl("/api/integrations/meta/callback");
}

export function metaScopes(provider: string): string[] | null {
  const method = CONNECT_METHODS[provider]?.method;
  return method?.kind === "meta" ? method.scopes : null;
}

function clientConfig() {
  const clientId = process.env.META_APP_ID;
  const clientSecret = process.env.META_APP_SECRET;
  if (!clientId || !clientSecret) throw new Error("Meta OAuth is not configured on this server");
  return { clientId, clientSecret };
}

export function metaAuthUrl(provider: string, state: string): string {
  const scopes = metaScopes(provider);
  if (!scopes) throw new Error(`${provider} is not a Meta integration`);
  const params = new URLSearchParams({
    client_id: clientConfig().clientId,
    redirect_uri: metaRedirectUri(),
    response_type: "code",
    scope: scopes.join(","),
    state,
  });
  return `${OAUTH_DIALOG_URL}?${params}`;
}

type GraphTokenResponse = { access_token: string; token_type?: string; expires_in?: number };
type GraphError = { error?: { message?: string; type?: string; code?: number } };

async function graphGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(`${GRAPH_URL}${path}?${new URLSearchParams(params)}`);
  const data = (await res.json().catch(() => ({}))) as T & GraphError;
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `Meta Graph API ${res.status}`);
  }
  return data;
}

/** code → short-lived user token → long-lived (~60 day) user token, in one call. */
export async function exchangeMetaCode(code: string): Promise<string> {
  const { clientId, clientSecret } = clientConfig();
  const short = await graphGet<GraphTokenResponse>("/oauth/access_token", {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: metaRedirectUri(),
    code,
  });
  const long = await graphGet<GraphTokenResponse>("/oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: clientId,
    client_secret: clientSecret,
    fb_exchange_token: short.access_token,
  });
  return long.access_token;
}

export type MetaPage = {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string; username?: string };
};

/** Pages the connecting person can admin, with their (non-expiring) Page tokens attached. */
export async function listMetaPages(longLivedUserToken: string): Promise<MetaPage[]> {
  const data = await graphGet<{ data?: MetaPage[] }>("/me/accounts", {
    fields: "id,name,access_token,instagram_business_account{id,username}",
    access_token: longLivedUserToken,
  });
  return data.data ?? [];
}

// X (Twitter) OAuth 2.0 PKCE helpers
// Required X app settings: OAuth 2.0, type = "Web App", callback URL configured
// Scopes needed: tweet.write users.read offline.access

import crypto from "crypto";

const X_BASE = "https://twitter.com";
const X_API = "https://api.twitter.com/2";

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function getAuthorizationUrl(opts: {
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.X_CLIENT_ID!,
    redirect_uri: process.env.X_REDIRECT_URI!,
    scope: "tweet.write users.read offline.access",
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });

  return `${X_BASE}/i/oauth2/authorize?${params}`;
}

export interface XTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export async function exchangeCode(code: string, codeVerifier: string): Promise<XTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.X_REDIRECT_URI!,
    code_verifier: codeVerifier,
    client_id: process.env.X_CLIENT_ID!,
  });

  const credentials = Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString("base64");

  const res = await fetch(`${X_API}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`X token exchange failed: ${err}`);
  }

  return res.json() as Promise<XTokenResponse>;
}

export interface XUser {
  id: string;
  name: string;
  username: string;
  profile_image_url?: string;
}

export async function fetchXUser(accessToken: string): Promise<XUser> {
  const res = await fetch(`${X_API}/users/me?user.fields=profile_image_url`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) throw new Error("Failed to fetch X user");
  const data = await res.json() as { data: XUser };
  return data.data;
}

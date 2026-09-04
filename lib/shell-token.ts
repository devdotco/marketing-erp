import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * The shell's hand-off token.
 *
 * app.erp.io signs a short-lived Ed25519 JWT naming one module as its audience.
 * We hold only the public half, fetched from the shell's JWKS — so a token can
 * be checked here without this app ever being able to mint one, and a token
 * minted for another module is refused by the audience check rather than
 * quietly accepted.
 *
 * The issuer string is `https://app.vb.co` and that is not a mistake: it is the
 * identifier the shell was deployed with and changing it would invalidate every
 * token in flight across every module at once. It names the issuer; it is not a
 * URL anything fetches.
 */

const JWKS_URL = process.env.SHELL_JWKS_URL ?? "https://app.erp.io/.well-known/jwks.json";
const ISSUER = process.env.SHELL_TOKEN_ISSUER ?? "https://app.vb.co";
const AUDIENCE = "marketing";

/** Cached across requests — the shell rotates keys rarely and jose re-fetches on an unknown kid. */
const jwks = createRemoteJWKSet(new URL(JWKS_URL));

export type ShellClaims = {
  /** The shell's user id. Stable; the local row is keyed off email but records this. */
  sub: string;
  email: string;
  name: string;
  /** The shell organisation this person is acting as. */
  org: string | null;
  orgName: string | null;
  role: string | null;
};

export class ShellTokenInvalid extends Error {}

export async function verifyShellToken(token: string): Promise<ShellClaims> {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: ISSUER,
    audience: AUDIENCE,
  }).catch((err) => {
    throw new ShellTokenInvalid((err as Error).message);
  });

  const email = typeof payload.email === "string" ? payload.email : null;
  if (!payload.sub || !email) {
    // A token without a subject or an address cannot identify anybody, and
    // inventing a placeholder here would create an account nobody owns.
    throw new ShellTokenInvalid("token carries no subject or email");
  }

  return {
    sub: payload.sub,
    email: email.toLowerCase(),
    name: typeof payload.name === "string" && payload.name.trim() ? payload.name : email,
    org: typeof payload.org === "string" ? payload.org : null,
    orgName: typeof payload.org_name === "string" ? payload.org_name : null,
    role: typeof payload.role === "string" ? payload.role : null,
  };
}

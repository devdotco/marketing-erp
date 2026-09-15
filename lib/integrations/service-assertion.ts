import { createHash, randomUUID } from "node:crypto";
import { SignJWT, importPKCS8, type KeyObject, type CryptoKey } from "jose";

/**
 * Marketing's signed, per-request service assertions to the erp.io CRM.
 *
 * Replaces the pasted per-tenant API key. Marketing holds an Ed25519 PRIVATE
 * key (`MARKETING_SERVICE_PRIVATE_KEY`); the CRM holds only the public half, so
 * the CRM can verify Marketing but never impersonate it.
 *
 * `sub` is the workspace's shell organization id and nothing else — the CRM
 * resolves the tenant from that verified claim alone. Each assertion is also
 * bound to one request (method, path, body hash), names `aud=crm`, carries a
 * single-use jti, and lives 60 seconds, so a captured one cannot be replayed,
 * redirected at another endpoint, or re-used with a different segment id.
 *
 * Contract mirrored in crm-erp-io `src/lib/auth/marketing-assertion.ts`.
 */

export const MARKETING_SERVICE_ISSUER = "https://app.erp.io/marketing";
export const SERVICE_JWT_TYPE = "erp-service+jwt";
const TTL_SECONDS = 60;

export function bodyDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("base64url");
}

/** Coolify stores PEMs with real, escaped or double-escaped newlines — accept all three. */
function normalizePem(value: string): string {
  return value.replace(/\\+n/g, "\n").trim();
}

export function serviceSigningConfigured(): boolean {
  return Boolean(process.env.MARKETING_SERVICE_PRIVATE_KEY);
}

let cached: { pem: string; key: Promise<CryptoKey | KeyObject> } | null = null;

function signingKey(): Promise<CryptoKey | KeyObject> {
  const pem = process.env.MARKETING_SERVICE_PRIVATE_KEY;
  if (!pem) throw new Error("MARKETING_SERVICE_PRIVATE_KEY is not set — refusing to call the CRM without a signature");
  if (!cached || cached.pem !== pem) cached = { pem, key: importPKCS8(normalizePem(pem), "EdDSA") };
  return cached.key;
}

export async function signCrmAssertion(
  input: { shellOrgId: string; method: string; path: string; body: string },
  key?: CryptoKey | KeyObject,
): Promise<string> {
  if (!input.shellOrgId?.trim()) throw new Error("A CRM service assertion needs a shell organization");
  return new SignJWT({ htm: input.method.toUpperCase(), htu: input.path, bdy: bodyDigest(input.body) })
    .setProtectedHeader({ alg: "EdDSA", typ: SERVICE_JWT_TYPE, kid: process.env.MARKETING_SERVICE_KEY_ID ?? "marketing-1" })
    .setIssuer(MARKETING_SERVICE_ISSUER)
    .setAudience("crm")
    .setSubject(input.shellOrgId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(key ?? (await signingKey()));
}

/**
 * The gate in front of /api/admin/seed. Pure — takes the env and the presented
 * header, so it is unit-tested.
 *
 * That route is public at the proxy and can promote the admin user to
 * SUPER_ADMIN and overwrite the admin workspace's integration keys, so:
 *  - in production it does not exist (404) unless ALLOW_ADMIN_SEED=true
 *  - with ADMIN_SEED_SECRET unset or shorter than 32 characters it does not
 *    exist (404) — there is no fallback to NEXTAUTH_SECRET or any other secret
 *  - otherwise the `x-admin-seed-secret` header must match, compared in
 *    constant time (403). Never a query string: those land in access logs.
 */
import { constantTimeEqual } from "@/lib/security/compare";

export const ADMIN_SEED_HEADER = "x-admin-seed-secret";
const MIN_SECRET_LENGTH = 32;

export function adminSeedGate(
  env: Record<string, string | undefined>,
  presentedSecret: string | null | undefined,
): "not_found" | "forbidden" | "ok" {
  if (env.NODE_ENV === "production" && env.ALLOW_ADMIN_SEED !== "true") return "not_found";
  const expected = env.ADMIN_SEED_SECRET;
  if (!expected || expected.length < MIN_SECRET_LENGTH) return "not_found";
  return constantTimeEqual(presentedSecret, expected) ? "ok" : "forbidden";
}

/**
 * What a Google sign-in proves about an existing Marketing account.
 *
 * Google only returns `email_verified: true` for an address its owner controls,
 * so a Google sign-in whose address matches the account is proof of that
 * inbox. Two things follow:
 *
 *  - The account is verified. Before this, Google sign-ins left `emailVerified`
 *    null, and the shell mirror (which only links verified local accounts)
 *    refused people who had only ever signed in with Google, tim@dev.co first.
 *  - If the account was NOT verified until now, whoever set its password had not
 *    proven the address. That password stops working, the same account
 *    pre-hijack protection the shell applies in lib/auth/verify-on-proof.ts.
 *
 * Pure, so the decision is testable without NextAuth or a database.
 */
export type GoogleProofAction = "none" | "verify";

export function googleProofAction(input: {
  provider: string | undefined;
  profileEmail: string | undefined | null;
  profileEmailVerified: unknown;
  accountEmail: string | undefined | null;
  alreadyVerified: boolean;
}): GoogleProofAction {
  if (input.provider !== "google") return "none";
  if (input.profileEmailVerified !== true) return "none";
  const a = (input.profileEmail ?? "").trim().toLowerCase();
  const b = (input.accountEmail ?? "").trim().toLowerCase();
  if (!a || a !== b) return "none";
  return input.alreadyVerified ? "none" : "verify";
}

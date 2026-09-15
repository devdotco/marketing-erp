/**
 * Which roles an invitation may carry. Pure — no database.
 *
 * SUPER_ADMIN is never invitable: in this app any SUPER_ADMIN membership makes
 * the user a platform operator (lib/auth.ts sets isSuperAdmin from it, which
 * unlocks /superadmin and every workspace).
 */
export const INVITABLE_ROLES = ["VIEWER", "OPERATOR", "WORKSPACE_ADMIN"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

const ROLE_RANK: Record<string, number> = { VIEWER: 0, OPERATOR: 1, WORKSPACE_ADMIN: 2, SUPER_ADMIN: 3 };

/**
 * Whether this inviter may invite someone at this role. The inviter must be a
 * WORKSPACE_ADMIN (or higher) of the workspace, or a platform super admin; the
 * role must be on the allowlist; and it may not outrank the inviter's own role.
 */
export function canInviteRole(
  requested: unknown,
  inviter: { role: string | null | undefined; isSuperAdmin: boolean },
): requested is InvitableRole {
  if (typeof requested !== "string" || !(INVITABLE_ROLES as readonly string[]).includes(requested)) return false;
  if (inviter.isSuperAdmin) return true;
  const inviterRank = inviter.role ? ROLE_RANK[inviter.role] : undefined;
  if (inviterRank === undefined || inviterRank < ROLE_RANK.WORKSPACE_ADMIN!) return false;
  return ROLE_RANK[requested]! <= inviterRank;
}

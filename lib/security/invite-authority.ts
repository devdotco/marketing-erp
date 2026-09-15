import { prisma } from "@/lib/prisma";
import { isPlatformSuperAdmin } from "@/lib/platform-admin";

/**
 * Who is inviting, as the invitations API must see them: their role in THIS
 * workspace and whether they are a platform super admin.
 *
 * `isSuperAdmin` comes from the database (`isPlatformSuperAdmin`, the same check
 * the /superadmin pages make) — never from `session.user.isSuperAdmin`, which
 * getServerSession() hardcodes to false. Trusting the session flag closed the
 * route to real platform operators who are not members of the workspace.
 *
 * `mayInvite` is the gate the route answers 403 on: a WORKSPACE_ADMIN (or
 * higher) member of the workspace, or a platform super admin of a workspace that
 * exists. The requested role is then checked separately by canInviteRole, whose
 * allowlist never includes SUPER_ADMIN — for anyone.
 */
export type Inviter = { mayInvite: boolean; role: string | null; isSuperAdmin: boolean };

type InviteDb = {
  workspaceMember: {
    findFirst: (args: { where: { userId: string; role: "SUPER_ADMIN" }; select: { id: true } }) => Promise<{ id: string } | null>;
    findUnique: (args: { where: { workspaceId_userId: { workspaceId: string; userId: string } }; select: { role: true } }) => Promise<{ role: string } | null>;
  };
  workspace: { findUnique: (args: { where: { id: string }; select: { id: true } }) => Promise<{ id: string } | null> };
};

const RANK: Record<string, number> = { VIEWER: 0, OPERATOR: 1, WORKSPACE_ADMIN: 2, SUPER_ADMIN: 3 };

export async function resolveInviter(
  userId: string | null | undefined,
  workspaceId: string,
  db: InviteDb = prisma as unknown as InviteDb,
): Promise<Inviter> {
  if (!userId || !workspaceId) return { mayInvite: false, role: null, isSuperAdmin: false };
  const [isSuperAdmin, member, workspace] = await Promise.all([
    isPlatformSuperAdmin(userId, db),
    db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, select: { role: true } }),
    db.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } }),
  ]);
  const role = member?.role ?? null;
  const isAdminMember = role !== null && (RANK[role] ?? -1) >= RANK.WORKSPACE_ADMIN!;
  return { mayInvite: !!workspace && (isAdminMember || isSuperAdmin), role, isSuperAdmin };
}

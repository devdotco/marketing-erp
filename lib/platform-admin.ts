import { prisma } from "@/lib/prisma";

/**
 * Whether a user is a PLATFORM super admin of Marketing — the only people who
 * may see /superadmin, every workspace in it, and the platform-key switch.
 *
 * Derived from a SUPER_ADMIN WorkspaceMember row, which nothing automatic ever
 * writes: the shell hand-off and the mirror map the shell's top role to
 * WORKSPACE_ADMIN and never grant SUPER_ADMIN (lib/shell-mirror/protocol.ts). So
 * no customer — and no internal-org membership arriving from the shell — can
 * become one.
 *
 * Read from the database on every call. `getServerSession()` hardcodes
 * `isSuperAdmin: false`, so the pages that trusted it were closed to everyone,
 * real operators included; this is the check they should have made.
 */
export async function isPlatformSuperAdmin(
  userId: string | null | undefined,
  db: { workspaceMember: { findFirst: (args: { where: { userId: string; role: "SUPER_ADMIN" }; select: { id: true } }) => Promise<{ id: string } | null> } } = prisma,
): Promise<boolean> {
  if (!userId) return false;
  return !!(await db.workspaceMember.findFirst({ where: { userId, role: "SUPER_ADMIN" }, select: { id: true } }));
}

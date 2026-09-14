import { getServerSession } from "@/lib/session";
import { resolveWorkspaceId } from "@/lib/actions/workspace";
import { prisma } from "@/lib/prisma";

/**
 * Who may change a workspace's integrations: its admins, and super admins.
 * Credentials bill and publish on the workspace's behalf, so a VIEWER or
 * OPERATOR connecting their own Google account over the team's is not a
 * thing to allow by default.
 */
export async function integrationAdmin(): Promise<
  { ok: true; workspaceId: string; userId: string } | { ok: false; status: number; error: string }
> {
  const session = await getServerSession();
  if (!session?.user) return { ok: false, status: 401, error: "Unauthorized" };

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) return { ok: false, status: 400, error: "No workspace found" };

  if (!session.user.isSuperAdmin) {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: session.user.id } },
      select: { role: true },
    });
    if (!member || (member.role !== "WORKSPACE_ADMIN" && member.role !== "SUPER_ADMIN")) {
      return { ok: false, status: 403, error: "Only workspace admins can change integrations" };
    }
  }

  return { ok: true, workspaceId, userId: session.user.id };
}

/**
 * Who may READ a workspace's integration resource list (the GSC properties,
 * GA4 properties, ... a Run/Configure dropdown offers) without being able to
 * change the workspace's saved default: the same bar POST /api/runs uses to
 * let someone start a run at all. Unlike integrationAdmin(), a VIEWER is
 * still turned away, but an OPERATOR is not — and the response never carries
 * a token, only the same property labels/ids a run's own output would.
 */
export async function runAccess(): Promise<
  { ok: true; workspaceId: string; userId: string } | { ok: false; status: number; error: string }
> {
  const session = await getServerSession();
  if (!session?.user) return { ok: false, status: 401, error: "Unauthorized" };

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) return { ok: false, status: 400, error: "No workspace found" };

  if (!session.user.isSuperAdmin) {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: session.user.id } },
      select: { role: true },
    });
    const canRun = member && (member.role === "OPERATOR" || member.role === "WORKSPACE_ADMIN" || member.role === "SUPER_ADMIN");
    if (!canRun) {
      return { ok: false, status: 403, error: "Only workspace members who can run agents may view this" };
    }
  }

  return { ok: true, workspaceId, userId: session.user.id };
}

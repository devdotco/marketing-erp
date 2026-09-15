import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { randomBytes } from "crypto";
import { canInviteRole, INVITABLE_ROLES } from "@/lib/security/invite-roles";
import { resolveInviter } from "@/lib/security/invite-authority";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { workspaceId, email, role } = body as { workspaceId?: unknown; email?: unknown; role?: unknown };

  if (typeof workspaceId !== "string" || !workspaceId || typeof email !== "string" || !email || !role) {
    return NextResponse.json({ error: "workspaceId, email, role required" }, { status: 400 });
  }

  // Only a WORKSPACE_ADMIN of THIS workspace (or a platform super admin) may invite.
  // Super admin is read from the database (isPlatformSuperAdmin), never from
  // the session's isSuperAdmin flag, which getServerSession() hardcodes to false.
  const inviter = await resolveInviter(session.user.id, workspaceId);
  if (!inviter.mayInvite) {
    return NextResponse.json({ error: "Only workspace admins can invite members" }, { status: 403 });
  }

  // The role used to be stored verbatim — SUPER_ADMIN included, and a SUPER_ADMIN membership
  // anywhere makes a user a platform operator (lib/platform-admin.ts). Allowlist it, capped at
  // the inviter's own role.
  if (!canInviteRole(role, { role: inviter.role, isSuperAdmin: inviter.isSuperAdmin })) {
    return NextResponse.json({ error: `role must be one of ${INVITABLE_ROLES.join(", ")}, and no higher than your own` }, { status: 400 });
  }

  // Check if already a member
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    const existingMember = await prisma.workspaceMember.findFirst({
      where: { workspaceId, userId: existingUser.id },
    });
    if (existingMember) {
      return NextResponse.json({ error: "User is already a member of this workspace" }, { status: 400 });
    }
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const invitation = await prisma.invitation.create({
    data: {
      workspaceId,
      email,
      role,
      token,
      expiresAt,
      invitedById: session.user.id!,
    },
  });

  // TODO: send email via Resend with the invite link
  const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/invite/${token}`;
  console.log(`[invitations] Invite link for ${email}: ${inviteUrl}`);

  return NextResponse.json({ inviteId: invitation.id, inviteUrl });
}

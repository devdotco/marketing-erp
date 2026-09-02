import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess } from "@/lib/actions/workspace";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { workspaceId, email, role } = body as { workspaceId: string; email: string; role: string };

  if (!workspaceId || !email || !role) {
    return NextResponse.json({ error: "workspaceId, email, role required" }, { status: 400 });
  }

  await requireWorkspaceAccess(workspaceId, "WORKSPACE_ADMIN");

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
      role: role as never,
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

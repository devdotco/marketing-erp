import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getActiveWorkspaceId } from "@/lib/actions/workspace";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = await getActiveWorkspaceId();
  if (!workspaceId) return NextResponse.json({ error: "No active workspace" }, { status: 400 });

  const { id } = await params;

  // Verify the account belongs to this workspace
  const existing = await prisma.socialAccount.findFirst({ where: { id, workspaceId } });
  if (!existing) return NextResponse.json({ error: "Account not found" }, { status: 404 });

  await prisma.socialAccount.delete({ where: { id } });

  return NextResponse.json({ deleted: true });
}

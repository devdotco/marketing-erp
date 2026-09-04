import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getActiveWorkspaceId } from "@/lib/actions/workspace";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = await getActiveWorkspaceId();
  if (!workspaceId) return NextResponse.json({ error: "No active workspace" }, { status: 400 });

  const { id } = await params;

  // Verify the post belongs to this workspace
  const existing = await prisma.socialPost.findFirst({ where: { id, workspaceId } });
  if (!existing) return NextResponse.json({ error: "Post not found" }, { status: 404 });

  const body = await req.json() as {
    content?: string;
    scheduledAt?: string | null;
    status?: "DRAFT" | "SCHEDULED" | "PUBLISHED" | "FAILED";
  };

  const updated = await prisma.socialPost.update({
    where: { id },
    data: {
      ...(body.content !== undefined ? { content: body.content } : {}),
      ...(body.scheduledAt !== undefined
        ? { scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null }
        : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    },
    include: { socialAccount: true },
  });

  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = await getActiveWorkspaceId();
  if (!workspaceId) return NextResponse.json({ error: "No active workspace" }, { status: 400 });

  const { id } = await params;

  // Verify the post belongs to this workspace
  const existing = await prisma.socialPost.findFirst({ where: { id, workspaceId } });
  if (!existing) return NextResponse.json({ error: "Post not found" }, { status: 404 });

  await prisma.socialPost.delete({ where: { id } });

  return NextResponse.json({ deleted: true });
}

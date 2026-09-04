import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getActiveWorkspaceId } from "@/lib/actions/workspace";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = await getActiveWorkspaceId();
  if (!workspaceId) return NextResponse.json({ error: "No active workspace" }, { status: 400 });

  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status");
  const accountId = searchParams.get("accountId");

  const posts = await prisma.socialPost.findMany({
    where: {
      workspaceId,
      ...(status ? { status: status as "DRAFT" | "SCHEDULED" | "PUBLISHED" | "FAILED" } : {}),
      ...(accountId ? { socialAccountId: accountId } : {}),
    },
    include: { socialAccount: true },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(posts);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = await getActiveWorkspaceId();
  if (!workspaceId) return NextResponse.json({ error: "No active workspace" }, { status: 400 });

  const body = await req.json() as {
    socialAccountId: string;
    content: string;
    scheduledAt?: string;
    status?: "DRAFT" | "SCHEDULED" | "PUBLISHED" | "FAILED";
  };

  if (!body.socialAccountId || !body.content) {
    return NextResponse.json({ error: "socialAccountId and content are required" }, { status: 400 });
  }

  // Verify the social account belongs to this workspace
  const account = await prisma.socialAccount.findFirst({
    where: { id: body.socialAccountId, workspaceId },
  });
  if (!account) return NextResponse.json({ error: "Social account not found" }, { status: 404 });

  const post = await prisma.socialPost.create({
    data: {
      workspaceId,
      socialAccountId: body.socialAccountId,
      content: body.content,
      status: body.status ?? "DRAFT",
      scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
    },
    include: { socialAccount: true },
  });

  return NextResponse.json(post, { status: 201 });
}

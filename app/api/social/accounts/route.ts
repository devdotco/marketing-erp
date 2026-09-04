import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getActiveWorkspaceId } from "@/lib/actions/workspace";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = await getActiveWorkspaceId();
  if (!workspaceId) return NextResponse.json({ error: "No active workspace" }, { status: 400 });

  const accounts = await prisma.socialAccount.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      platform: true,
      accountType: true,
      displayName: true,
      username: true,
    },
  });

  return NextResponse.json(accounts);
}

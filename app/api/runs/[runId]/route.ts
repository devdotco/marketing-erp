import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess } from "@/lib/actions/workspace";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;

  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    include: {
      agentConfig: { select: { agentSlug: true, config: true } },
    },
  });

  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await requireWorkspaceAccess(run.workspaceId);

  return NextResponse.json(run);
}

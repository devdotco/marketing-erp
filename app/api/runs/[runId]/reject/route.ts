import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess } from "@/lib/actions/workspace";

export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;

  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await requireWorkspaceAccess(run.workspaceId, "OPERATOR");

  if (run.status !== "AWAITING_APPROVAL") {
    return NextResponse.json({ error: `Run is ${run.status}, not awaiting approval` }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const reason = (body as { reason?: string }).reason;

  const updated = await prisma.agentRun.update({
    where: { id: runId },
    data: { status: "REJECTED", output: reason ? { rejectionReason: reason } : undefined },
  });

  return NextResponse.json(updated);
}

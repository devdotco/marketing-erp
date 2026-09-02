import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { enqueueAgentRun } from "@/lib/queue";
import { getActiveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { workspaceId: bodyWsId, agentSlug } = body as { workspaceId?: string; agentSlug: string };

  const workspaceId = bodyWsId ?? await getActiveWorkspaceId();
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  await requireWorkspaceAccess(workspaceId, "OPERATOR");

  // Find or create the agent config
  let agentConfig = await prisma.agentConfig.findUnique({
    where: { workspaceId_agentSlug: { workspaceId, agentSlug } },
  });

  if (!agentConfig) {
    agentConfig = await prisma.agentConfig.create({
      data: { workspaceId, agentSlug, enabled: true },
    });
  }

  if (!agentConfig.enabled) {
    return NextResponse.json({ error: "Agent is not enabled for this workspace" }, { status: 400 });
  }

  const run = await prisma.agentRun.create({
    data: {
      workspaceId,
      agentConfigId: agentConfig.id,

      status: "PENDING",
      triggeredBy: session.user.id!,
    },
  });

  try {
    await enqueueAgentRun(run.id);
  } catch (err) {
    // Queue failure shouldn't block the response — run stays PENDING and can be retried
    console.error("Failed to enqueue agent run:", err);
  }

  return NextResponse.json({ runId: run.id }, { status: 201 });
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get("workspaceId") ?? await getActiveWorkspaceId();
  const status = searchParams.get("status");
  const agentSlug = searchParams.get("agent");
  const page = Number(searchParams.get("page") ?? "1");
  const limit = Math.min(Number(searchParams.get("limit") ?? "20"), 100);

  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });
  await requireWorkspaceAccess(workspaceId);

  const where = {
    workspaceId,
    ...(status ? { status: status as never } : {}),
    ...(agentSlug ? { agentConfig: { agentSlug } } : {}),
  };

  const [runs, total] = await Promise.all([
    prisma.agentRun.findMany({
      where,
      include: { agentConfig: { select: { agentSlug: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.agentRun.count({ where }),
  ]);

  return NextResponse.json({ runs, total, page, limit });
}

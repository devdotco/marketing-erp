import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runAccess } from "@/lib/integrations/route-auth";
import { getAgent } from "@/lib/agents";

export const dynamic = "force-dynamic";

/**
 * Drafts another agent produced, for an `agent_run` dropdown (On-site
 * Publisher's Draft ID). Answers the ResourceSelect contract. Only runs a human
 * has approved are offered: publishing is downstream of review, and listing
 * AWAITING_APPROVAL drafts here would be a way around it.
 */
export async function GET(req: NextRequest) {
  const who = await runAccess();
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });

  const agents = (req.nextUrl.searchParams.get("agents") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (agents.length === 0) return NextResponse.json({ error: "agents is required" }, { status: 400 });

  const runs = await prisma.agentRun.findMany({
    where: {
      workspaceId: who.workspaceId,
      status: { in: ["APPROVED", "COMPLETED"] },
      agentConfig: { agentSlug: { in: agents } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, output: true, createdAt: true, agentConfig: { select: { agentSlug: true } } },
  });

  const options = runs
    .filter((r) => {
      const o = r.output as Record<string, unknown> | null;
      return Boolean(o && typeof o.content === "string" && o.content);
    })
    .map((r) => {
      const o = r.output as Record<string, unknown>;
      const words = typeof o.wordCount === "number" ? ` · ${o.wordCount.toLocaleString()} words` : "";
      return {
        value: r.id,
        label: String(o.title || "Untitled draft"),
        detail: `${getAgent(r.agentConfig.agentSlug)?.name ?? r.agentConfig.agentSlug} · ${r.createdAt.toISOString().slice(0, 10)}${words}`,
      };
    });

  return NextResponse.json({ connected: true, noun: "draft", options, selected: null, providerLabel: "Drafts" });
}

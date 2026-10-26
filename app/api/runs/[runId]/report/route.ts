import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess } from "@/lib/actions/workspace";
import { buildKeywordReport, compareScans, isKeywordResearchOutput, renderKeywordReportHtml } from "@/lib/reports/keyword-research";
import { previousKeywordScan } from "@/lib/reports/keyword-scans";

export const dynamic = "force-dynamic";

/** The run's downloadable report: Keyword Research as HTML, Topic Planner's near-rank CSV. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    include: { agentConfig: { select: { agentSlug: true } }, workspace: { select: { name: true, slug: true } } },
  });
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await requireWorkspaceAccess(run.workspaceId);

  // Topic Planner promises a near-rank opportunities CSV; the handler builds it
  // from the Search Console rows it read (never from the model).
  const csv = (run.output as Record<string, unknown> | null)?.["nearRankCsv"];
  if (run.agentConfig.agentSlug === "topic-planner" && typeof csv === "string") {
    const day = (run.completedAt ?? run.createdAt).toISOString().slice(0, 10);
    const filename = `near-rank-opportunities-${run.workspace.slug}-${day}.csv`.replace(/[^a-zA-Z0-9._-]/g, "-");
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  if (run.agentConfig.agentSlug !== "keyword-research" || !isKeywordResearchOutput(run.output)) {
    return NextResponse.json({ error: "This run has no downloadable report" }, { status: 404 });
  }

  const report = buildKeywordReport(run.output);
  const previous = await previousKeywordScan(run.workspaceId, run.createdAt);
  const html = renderKeywordReportHtml(report, {
    workspaceName: run.workspace.name,
    runId,
    comparison: previous ? compareScans(report, previous.report) : null,
  });
  const day = (run.completedAt ?? run.createdAt).toISOString().slice(0, 10);
  const filename = `keyword-research-${run.workspace.slug}-${day}.html`.replace(/[^a-zA-Z0-9._-]/g, "-");

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}

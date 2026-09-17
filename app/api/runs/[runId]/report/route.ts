import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess } from "@/lib/actions/workspace";
import { buildKeywordReport, compareScans, isKeywordResearchOutput, renderKeywordReportHtml } from "@/lib/reports/keyword-research";
import { previousKeywordScan } from "@/lib/reports/keyword-scans";

export const dynamic = "force-dynamic";

/** The run's report as a standalone HTML file. Keyword Research only, for now. */
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

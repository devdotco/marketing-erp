import { prisma } from "@/lib/prisma";
import { buildKeywordReport, isKeywordResearchOutput, type KeywordReport } from "@/lib/reports/keyword-research";

export type KeywordScan = {
  runId: string;
  status: string;
  at: Date;
  costUsd: number;
  report: KeywordReport;
};

/**
 * Every Keyword Research scan in a workspace that produced a report, oldest
 * first. Rejected and failed runs are left out: a rejected scan is one a person
 * said not to trust, and a failed one has nothing to compare.
 */
export async function loadKeywordScans(workspaceId: string, opts: { before?: Date; take?: number } = {}): Promise<KeywordScan[]> {
  const runs = await prisma.agentRun.findMany({
    where: {
      workspaceId,
      agentConfig: { agentSlug: "keyword-research" },
      status: { in: ["AWAITING_APPROVAL", "APPROVED", "COMPLETED"] },
      ...(opts.before ? { createdAt: { lt: opts.before } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: opts.take ?? 100,
    select: { id: true, status: true, createdAt: true, completedAt: true, costUsd: true, output: true },
  });
  return runs
    .filter((run) => isKeywordResearchOutput(run.output))
    .map((run) => ({
      runId: run.id,
      status: run.status,
      at: run.completedAt ?? run.createdAt,
      costUsd: Number(run.costUsd),
      report: buildKeywordReport(run.output),
    }))
    .reverse();
}

/** The scan immediately before this run, if any. */
export async function previousKeywordScan(workspaceId: string, before: Date): Promise<KeywordScan | null> {
  const scans = await loadKeywordScans(workspaceId, { before, take: 5 });
  return scans.at(-1) ?? null;
}

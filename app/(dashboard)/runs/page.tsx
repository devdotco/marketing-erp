import { getServerSession } from "@/lib/session";
import { redirect } from "next/navigation";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import { prisma } from "@/lib/prisma";
import { AGENTS } from "@/lib/agents";
import Link from "next/link";
import { formatDistanceToNow } from "@/lib/utils";

export const metadata = { title: "Runs — marketing.erp.io" };

const STATUS_BADGE: Record<string, string> = {
  PENDING: "badge-pending", RUNNING: "badge-running",
  AWAITING_APPROVAL: "badge-awaiting", APPROVED: "badge-approved",
  REJECTED: "badge-rejected", COMPLETED: "badge-completed", FAILED: "badge-failed",
};

const ALL_STATUSES = ["PENDING", "RUNNING", "AWAITING_APPROVAL", "APPROVED", "REJECTED", "COMPLETED", "FAILED"];

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; agent?: string; page?: string }>;
}) {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");

  await requireWorkspaceAccess(workspaceId);

  const params = await searchParams;
  const statusFilter = params.status && ALL_STATUSES.includes(params.status) ? params.status : undefined;
  const agentFilter = params.agent;
  const page = Math.max(1, Number(params.page ?? "1"));
  const limit = 25;

  const where = {
    workspaceId,
    ...(statusFilter ? { status: statusFilter as never } : {}),
    ...(agentFilter ? { agentConfig: { agentSlug: agentFilter } } : {}),
  };

  const [runs, total, pendingApprovals] = await Promise.all([
    prisma.agentRun.findMany({
      where,
      include: {
        agentConfig: { select: { agentSlug: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.agentRun.count({ where }),
    prisma.agentRun.count({ where: { workspaceId, status: "AWAITING_APPROVAL" } }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="scrollable">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 6 }}>Runs</h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {total} total · {pendingApprovals > 0 && (
              <span style={{ color: "var(--warning)" }}>{pendingApprovals} awaiting approval</span>
            )}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        <Link
          href="/runs"
          className={`btn btn-sm ${!statusFilter && !agentFilter ? "btn-primary" : "btn-secondary"}`}
        >
          All
        </Link>
        <Link
          href="/runs?status=AWAITING_APPROVAL"
          className={`btn btn-sm ${statusFilter === "AWAITING_APPROVAL" ? "btn-primary" : "btn-secondary"}`}
        >
          Needs approval {pendingApprovals > 0 && `(${pendingApprovals})`}
        </Link>
        <Link
          href="/runs?status=RUNNING"
          className={`btn btn-sm ${statusFilter === "RUNNING" ? "btn-primary" : "btn-secondary"}`}
        >
          Running
        </Link>
        <Link
          href="/runs?status=COMPLETED"
          className={`btn btn-sm ${statusFilter === "COMPLETED" ? "btn-primary" : "btn-secondary"}`}
        >
          Completed
        </Link>
        <Link
          href="/runs?status=FAILED"
          className={`btn btn-sm ${statusFilter === "FAILED" ? "btn-primary" : "btn-secondary"}`}
        >
          Failed
        </Link>
      </div>

      {/* Runs table */}
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {runs.length === 0 ? (
          <div style={{ padding: "48px 24px", textAlign: "center" }}>
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>No runs{statusFilter ? ` with status ${statusFilter}` : ""}</p>
            {!statusFilter && (
              <Link href="/agents" className="btn btn-secondary btn-sm">Browse agents →</Link>
            )}
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th>Cost</th>
                <th>Triggered by</th>
                <th>Duration</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const agent = AGENTS.find((a) => a.slug === run.agentConfig.agentSlug);
                const dur = run.completedAt && run.startedAt
                  ? Math.round((run.completedAt.getTime() - run.startedAt.getTime()) / 1000)
                  : null;
                return (
                  <tr key={run.id}>
                    <td>
                      <Link href={`/runs/${run.id}`} style={{ textDecoration: "none", color: "var(--text)", fontWeight: 500, fontSize: 12, fontFamily: "monospace" }}>
                        {agent?.name ?? run.agentConfig.agentSlug}
                      </Link>
                    </td>
                    <td>
                      <Link href={`/runs/${run.id}`} style={{ textDecoration: "none" }}>
                        <span className={`badge ${STATUS_BADGE[run.status] ?? "badge-muted"}`}>
                          {run.status.replace(/_/g, " ")}
                        </span>
                      </Link>
                    </td>
                    <td style={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}>
                      ${Number(run.costUsd).toFixed(4)}
                    </td>
                    <td style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {run.triggeredBy ?? "—"}
                    </td>
                    <td style={{ fontSize: 12, color: "var(--text-dim)" }}>
                      {dur !== null ? `${dur}s` : "—"}
                    </td>
                    <td style={{ fontSize: 12, color: "var(--text-dim)" }}>
                      {formatDistanceToNow(run.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 20 }}>
          {page > 1 && (
            <Link href={`/runs?page=${page - 1}${statusFilter ? `&status=${statusFilter}` : ""}`} className="btn btn-secondary btn-sm">
              ← Previous
            </Link>
          )}
          <span style={{ fontSize: 12, color: "var(--text-muted)", padding: "6px 0" }}>
            Page {page} of {totalPages}
          </span>
          {page < totalPages && (
            <Link href={`/runs?page=${page + 1}${statusFilter ? `&status=${statusFilter}` : ""}`} className="btn btn-secondary btn-sm">
              Next →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

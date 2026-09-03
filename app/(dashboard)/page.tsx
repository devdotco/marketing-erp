import { getServerSession } from "@/lib/session";
import { redirect } from "next/navigation";
import { resolveWorkspaceId, getDashboardStats } from "@/lib/actions/workspace";
import { AGENTS, SUITES } from "@/lib/agents";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatDistanceToNow } from "@/lib/utils";

export const metadata = { title: "Dashboard — marketing.erp.io" };

const STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  RUNNING: "Running",
  AWAITING_APPROVAL: "Needs approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  COMPLETED: "Completed",
  FAILED: "Failed",
};

const STATUS_BADGE: Record<string, string> = {
  PENDING: "badge-pending",
  RUNNING: "badge-running",
  AWAITING_APPROVAL: "badge-awaiting",
  APPROVED: "badge-approved",
  REJECTED: "badge-rejected",
  COMPLETED: "badge-completed",
  FAILED: "badge-failed",
};

export default async function DashboardPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");

  const [stats, enabledConfigs, workspace] = await Promise.all([
    getDashboardStats(workspaceId),
    prisma.agentConfig.findMany({
      where: { workspaceId, enabled: true },
      select: { agentSlug: true },
    }),
    prisma.workspace.findUnique({ where: { id: workspaceId } }),
  ]);

  const enabledSlugs = new Set((enabledConfigs as { agentSlug: string }[]).map((c) => c.agentSlug));

  // Suite stats
  const suiteStats = SUITES.map((suite) => {
    const suiteAgents = AGENTS.filter((a) => a.suite === suite.slug);
    const enabled = suiteAgents.filter((a) => enabledSlugs.has(a.slug)).length;
    const active = suiteAgents.filter((a) => a.status === "ACTIVE").length;
    return { suite, total: suiteAgents.length, enabled, active };
  });

  // Business profile check for CTA
  const profile = await prisma.businessProfile.findUnique({ where: { workspaceId } });
  const onboardingDone = !!profile?.onboardingCompletedAt;

  return (
    <div className="scrollable">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 6 }}>
            {workspace?.name}
          </p>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 0 }}>
            Dashboard
          </h1>
        </div>
        <Link href="/agents" className="btn btn-primary">
          + Enable agent
        </Link>
      </div>

      {/* Onboarding CTA — shown until onboarding is complete */}
      {!onboardingDone && (
        <div
          style={{
            background: "var(--success-bg)",
            border: "1px solid var(--success)",
            borderRadius: "var(--radius)",
            padding: "16px 20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 24,
            gap: 16,
          }}
        >
          <div>
            <p style={{ fontSize: 13, fontWeight: 600, color: "var(--success)", marginBottom: 2 }}>
              Finish setting up your workspace
            </p>
            <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Complete the onboarding so agents can match your brand voice and goals.
            </p>
          </div>
          <Link href="/onboarding" className="btn btn-primary btn-sm" style={{ flexShrink: 0 }}>
            Continue →
          </Link>
        </div>
      )}

      {/* Stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 28 }}>
        <div className="stat-card">
          <div className="stat-value" style={{ color: "var(--success)" }}>{stats.activeAgents}</div>
          <div className="stat-label">Active agents</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.runsToday}</div>
          <div className="stat-label">Runs today</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: stats.pendingApprovals > 0 ? "var(--warning)" : undefined }}>
            {stats.pendingApprovals}
          </div>
          <div className="stat-label">Pending approvals</div>
          {stats.pendingApprovals > 0 && (
            <div className="stat-delta">
              <Link href="/runs?status=AWAITING_APPROVAL" style={{ color: "var(--warning)", textDecoration: "underline", fontSize: 11 }}>
                Review →
              </Link>
            </div>
          )}
        </div>
        <div className="stat-card">
          <div className="stat-value">${stats.monthlySpend.toFixed(2)}</div>
          <div className="stat-label">Cost this month</div>
        </div>
      </div>

      {/* Suite grid */}
      <div style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 14 }}>
          Agent suites
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
          {suiteStats.map(({ suite, total, enabled, active }) => (
            <Link
              key={suite.slug}
              href={`/agents/suite/${suite.slug}`}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                padding: "14px 16px",
                textDecoration: "none",
                transition: "border-color 0.15s",
              }}
              className="card-link"
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{suite.name}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
                <span style={{ color: "var(--text-dim)" }}>{total} agents</span>
                {active > 0 && (
                  <span style={{ color: "var(--success)" }}>· {active} live</span>
                )}
                {enabled > 0 && (
                  <span
                    style={{
                      marginLeft: "auto",
                      background: "var(--success-bg)",
                      color: "var(--success)",
                      fontSize: 10,
                      fontWeight: 600,
                      padding: "1px 6px",
                      borderRadius: 3,
                    }}
                  >
                    {enabled} enabled
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* Recent runs */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
            Recent runs
          </h2>
          <Link href="/runs" style={{ fontSize: 12, color: "var(--text-dim)", textDecoration: "none" }}>
            View all →
          </Link>
        </div>

        {stats.recentRuns.length === 0 ? (
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "40px 24px",
              textAlign: "center",
            }}
          >
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>No runs yet</p>
            <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 16 }}>
              Enable an agent and run it to see results here.
            </p>
            <Link href="/agents" className="btn btn-secondary btn-sm">
              Browse agents →
            </Link>
          </div>
        ) : (
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              overflow: "hidden",
            }}
          >
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Status</th>
                    <th>Cost</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.recentRuns.map((run) => {
                    const agent = AGENTS.find((a) => a.slug === run.agentConfig.agentSlug);
                    return (
                      <tr key={run.id}>
                        <td>
                          <Link
                            href={`/runs/${run.id}`}
                            style={{ textDecoration: "none", color: "var(--text)", fontWeight: 500, fontSize: 12, fontFamily: "monospace" }}
                          >
                            {agent?.name ?? run.agentConfig.agentSlug}
                          </Link>
                        </td>
                        <td>
                          <span className={`badge ${STATUS_BADGE[run.status] ?? "badge-muted"}`}>
                            {STATUS_LABELS[run.status] ?? run.status}
                          </span>
                        </td>
                        <td style={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}>
                          ${Number(run.costUsd).toFixed(4)}
                        </td>
                        <td style={{ fontSize: 12, color: "var(--text-dim)" }}>
                          {formatDistanceToNow(run.createdAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

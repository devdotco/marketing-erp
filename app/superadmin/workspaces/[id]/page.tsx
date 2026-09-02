import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Link from "next/link";

export default async function SuperAdminWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!session.user.isSuperAdmin) redirect("/");

  const workspace = await prisma.workspace.findUnique({
    where: { id },
    include: {
      members: { include: { user: { select: { name: true, email: true } } } },
      agentConfigs: true,
      businessProfile: true,
      _count: { select: { runs: true } },
    },
  });

  if (!workspace) notFound();

  const recentRuns = await prisma.agentRun.findMany({
    where: { workspaceId: id },
    include: { agentConfig: { select: { agentSlug: true } } },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const STATUS_BADGE: Record<string, string> = {
    PENDING: "badge-pending", RUNNING: "badge-running",
    AWAITING_APPROVAL: "badge-awaiting", APPROVED: "badge-approved",
    REJECTED: "badge-rejected", COMPLETED: "badge-completed", FAILED: "badge-failed",
  };

  return (
    <div style={{ minHeight: "100dvh", background: "var(--bg)", padding: 0 }}>
      <nav style={{ height: 48, background: "var(--surface)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", padding: "0 28px", gap: 16 }}>
        <Link href="/superadmin" style={{ fontSize: 12, color: "var(--text-dim)", textDecoration: "none" }}>← Workspaces</Link>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>/</span>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{workspace.name}</span>
        <span style={{ fontSize: 11, background: "var(--danger-bg)", color: "var(--danger)", padding: "1px 6px", borderRadius: 3, fontWeight: 600 }}>SUPER ADMIN</span>
      </nav>

      <div style={{ padding: "32px 40px", display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Overview */}
        <div className="card">
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>Workspace info</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
            {[
              ["Name", workspace.name],
              ["Slug", workspace.slug],
              ["Plan", workspace.plan],
              ["Members", String(workspace.members.length)],
              ["Total runs", String(workspace._count.runs)],
              ["Created", workspace.createdAt.toLocaleDateString()],
              ["Business", workspace.businessProfile?.businessName ?? "—"],
              ["Industry", workspace.businessProfile?.industry ?? "—"],
              ["Website", workspace.businessProfile?.websiteUrl ?? "—"],
            ].map(([label, value]) => (
              <div key={label}>
                <p style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 2 }}>{label}</p>
                <p style={{ fontSize: 13, color: "var(--text)", margin: 0, fontFamily: label === "Slug" ? "monospace" : undefined }}>
                  {value}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Members */}
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)" }}>
            <h2 style={{ fontSize: 14, fontWeight: 600 }}>Members ({workspace.members.length})</h2>
          </div>
          <table className="table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
            <tbody>
              {workspace.members.map((m) => (
                <tr key={m.id}>
                  <td style={{ fontSize: 13, fontWeight: 500 }}>{m.user.name ?? "—"}</td>
                  <td style={{ fontSize: 12, color: "var(--text-muted)" }}>{m.user.email}</td>
                  <td><span className="badge badge-pending">{m.role}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Enabled agents */}
        <div className="card">
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Enabled agents</h2>
          {workspace.agentConfigs.filter((c) => c.enabled).length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--text-muted)" }}>None enabled</p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {workspace.agentConfigs.filter((c) => c.enabled).map((c) => (
                <span key={c.id} style={{ fontSize: 11, padding: "2px 8px", background: "var(--success-bg)", color: "var(--success)", borderRadius: 3, fontFamily: "monospace" }}>
                  {c.agentSlug}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Recent runs */}
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)" }}>
            <h2 style={{ fontSize: 14, fontWeight: 600 }}>Recent runs</h2>
          </div>
          {recentRuns.length === 0 ? (
            <div style={{ padding: "28px 20px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>No runs yet</div>
          ) : (
            <table className="table">
              <thead><tr><th>Agent</th><th>Status</th><th>Cost</th><th>When</th></tr></thead>
              <tbody>
                {recentRuns.map((run) => (
                  <tr key={run.id}>
                    <td style={{ fontSize: 12, fontFamily: "monospace" }}>{run.agentConfig.agentSlug}</td>
                    <td><span className={`badge ${STATUS_BADGE[run.status] ?? "badge-muted"}`}>{run.status}</span></td>
                    <td style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>${Number(run.costUsd).toFixed(4)}</td>
                    <td style={{ fontSize: 12, color: "var(--text-dim)" }}>{run.createdAt.toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

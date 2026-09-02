import { getServerSession } from "@/lib/session";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import Link from "next/link";

export const metadata = { title: "Super Admin — marketing.erp.io" };

export default async function SuperAdminPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");
  if (!session.user.isSuperAdmin) redirect("/");

  const [workspaces, totalUsers, totalRuns, totalCost] = await Promise.all([
    prisma.workspace.findMany({
      include: {
        _count: { select: { members: true, runs: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.user.count(),
    prisma.agentRun.count(),
    prisma.agentRun.aggregate({ _sum: { costUsd: true } }),
  ]);

  return (
    <div style={{ minHeight: "100dvh", background: "var(--bg)", padding: "0" }}>
      {/* Admin nav */}
      <nav
        style={{
          height: 48,
          background: "var(--surface)",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          padding: "0 28px",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginRight: "auto" }}>
          <div style={{ width: 22, height: 22, background: "var(--text)", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ color: "var(--bg)", fontSize: 10, fontWeight: 700 }}>M</span>
          </div>
          <span style={{ fontSize: 12, fontWeight: 600 }}>marketing.erp.io</span>
          <span style={{ fontSize: 11, background: "var(--danger-bg)", color: "var(--danger)", padding: "1px 6px", borderRadius: 3, fontWeight: 600 }}>SUPER ADMIN</span>
        </div>
        <Link href="/" className="btn btn-ghost btn-sm">← Back to app</Link>
      </nav>

      <div style={{ padding: "32px 40px" }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 24 }}>Platform overview</h1>

        {/* Stat row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 32 }}>
          {[
            { label: "Workspaces", value: workspaces.length },
            { label: "Total users", value: totalUsers },
            { label: "Total runs", value: totalRuns },
            { label: "Total cost", value: `$${Number(totalCost._sum.costUsd ?? 0).toFixed(2)}` },
          ].map(({ label, value }) => (
            <div key={label} className="stat-card">
              <div className="stat-value" style={{ fontSize: 24 }}>{value}</div>
              <div className="stat-label">{label}</div>
            </div>
          ))}
        </div>

        {/* Workspaces table */}
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ fontSize: 14, fontWeight: 600 }}>Workspaces</h2>
          </div>
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Slug</th><th>Plan</th><th>Members</th><th>Runs</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {workspaces.map((ws) => (
                <tr key={ws.id}>
                  <td style={{ fontWeight: 500, fontSize: 13 }}>{ws.name}</td>
                  <td style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-muted)" }}>{ws.slug}</td>
                  <td>
                    <span style={{
                      fontSize: 10,
                      fontWeight: 600,
                      padding: "2px 6px",
                      borderRadius: 3,
                      background: ws.plan === "FREE" ? "var(--surface-2)" : "var(--success-bg)",
                      color: ws.plan === "FREE" ? "var(--text-dim)" : "var(--success)",
                    }}>
                      {ws.plan}
                    </span>
                  </td>
                  <td style={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}>{ws._count.members}</td>
                  <td style={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}>{ws._count.runs}</td>
                  <td style={{ fontSize: 12, color: "var(--text-dim)" }}>
                    {ws.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </td>
                  <td>
                    <Link href={`/superadmin/workspaces/${ws.id}`} style={{ fontSize: 11, color: "var(--text-dim)", textDecoration: "none" }}>
                      View →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

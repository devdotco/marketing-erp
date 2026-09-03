import { getServerSession } from "@/lib/session";
import { redirect } from "next/navigation";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { InviteForm } from "./InviteForm";

export const metadata = { title: "Members — marketing.erp.io" };

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "Super Admin",
  WORKSPACE_ADMIN: "Admin",
  OPERATOR: "Operator",
  VIEWER: "Viewer",
};

export default async function MembersPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");

  await requireWorkspaceAccess(workspaceId, "WORKSPACE_ADMIN");

  const [members, pendingInvites] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.invitation.findMany({
      where: { workspaceId, acceptedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return (
    <div className="scrollable">
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 6 }}>Members</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Manage who has access to this workspace.</p>
      </div>

      <div style={{ display: "flex", gap: 4, marginBottom: 24, borderBottom: "1px solid var(--border)", paddingBottom: 12 }}>
        <Link href="/settings" className="btn btn-ghost btn-sm">General</Link>
        <Link href="/settings/members" className="btn btn-primary btn-sm">Members ({members.length})</Link>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Current members */}
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)" }}>
            <h2 style={{ fontSize: 14, fontWeight: 600 }}>Members ({members.length})</h2>
          </div>
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th></tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td style={{ fontWeight: 500, fontSize: 13 }}>{m.user.name ?? "—"}</td>
                  <td style={{ fontSize: 12, color: "var(--text-muted)" }}>{m.user.email}</td>
                  <td>
                    <span style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "2px 7px",
                      borderRadius: 3,
                      background: m.role === "WORKSPACE_ADMIN" ? "var(--success-bg)" : "var(--surface-2)",
                      color: m.role === "WORKSPACE_ADMIN" ? "var(--success)" : "var(--text-muted)",
                    }}>
                      {ROLE_LABELS[m.role] ?? m.role}
                    </span>
                  </td>
                  <td style={{ fontSize: 12, color: "var(--text-dim)" }}>
                    {m.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pending invites */}
        {pendingInvites.length > 0 && (
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)" }}>
              <h2 style={{ fontSize: 14, fontWeight: 600 }}>Pending invites ({pendingInvites.length})</h2>
            </div>
            <table className="table">
              <thead>
                <tr><th>Email</th><th>Role</th><th>Expires</th></tr>
              </thead>
              <tbody>
                {pendingInvites.map((inv) => (
                  <tr key={inv.id}>
                    <td style={{ fontSize: 13 }}>{inv.email}</td>
                    <td>
                      <span className="badge badge-pending">{ROLE_LABELS[inv.role] ?? inv.role}</span>
                    </td>
                    <td style={{ fontSize: 12, color: "var(--text-dim)" }}>
                      {inv.expiresAt.toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Invite form */}
        <div className="card">
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>Invite member</h2>
          <InviteForm workspaceId={workspaceId} />
        </div>
      </div>
    </div>
  );
}

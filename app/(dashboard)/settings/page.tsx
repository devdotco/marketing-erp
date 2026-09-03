import { getServerSession } from "@/lib/session";
import { redirect } from "next/navigation";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { WorkspaceSettingsForm } from "./WorkspaceSettingsForm";

export const metadata = { title: "Settings — marketing.erp.io" };

export default async function SettingsPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");

  await requireWorkspaceAccess(workspaceId, "WORKSPACE_ADMIN");

  const [workspace, memberCount, businessProfile] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId } }),
    prisma.workspaceMember.count({ where: { workspaceId } }),
    prisma.businessProfile.findUnique({ where: { workspaceId } }),
  ]);

  if (!workspace) redirect("/");

  return (
    <div className="scrollable">
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 6 }}>Settings</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Manage your workspace configuration.</p>
      </div>

      {/* Nav */}
      <div style={{ display: "flex", gap: 4, marginBottom: 24, borderBottom: "1px solid var(--border)", paddingBottom: 12 }}>
        <Link href="/settings" className="btn btn-primary btn-sm">General</Link>
        <Link href="/settings/members" className="btn btn-ghost btn-sm">Members ({memberCount})</Link>
      </div>

      <div style={{ maxWidth: 560, display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Workspace info */}
        <div className="card">
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 20 }}>Workspace</h2>
          <WorkspaceSettingsForm
            workspaceId={workspaceId}
            currentName={workspace.name}
            currentSlug={workspace.slug}
            currentPlan={workspace.plan}
            businessName={businessProfile?.businessName ?? ""}
            websiteUrl={businessProfile?.websiteUrl ?? ""}
            industry={businessProfile?.industry ?? ""}
            brandVoice={(businessProfile?.brandVoice ?? {}) as Record<string, unknown>}
          />
        </div>

        {/* Danger zone */}
        <div
          style={{
            border: "1px solid var(--danger)",
            borderRadius: "var(--radius)",
            padding: "16px 20px",
          }}
        >
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: "var(--danger)" }}>Danger zone</h2>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14 }}>
            These actions are irreversible. Proceed with caution.
          </p>
          <button className="btn btn-danger btn-sm" disabled>
            Delete workspace
          </button>
          <p style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8 }}>
            Contact support to delete your workspace and all associated data.
          </p>
        </div>
      </div>
    </div>
  );
}

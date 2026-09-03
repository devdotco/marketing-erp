import { getServerSession } from "@/lib/session";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getActiveWorkspaceId, getUserWorkspaces, setActiveWorkspace } from "@/lib/actions/workspace";
import { Sidebar } from "@/components/layout/Sidebar";
import { WorkspaceCookieSync } from "@/components/layout/WorkspaceCookieSync";
import { cookies } from "next/headers";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  let session;
  try {
    session = await getServerSession();
  } catch {
    redirect("/login");
  }
  if (!session?.user) redirect("/login");

  let workspaces: Awaited<ReturnType<typeof getUserWorkspaces>> = [];
  try {
    workspaces = await getUserWorkspaces();
  } catch (err) {
    console.error("[layout] getUserWorkspaces failed:", err);
    // DB error — show empty state rather than crashing into a redirect loop
  }
  if (workspaces.length === 0) redirect("/onboarding");

  let activeWorkspaceId = await getActiveWorkspaceId();

  // Validate the cookie workspace actually belongs to this user
  if (activeWorkspaceId) {
    const valid = workspaces.some((w) => w.id === activeWorkspaceId);
    if (!valid) activeWorkspaceId = null;
  }

  // Default to first workspace (don't call setActiveWorkspace during render —
  // cookies().set() is forbidden in Server Components; workspace cookie is set
  // the next time the user switches workspace via a Server Action)
  if (!activeWorkspaceId && workspaces.length > 0) {
    activeWorkspaceId = workspaces[0].id;
  }

  // Get enabled agent counts per suite for sidebar badges
  const enabledConfigs = await prisma.agentConfig.findMany({
    where: { workspaceId: activeWorkspaceId!, enabled: true },
    select: { agentSlug: true },
  });

  const { AGENTS } = await import("@/lib/agents");
  const enabledCounts: Record<string, number> = {};
  for (const config of enabledConfigs as { agentSlug: string }[]) {
    const agent = AGENTS.find((a) => a.slug === config.agentSlug);
    if (agent) {
      enabledCounts[agent.suite] = (enabledCounts[agent.suite] || 0) + 1;
    }
  }

  const userForSidebar = {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    image: session.user.image,
  };

  const workspacesForSidebar = workspaces.map((w: typeof workspaces[number]) => ({
    id: w.id,
    name: w.name,
    slug: w.slug,
    plan: w.plan,
    members: w.members,
  }));

  return (
    <div className="page-shell">
      {activeWorkspaceId && <WorkspaceCookieSync workspaceId={activeWorkspaceId} />}
      <Sidebar
        workspaces={workspacesForSidebar}
        activeWorkspaceId={activeWorkspaceId}
        user={userForSidebar}
        enabledCounts={enabledCounts}
      />
      <div className="main-content">
        {children}
      </div>
    </div>
  );
}

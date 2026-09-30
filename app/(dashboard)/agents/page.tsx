import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import { AGENTS, SUITES } from "@/lib/agents";
import { getAgentReadiness } from "@/lib/agent-readiness";
import { AgentsBrowser } from "@/components/agents/AgentsBrowser";

export const dynamic = "force-dynamic";
/*
 * Signed-in landing for the module (there is no /dashboard route), so this one
 * page carries the brand on its own rather than "Agents | …" in front of it.
 * `absolute` is what stops the root layout's template applying.
 */
export const metadata = {
  title: { absolute: "Marketing ERP | ERP.io" },
  description: "Every marketing agent in your workspace, what it needs, and what is waiting on you.",
};

export default async function AgentsPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");
  await requireWorkspaceAccess(workspaceId);

  const readiness = await getAgentReadiness(workspaceId);

  const needsYou = Object.values(readiness).filter((r) => r.group === "needs-you").length;

  return (
    <div className="scrollable">
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 4 }}>Agents</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          {AGENTS.length} agents across {SUITES.length} suites
          {needsYou > 0 && ` · ${needsYou} waiting on you`}
        </p>
      </div>

      <AgentsBrowser agents={AGENTS} suites={SUITES} readiness={readiness} />
    </div>
  );
}

import { notFound, redirect } from "next/navigation";
import { getServerSession } from "@/lib/session";
import { getAgentsBySuite, getSuite, SUITES } from "@/lib/agents";
import { prisma } from "@/lib/prisma";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function SuiteDetailPage({ params }: { params: Promise<{ suite: string }> }) {
  const { suite: suiteSlug } = await params;
  const suite = getSuite(suiteSlug);
  if (!suite) notFound();

  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");

  await requireWorkspaceAccess(workspaceId);

  const agents = getAgentsBySuite(suiteSlug);

  const enabledConfigs = await prisma.agentConfig.findMany({
    where: { workspaceId, agentSlug: { in: agents.map((a) => a.slug) } },
    select: { agentSlug: true, enabled: true },
  });
  const enabledMap = new Map(enabledConfigs.map((c) => [c.agentSlug, c.enabled]));

  const activeAgents = agents.filter((a) => a.status === "ACTIVE");
  const comingSoon = agents.filter((a) => a.status !== "ACTIVE");
  const enabledCount = agents.filter((a) => enabledMap.get(a.slug)).length;

  return (
    <div className="scrollable">
      <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 20 }}>
        <Link href="/agents" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Agents</Link>
        {" / "}
        <span>{suite.name}</span>
      </div>

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 6 }}>
            {suite.name}
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {agents.length} agents · {activeAgents.length} live
            {enabledCount > 0 && ` · ${enabledCount} enabled`}
          </p>
        </div>
        <Link href="/agents" className="btn btn-ghost btn-sm">← All agents</Link>
      </div>

      {activeAgents.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-dim)", marginBottom: 14 }}>
            Live now
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {activeAgents.map((agent) => {
              const isEnabled = enabledMap.get(agent.slug) === true;
              return (
                <Link
                  key={agent.slug}
                  href={`/agents/${agent.slug}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                    padding: "16px 20px",
                    background: "var(--surface)",
                    border: `1px solid ${isEnabled ? "var(--success)" : "var(--border)"}`,
                    borderLeft: `3px solid ${isEnabled ? "var(--success)" : "var(--border)"}`,
                    borderRadius: "var(--radius)",
                    textDecoration: "none",
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", fontFamily: "monospace" }}>
                        {agent.name}
                      </span>
                      <span className="badge badge-active">Live</span>
                      {isEnabled && <span className="badge badge-completed">Enabled</span>}
                    </div>
                    <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>{agent.description}</p>
                  </div>
                  <span style={{ fontSize: 12, color: "var(--text-dim)", flexShrink: 0 }}>→</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {comingSoon.length > 0 && (
        <div>
          <h2 style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-dim)", marginBottom: 14 }}>
            Coming soon
          </h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
            {comingSoon.map((agent) => (
              <Link
                key={agent.slug}
                href={`/agents/${agent.slug}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  padding: "14px 16px",
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  textDecoration: "none",
                  opacity: 0.75,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", fontFamily: "monospace" }}>
                    {agent.name}
                  </span>
                  <span className="badge badge-soon">Soon</span>
                </div>
                <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>{agent.description}</p>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

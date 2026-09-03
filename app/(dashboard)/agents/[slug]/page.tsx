import { notFound } from "next/navigation";
import { getServerSession } from "@/lib/session";
import { redirect } from "next/navigation";
import { getAgent, AGENTS } from "@/lib/agents";
import { AGENT_META } from "@/lib/agent-metadata";
import { prisma } from "@/lib/prisma";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import Link from "next/link";
import { AgentToggle } from "@/components/ui/AgentToggle";
import { RunModal } from "@/components/ui/RunModal";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const agent = getAgent(slug);
  if (!agent) return { title: "Not found" };
  return { title: `${agent.name} — marketing.erp.io` };
}

export default async function AgentDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const agent = getAgent(slug);
  if (!agent) notFound();

  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");

  await requireWorkspaceAccess(workspaceId);

  const [agentConfig, recentRuns] = await Promise.all([
    prisma.agentConfig.findUnique({
      where: { workspaceId_agentSlug: { workspaceId, agentSlug: slug } },
    }),
    prisma.agentRun.findMany({
      where: { workspaceId, agentConfig: { agentSlug: slug } },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);

  const isEnabled = agentConfig?.enabled ?? false;
  const isActive = agent.status === "ACTIVE";
  const meta = AGENT_META[slug];

  const STATUS_BADGE: Record<string, string> = {
    PENDING: "badge-pending", RUNNING: "badge-running",
    AWAITING_APPROVAL: "badge-awaiting", APPROVED: "badge-approved",
    REJECTED: "badge-rejected", COMPLETED: "badge-completed", FAILED: "badge-failed",
  };

  return (
    <div className="scrollable">
      {/* Breadcrumb */}
      <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 20 }}>
        <Link href="/agents" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Agents</Link>
        {" / "}
        <Link href={`/agents/suite/${agent.suite}`} style={{ color: "var(--text-dim)", textDecoration: "none" }}>
          {agent.suiteName}
        </Link>
        {" / "}
        <span>{agent.name}</span>
      </div>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 20, marginBottom: 32 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", fontFamily: "monospace" }}>
              {agent.name}
            </h1>
            <span className={`badge ${isActive ? "badge-active" : "badge-soon"}`}>
              {isActive ? "Live" : "Coming soon"}
            </span>
            {isEnabled && <span className="badge badge-completed">Enabled</span>}
          </div>
          <p style={{ fontSize: 14, color: "var(--text-muted)", maxWidth: 600, lineHeight: 1.65 }}>
            {agent.description}
          </p>
        </div>

        {isActive && (
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <AgentToggle
              workspaceId={workspaceId}
              agentSlug={slug}
              enabled={isEnabled}
              agentConfigId={agentConfig?.id}
            />
            {isEnabled && (
              <RunModal
                workspaceId={workspaceId}
                agentSlug={slug}
                agentName={agent.name}
                agentConfigId={agentConfig?.id}
                inputs={meta?.inputs ?? []}
                savedConfig={(agentConfig?.config ?? {}) as Record<string, unknown>}
              />
            )}
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 20 }}>
        {/* Left — main content */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Configure panel (active agents only) */}
          {isActive && isEnabled && (
            <div className="card">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <h2 style={{ fontSize: 14, fontWeight: 600 }}>Configuration</h2>
                <Link href={`/agents/${slug}/configure`} className="btn btn-secondary btn-sm">
                  Edit config →
                </Link>
              </div>
              {agentConfig?.config && Object.keys(agentConfig.config as object).length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {Object.entries(agentConfig.config as Record<string, unknown>).map(([k, v]) => (
                    <div key={k} style={{ display: "flex", gap: 12, fontSize: 13 }}>
                      <span style={{ color: "var(--text-dim)", minWidth: 140, fontFamily: "monospace", fontSize: 12 }}>{k}</span>
                      <span style={{ color: "var(--text-muted)" }}>{String(v)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
                  No configuration yet.{" "}
                  <Link href={`/agents/${slug}/configure`} style={{ color: "var(--success)" }}>
                    Set it up →
                  </Link>
                </p>
              )}
            </div>
          )}

          {/* Enable prompt for active-but-not-enabled */}
          {isActive && !isEnabled && (
            <div
              style={{
                background: "var(--surface-2)",
                border: "1px dashed var(--border-strong)",
                borderRadius: "var(--radius)",
                padding: "28px 24px",
                textAlign: "center",
              }}
            >
              <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>This agent is ready to use</p>
              <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16 }}>
                Enable it for your workspace to start running it.
              </p>
              <AgentToggle workspaceId={workspaceId} agentSlug={slug} enabled={false} agentConfigId={undefined} showLabel />
            </div>
          )}

          {/* Coming soon state */}
          {!isActive && (
            <div
              style={{
                background: "var(--warning-bg)",
                border: "1px solid var(--warning)",
                borderRadius: "var(--radius)",
                padding: "20px 24px",
              }}
            >
              <p style={{ fontSize: 13, fontWeight: 600, color: "var(--warning)", marginBottom: 4 }}>
                This agent is coming soon
              </p>
              <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
                You can pre-configure it now so it's ready the moment it goes live.
              </p>
              <Link href={`/agents/${slug}/configure`} className="btn btn-secondary btn-sm" style={{ marginTop: 12 }}>
                Pre-configure →
              </Link>
            </div>
          )}

          {/* How it works */}
          {meta && (
            <div className="card">
              <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>How it works</h2>
              <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.7, marginBottom: 20 }}>
                {meta.overview}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                {meta.steps.map((step, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      gap: 14,
                      paddingBottom: i < meta.steps.length - 1 ? 16 : 0,
                      marginBottom: i < meta.steps.length - 1 ? 16 : 0,
                      borderBottom: i < meta.steps.length - 1 ? "1px solid var(--border)" : "none",
                    }}
                  >
                    <div
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: "50%",
                        background: "var(--success-bg)",
                        border: "1px solid var(--success)",
                        color: "var(--success)",
                        fontSize: 10,
                        fontWeight: 700,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                        marginTop: 1,
                      }}
                    >
                      {i + 1}
                    </div>
                    <div>
                      <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>
                        {step.title}
                      </p>
                      <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, margin: 0 }}>
                        {step.detail}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              {meta.outputs.length > 0 && (
                <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
                  <p style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-dim)", marginBottom: 10 }}>
                    Outputs
                  </p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {meta.outputs.map((o) => (
                      <span
                        key={o}
                        style={{
                          fontSize: 11,
                          background: "var(--surface-2)",
                          border: "1px solid var(--border)",
                          borderRadius: 4,
                          padding: "3px 8px",
                          color: "var(--text-muted)",
                        }}
                      >
                        {o}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {meta.requirements.length > 0 && (
                <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
                  <p style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-dim)", marginBottom: 10 }}>
                    Requirements
                  </p>
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {meta.requirements.map((r) => (
                      <li key={r} style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.7 }}>
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Recent runs */}
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ fontSize: 14, fontWeight: 600 }}>Recent runs</h2>
              <Link href={`/runs?agent=${slug}`} style={{ fontSize: 12, color: "var(--text-dim)", textDecoration: "none" }}>View all →</Link>
            </div>
            {recentRuns.length === 0 ? (
              <div style={{ padding: "32px 20px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                No runs yet for this agent in this workspace.
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr><th>Status</th><th>Cost</th><th>Started</th><th>Duration</th></tr>
                </thead>
                <tbody>
                  {recentRuns.map((run) => {
                    const dur = run.completedAt && run.startedAt
                      ? Math.round((run.completedAt.getTime() - run.startedAt.getTime()) / 1000)
                      : null;
                    return (
                      <tr key={run.id}>
                        <td>
                          <Link href={`/runs/${run.id}`} style={{ textDecoration: "none" }}>
                            <span className={`badge ${STATUS_BADGE[run.status] ?? "badge-muted"}`}>{run.status}</span>
                          </Link>
                        </td>
                        <td style={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}>${Number(run.costUsd).toFixed(4)}</td>
                        <td style={{ fontSize: 12, color: "var(--text-dim)" }}>
                          {run.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </td>
                        <td style={{ fontSize: 12, color: "var(--text-dim)" }}>
                          {dur !== null ? `${dur}s` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Right — metadata sidebar */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card">
            <h3 style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-dim)", marginBottom: 14 }}>Details</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div>
                <p style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 2 }}>Suite</p>
                <Link href={`/agents/suite/${agent.suite}`} style={{ fontSize: 13, color: "var(--text)", textDecoration: "none" }}>
                  {agent.suiteName}
                </Link>
              </div>
              <div>
                <p style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 2 }}>Cadence</p>
                <p style={{ fontSize: 13, color: "var(--text)", margin: 0 }}>{agent.cadence}</p>
              </div>
              <div>
                <p style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 2 }}>Status</p>
                <span className={`badge ${isActive ? "badge-active" : "badge-soon"}`}>{isActive ? "Active" : "Coming soon"}</span>
              </div>
            </div>
          </div>

          {agent.integrations.length > 0 && (
            <div className="card">
              <h3 style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-dim)", marginBottom: 14 }}>Integrations</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {agent.integrations.map((int) => (
                  <div key={int} style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--text-dim)", display: "inline-block" }} />
                    {int}
                  </div>
                ))}
              </div>
              <Link href="/integrations" className="btn btn-ghost btn-sm" style={{ marginTop: 12, paddingLeft: 0 }}>
                Manage integrations →
              </Link>
            </div>
          )}

          {agent.companions.length > 0 && (
            <div className="card">
              <h3 style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-dim)", marginBottom: 14 }}>Works with</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {agent.companions.map((c) => {
                  const companion = AGENTS.find((a) => a.slug === c);
                  return companion ? (
                    <Link key={c} href={`/agents/${c}`} style={{ fontSize: 12, color: "var(--text-muted)", textDecoration: "none", display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontFamily: "monospace" }}>{companion.name}</span>
                      <span style={{ marginLeft: "auto", fontSize: 10 }}>→</span>
                    </Link>
                  ) : null;
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

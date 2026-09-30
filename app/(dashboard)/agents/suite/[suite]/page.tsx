import { notFound, redirect } from "next/navigation";
import { getServerSession } from "@/lib/session";
import { getAgentsBySuite, getSuite } from "@/lib/agents";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import { getAgentReadiness } from "@/lib/agent-readiness";
import { PIPELINES } from "@/lib/agent-pipelines";
import { AgentCard } from "@/components/agents/AgentCard";
import Link from "next/link";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ suite: string }> }) {
  const { suite } = await params;
  const found = getSuite(suite);
  if (!found) return { title: "Not found" };
  return { title: found.name, description: found.description };
}

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
  const readiness = await getAgentReadiness(workspaceId);
  const pipeline = PIPELINES[suiteSlug];

  // Same order as the grid: anything we have shipped first, the rest after.
  const ordered = [...agents].sort((a, b) => Number(a.status !== "ACTIVE") - Number(b.status !== "ACTIVE"));
  const needsYou = ordered.filter((a) => readiness[a.slug]?.group === "needs-you").length;

  return (
    <div className="scrollable">
      <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 20 }}>
        <Link href="/agents" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Agents</Link>
        {" / "}
        <span>{suite.name}</span>
      </div>

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 6 }}>{suite.name}</h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {suite.description}
            {needsYou > 0 && ` · ${needsYou} waiting on you`}
          </p>
        </div>
        <Link href="/agents" className="btn btn-ghost btn-sm">← All agents</Link>
      </div>

      {pipeline && (
        <section className="pipeline" aria-label={pipeline.name}>
          <div className="pipeline__head">
            <span className="pipeline__title">{pipeline.name}</span>
            <span className="pipeline__hint">Each step feeds the next</span>
          </div>
          <div className="pipeline__steps">
            {pipeline.steps.map((slug, i) => {
              const agent = agents.find((a) => a.slug === slug);
              const state = readiness[slug];
              if (!agent || !state) return null;
              return (
                <div key={slug} className="pipeline__step-wrap">
                  {i > 0 && <span className="pipeline__arrow" aria-hidden>→</span>}
                  <Link href={`/agents/${slug}`} className="pipeline__step">
                    <span className="pipeline__step-name">{agent.name}</span>
                    <span className={`pipeline__step-state status-pill--${state.tone}`}>
                      <span className="status-pill__dot" />
                      {state.label}
                    </span>
                  </Link>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <div className="agent-grid">
        {ordered.map((agent) => {
          const state = readiness[agent.slug];
          return state ? <AgentCard key={agent.slug} agent={agent} readiness={state} /> : null;
        })}
      </div>
    </div>
  );
}

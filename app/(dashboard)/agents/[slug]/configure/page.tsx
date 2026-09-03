import { notFound, redirect } from "next/navigation";
import { getServerSession } from "@/lib/session";
import { getAgent } from "@/lib/agents";
import { AGENT_META } from "@/lib/agent-metadata";
import { prisma } from "@/lib/prisma";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import Link from "next/link";
import { ConfigureForm } from "./ConfigureForm";

export default async function ConfigurePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const agent = getAgent(slug);
  if (!agent) notFound();

  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");

  await requireWorkspaceAccess(workspaceId, "OPERATOR");

  const agentConfig = await prisma.agentConfig.findUnique({
    where: { workspaceId_agentSlug: { workspaceId, agentSlug: slug } },
  });

  const currentConfig = (agentConfig?.config ?? {}) as Record<string, unknown>;
  const meta = AGENT_META[slug];

  return (
    <div className="scrollable">
      <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 20 }}>
        <Link href="/agents" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Agents</Link>
        {" / "}
        <Link href={`/agents/${slug}`} style={{ color: "var(--text-dim)", textDecoration: "none" }}>{agent.name}</Link>
        {" / Configure"}
      </div>

      <div style={{ maxWidth: 560 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 6 }}>
          Configure {agent.name}
        </h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 28, lineHeight: 1.65 }}>
          {agent.status === "COMING_SOON"
            ? "Pre-configure this agent so it's ready when it goes live."
            : "Set how this agent behaves for your workspace."}
        </p>

        <ConfigureForm
          workspaceId={workspaceId}
          agentSlug={slug}
          agentName={agent.name}
          agentConfigId={agentConfig?.id}
          currentConfig={currentConfig}
          integrations={agent.integrations}
          inputs={meta?.inputs ?? []}
        />
      </div>
    </div>
  );
}

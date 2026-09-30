/**
 * What each agent needs before it will do anything — computed per workspace.
 *
 * The agents grid used to show two facts: whether we had shipped the agent
 * ("Live"/"Soon") and a list of integration names. Neither answered the only
 * question a person actually has in front of that grid — *can this one run for
 * me, and if not, what do I do about it?* A workspace with an unconnected CMS
 * and three drafts waiting for review looked exactly like a workspace with
 * nothing set up at all.
 *
 * Every field is derived from stored state — configs, runs, connected
 * integrations — never guessed. The verdicts themselves live in
 * lib/agent-readiness-rules.ts; this file only fetches what they read.
 */
import { prisma } from "@/lib/prisma";
import { AGENTS } from "@/lib/agents";
import { getKeyStatus } from "@/lib/ai/client";
import { readinessFor, upstreamAgents, type AgentReadiness } from "@/lib/agent-readiness-rules";

export * from "@/lib/agent-readiness-rules";

type LatestRun = { slug: string; status: string; output: unknown };

export async function getAgentReadiness(workspaceId: string): Promise<Record<string, AgentReadiness>> {
  const upstreamSlugs = [...new Set(AGENTS.flatMap((a) => upstreamAgents(a.slug)))];

  const [configs, integrations, socialAccounts, latestRuns, awaiting, upstreamRuns, keyStatus] = await Promise.all([
    prisma.agentConfig.findMany({ where: { workspaceId }, select: { agentSlug: true, enabled: true } }),
    prisma.integration.findMany({ where: { workspaceId }, select: { provider: true } }),
    prisma.socialAccount.findMany({ where: { workspaceId }, select: { platform: true } }),
    // One row per agent: its newest run, whatever that run did. Prisma has no
    // "latest per group", and fifty-seven findFirst calls on a page render is
    // not a trade worth making.
    prisma.$queryRaw<LatestRun[]>`
      SELECT DISTINCT ON (c."agentSlug") c."agentSlug" AS slug, r.status::text AS status, r.output
      FROM "AgentRun" r
      JOIN "AgentConfig" c ON c.id = r."agentConfigId"
      WHERE r."workspaceId" = ${workspaceId}
      ORDER BY c."agentSlug", r."createdAt" DESC
    `,
    prisma.agentRun.findMany({
      where: { workspaceId, status: "AWAITING_APPROVAL" },
      select: { agentConfig: { select: { agentSlug: true } } },
    }),
    upstreamSlugs.length
      ? prisma.agentRun.findMany({
          where: {
            workspaceId,
            status: { in: ["APPROVED", "COMPLETED"] },
            agentConfig: { agentSlug: { in: upstreamSlugs } },
          },
          select: { output: true, agentConfig: { select: { agentSlug: true } } },
        })
      : Promise.resolve([] as { output: unknown; agentConfig: { agentSlug: string } }[]),
    // A key we cannot resolve is the same as no key for this purpose, and a
    // provider hiccup must not take the whole grid down with it.
    getKeyStatus(workspaceId).catch(() => ({ ready: false as const })),
  ]);

  const enabled = new Map(configs.map((c) => [c.agentSlug, c.enabled]));
  const connected = new Set<string>([
    ...integrations.map((i) => String(i.provider)),
    ...socialAccounts.map((a) => String(a.platform)),
  ]);
  const latest = new Map(latestRuns.map((r) => [r.slug, r]));

  const awaitingCount = new Map<string, number>();
  for (const run of awaiting) {
    const slug = run.agentConfig.agentSlug;
    awaitingCount.set(slug, (awaitingCount.get(slug) ?? 0) + 1);
  }

  // The same test the Draft ID dropdown applies (app/api/runs/drafts/route.ts):
  // an approved run with no usable payload is not something downstream can pick
  // up, so it does not unblock anything.
  const usableUpstream = new Set<string>();
  for (const run of upstreamRuns) {
    const o = run.output as Record<string, unknown> | null;
    const usable = Boolean(
      o && ((typeof o.content === "string" && o.content) || (Array.isArray(o.prospects) && o.prospects.length > 0)),
    );
    if (usable) usableUpstream.add(run.agentConfig.agentSlug);
  }

  const out: Record<string, AgentReadiness> = {};
  for (const agent of AGENTS) {
    const run = latest.get(agent.slug) ?? null;
    out[agent.slug] = readinessFor(agent, {
      enabled: enabled.get(agent.slug) === true,
      connected,
      lastRunStatus: run?.status ?? null,
      lastRunError: (run?.output as { error?: { message?: string; hint?: string } } | null)?.error ?? null,
      awaiting: awaitingCount.get(agent.slug) ?? 0,
      usableUpstream,
      hasModelKey: keyStatus.ready,
    });
  }
  return out;
}

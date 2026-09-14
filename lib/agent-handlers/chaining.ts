/**
 * Outbound Engine pipeline chaining: Scout → Strategist → (Email Outbound + LinkedIn Outbound).
 *
 * Before this existed, nothing handed one agent's output to the next — a person had to copy
 * prospect ids out of Scout's run and paste them into Strategist's "Prospect (JSON)" field, then
 * again into Email/LinkedIn Outbound's "Prospect ID" field, by hand, for every prospect. See the
 * task report for the full before/after.
 *
 * Called from two places: workers/agent-worker.ts right after it marks a run COMPLETED (the
 * requireApproval=false path for Scout, and always for Strategist, which never awaits approval
 * itself), and app/api/runs/[runId]/approve/route.ts right after a Scout run is approved (the
 * requireApproval=true path — Scout has no on-approve.ts hook of its own, so nothing else runs at
 * approval time). Both call sites pass the run in whatever state it just settled into.
 *
 * Idempotent by construction, not by a check-then-create race: AgentRun has a unique
 * (parentRunId, agentConfigId) index (see prisma/migrations/20260914180000_add_agent_run_chaining),
 * so a second call for the same parent (a retried worker job, a duplicate approval attempt that
 * slipped through) hits a unique-constraint violation on the create and is treated as "already
 * chained" rather than creating a second child run for the same agent.
 *
 * Chaining only ever stages: it creates PENDING runs the normal queue picks up, and Email/LinkedIn
 * Outbound stop at AWAITING_APPROVAL exactly as they do when triggered by hand — nothing here ever
 * calls an activate*() function or an integration's send API.
 */
import { Prisma, type AgentRun, type AgentConfig } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enqueueAgentRun } from "@/lib/queue";
import { parsePlayConfig, type OutboundPlayConfig } from "./outbound-play-config";
import { planScoutChaining, planStrategistChaining } from "./outbound-chain-plan";

// Re-exported so any existing caller/import of the planners from this file keeps working — the
// actual implementation lives in outbound-chain-plan.ts, which imports neither Prisma nor BullMQ,
// so it (and test/content.test.ts, which imports the planners directly from there) can be pulled
// into the test bundle without either. See that file for why the split exists.
export { planScoutChaining, planStrategistChaining, type ChainTarget } from "./outbound-chain-plan";

type ChainResult = { agentSlug: string; runId?: string; skipped?: string };

async function enqueueChildRun(
  parent: AgentRun & { agentConfig: AgentConfig },
  agentSlug: string,
  input: Record<string, unknown>,
): Promise<ChainResult> {
  const childConfig = await prisma.agentConfig.findUnique({
    where: { workspaceId_agentSlug: { workspaceId: parent.workspaceId, agentSlug } },
  });
  if (!childConfig || !childConfig.enabled) {
    return { agentSlug, skipped: "agent not enabled" };
  }

  try {
    const child = await prisma.agentRun.create({
      data: {
        workspaceId: parent.workspaceId,
        agentConfigId: childConfig.id,
        parentRunId: parent.id,
        input: { ...input, parentRunId: parent.id } as object,
        status: "PENDING",
        triggeredBy: parent.triggeredBy ?? null,
      },
    });
    await enqueueAgentRun(child.id).catch((err) =>
      console.error(`[chaining] parent ${parent.id}: failed to enqueue child ${child.id} (${agentSlug}):`, err),
    );
    return { agentSlug, runId: child.id };
  } catch (err) {
    // P2002 = unique constraint violation on (parentRunId, agentConfigId) — this parent already
    // has a child run for this agent (a retry, or two settlement paths racing). Not an error: find
    // and report the existing child instead of creating a second one.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.agentRun.findFirst({
        where: { parentRunId: parent.id, agentConfigId: childConfig.id },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      });
      return { agentSlug, runId: existing?.id };
    }
    throw err;
  }
}

/** Looks up the parent run's play and parses its config — the one piece of DB access both
 * chainFromScout and chainFromStrategist need before consulting the pure planners above. */
async function loadPlayConfig(parent: AgentRun & { agentConfig: AgentConfig }, playSlug: string | undefined): Promise<OutboundPlayConfig | null> {
  if (!playSlug) return null;
  const play = await prisma.outboundPlay.findUnique({
    where: { workspaceId_slug: { workspaceId: parent.workspaceId, slug: playSlug } },
  });
  return play ? parsePlayConfig(play.config) : null;
}

/** Scout → Strategist. Only the prospect ids Scout itself just sourced and persisted (never a
 * simulated batch — see outbound-scout.ts, which only ever populates `prospectIds` on the live
 * Apollo path) are handed forward, and only when the play has autoAdvance on. */
async function chainFromScout(parent: AgentRun & { agentConfig: AgentConfig }): Promise<ChainResult[]> {
  const output = (parent.output ?? {}) as Record<string, unknown>;
  const playConfig = await loadPlayConfig(parent, output.playSlug as string | undefined);
  if (!playConfig) return [];

  const target = planScoutChaining(output, playConfig);
  if (!target) return [];
  return [await enqueueChildRun(parent, target.agentSlug, target.input)];
}

/** Strategist → Email Outbound (EMAIL_ONLY + EMAIL_AND_LINKEDIN) and LinkedIn Outbound
 * (EMAIL_AND_LINKEDIN only) — one child run per agent, each carrying exactly the prospect ids
 * routed to it this run. WATCHLIST/DISCARDED prospects are never forwarded. */
async function chainFromStrategist(parent: AgentRun & { agentConfig: AgentConfig }): Promise<ChainResult[]> {
  const output = (parent.output ?? {}) as Record<string, unknown>;
  const playConfig = await loadPlayConfig(parent, output.playSlug as string | undefined);
  if (!playConfig) return [];

  const targets = planStrategistChaining(output, playConfig);
  return Promise.all(targets.map((t) => enqueueChildRun(parent, t.agentSlug, t.input)));
}

/**
 * Entry point — call once per settled Scout/Strategist run (completed, or approved for Scout).
 * No-ops for every other agent slug. Writes `chainedRuns` onto the parent's own output so the run
 * detail page can link to what it spawned (or explain why nothing was spawned); never throws on a
 * chaining failure that isn't itself a real bug — a missing/disabled downstream agent is recorded
 * as "skipped", not an error on the parent run.
 */
export async function runOutboundChaining(parent: AgentRun & { agentConfig: AgentConfig }): Promise<void> {
  const slug = parent.agentConfig.agentSlug;
  if (slug !== "outbound-scout" && slug !== "outbound-strategist") return;

  const results = slug === "outbound-scout" ? await chainFromScout(parent) : await chainFromStrategist(parent);
  if (results.length === 0) return;

  const output = (parent.output ?? {}) as Record<string, unknown>;
  await prisma.agentRun.update({
    where: { id: parent.id },
    data: { output: { ...output, chainedRuns: results } as object },
  });
}

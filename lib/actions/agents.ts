"use server";

import { getServerSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getActiveWorkspaceId, requireWorkspaceAccess } from "./workspace";
import { revalidatePath } from "next/cache";
import { parseCron } from "@/lib/cron";

export async function toggleAgent(
  workspaceId: string,
  agentSlug: string,
  enabled: boolean,
  agentConfigId?: string
) {
  const session = await getServerSession();
  if (!session?.user) throw new Error("Unauthorized");
  await requireWorkspaceAccess(workspaceId, "OPERATOR");

  if (agentConfigId) {
    // updateMany, because the id arrives from the client: the workspace filter is
    // what stops an operator of one workspace toggling another's agent.
    const { count } = await prisma.agentConfig.updateMany({
      where: { id: agentConfigId, workspaceId },
      data: { enabled },
    });
    if (count === 0) throw new Error("Agent not found in this workspace");
  } else {
    await prisma.agentConfig.upsert({
      where: { workspaceId_agentSlug: { workspaceId, agentSlug } },
      create: { workspaceId, agentSlug, enabled },
      update: { enabled },
    });
  }

  revalidatePath(`/agents/${agentSlug}`);
  revalidatePath("/agents");
  revalidatePath("/");
}

export async function saveAgentConfig(
  workspaceId: string,
  agentSlug: string,
  config: Record<string, unknown>
) {
  const session = await getServerSession();
  if (!session?.user) throw new Error("Unauthorized");
  await requireWorkspaceAccess(workspaceId, "OPERATOR");

  await prisma.agentConfig.upsert({
    where: { workspaceId_agentSlug: { workspaceId, agentSlug } },
    create: { workspaceId, agentSlug, config: config as object, enabled: false },
    update: { config: config as object },
  });

  revalidatePath(`/agents/${agentSlug}`);
  revalidatePath(`/agents/${agentSlug}/configure`);
}

/**
 * Set (or clear, with `schedule: null`) how often an agent runs itself, via
 * lib/scheduler.ts. Same permission as saveAgentConfig above — a schedule is
 * just another saved setting on AgentConfig, and it never flips `enabled` on
 * its own: setting a schedule on a disabled agent saves it inert until
 * someone also enables the agent (AgentToggle), exactly like a person could
 * save Run-now defaults for an agent before turning it on.
 */
export async function setAgentSchedule(
  workspaceId: string,
  agentSlug: string,
  schedule: string | null,
  agentConfigId?: string
) {
  const session = await getServerSession();
  if (!session?.user) throw new Error("Unauthorized");
  await requireWorkspaceAccess(workspaceId, "OPERATOR");

  if (schedule !== null) {
    // Fails loudly here rather than saving a schedule the runner will just
    // log and skip every minute forever — same parser lib/scheduler.ts uses,
    // so "this saved" and "this will actually fire" mean the same thing.
    try {
      parseCron(schedule);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : "Invalid schedule");
    }
  }

  if (agentConfigId) {
    const { count } = await prisma.agentConfig.updateMany({
      where: { id: agentConfigId, workspaceId },
      data: { schedule },
    });
    if (count === 0) throw new Error("Agent not found in this workspace");
  } else {
    await prisma.agentConfig.upsert({
      where: { workspaceId_agentSlug: { workspaceId, agentSlug } },
      create: { workspaceId, agentSlug, schedule, enabled: false },
      update: { schedule },
    });
  }

  revalidatePath(`/agents/${agentSlug}`);
}

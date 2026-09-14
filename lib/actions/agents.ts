"use server";

import { getServerSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getActiveWorkspaceId, requireWorkspaceAccess } from "./workspace";
import { revalidatePath } from "next/cache";

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

"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getActiveWorkspaceId, requireWorkspaceAccess } from "./workspace";
import { revalidatePath } from "next/cache";

export async function toggleAgent(
  workspaceId: string,
  agentSlug: string,
  enabled: boolean,
  agentConfigId?: string
) {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");
  await requireWorkspaceAccess(workspaceId, "OPERATOR");

  if (agentConfigId) {
    await prisma.agentConfig.update({
      where: { id: agentConfigId },
      data: { enabled },
    });
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
  const session = await auth();
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

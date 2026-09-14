"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getServerSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess } from "./workspace";
import { OutboundPlayConfigSchema, type OutboundPlayConfig } from "@/lib/agent-handlers/outbound-play-config";

/**
 * Create/edit/enable-disable for a workspace's OutboundPlay rows — the replacement for the three
 * plays that used to be hardcoded straight into every outbound agent handler. WORKSPACE_ADMIN
 * only: a play's config decides which live Instantly/Aimfox campaign a run writes real leads into,
 * the same bar as connecting the integration itself.
 */

const SlugSchema = z
  .string()
  .trim()
  .min(2, "Slug must be at least 2 characters")
  .max(40, "Slug must be 40 characters or fewer")
  .regex(/^[a-z0-9][a-z0-9-]*$/i, "Slug may only contain letters, numbers, and hyphens");

const PlayFormSchema = z.object({
  slug: SlugSchema,
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(120),
  enabled: z.boolean().default(true),
  config: OutboundPlayConfigSchema,
});

export type OutboundPlayFormInput = z.infer<typeof PlayFormSchema>;

function serializeConfig(config: OutboundPlayConfig): object {
  return JSON.parse(JSON.stringify(config));
}

export async function createOutboundPlay(workspaceId: string, input: unknown) {
  const session = await getServerSession();
  if (!session?.user) throw new Error("Unauthorized");
  await requireWorkspaceAccess(workspaceId, "WORKSPACE_ADMIN");

  const parsed = PlayFormSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid play configuration");

  const existing = await prisma.outboundPlay.findUnique({
    where: { workspaceId_slug: { workspaceId, slug: parsed.data.slug } },
  });
  if (existing) throw new Error(`A play with slug "${parsed.data.slug}" already exists in this workspace`);

  const play = await prisma.outboundPlay.create({
    data: {
      workspaceId,
      slug: parsed.data.slug,
      name: parsed.data.name,
      enabled: parsed.data.enabled,
      config: serializeConfig(parsed.data.config),
    },
  });

  revalidatePath("/outbound");
  return play.id;
}

export async function updateOutboundPlay(workspaceId: string, playId: string, input: unknown) {
  const session = await getServerSession();
  if (!session?.user) throw new Error("Unauthorized");
  await requireWorkspaceAccess(workspaceId, "WORKSPACE_ADMIN");

  const parsed = PlayFormSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid play configuration");

  const play = await prisma.outboundPlay.findUnique({ where: { id: playId } });
  if (!play || play.workspaceId !== workspaceId) throw new Error("Play not found in this workspace");

  if (parsed.data.slug !== play.slug) {
    const clash = await prisma.outboundPlay.findUnique({
      where: { workspaceId_slug: { workspaceId, slug: parsed.data.slug } },
    });
    if (clash) throw new Error(`A play with slug "${parsed.data.slug}" already exists in this workspace`);
  }

  await prisma.outboundPlay.update({
    where: { id: playId },
    data: {
      slug: parsed.data.slug,
      name: parsed.data.name,
      enabled: parsed.data.enabled,
      config: serializeConfig(parsed.data.config),
    },
  });

  revalidatePath("/outbound");
}

export async function setOutboundPlayEnabled(workspaceId: string, playId: string, enabled: boolean) {
  const session = await getServerSession();
  if (!session?.user) throw new Error("Unauthorized");
  await requireWorkspaceAccess(workspaceId, "WORKSPACE_ADMIN");

  const { count } = await prisma.outboundPlay.updateMany({
    where: { id: playId, workspaceId },
    data: { enabled },
  });
  if (count === 0) throw new Error("Play not found in this workspace");

  revalidatePath("/outbound");
}

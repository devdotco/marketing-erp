import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess } from "@/lib/actions/workspace";
import { getPreset, NEUTRAL_PROFILE, resolveProfile } from "@/lib/content/editorial";

export const dynamic = "force-dynamic";

/**
 * Save a workspace's editorial profile.
 *
 * Stored as a preset key plus only the fields that actually differ from it, so
 * a workspace that customises two things still picks up improvements to the
 * other forty when a preset is updated.
 */
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as {
    workspaceId?: string;
    preset?: string;
    overrides?: Record<string, unknown>;
  };

  const { workspaceId, preset, overrides } = body;
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });

  await requireWorkspaceAccess(workspaceId, "WORKSPACE_ADMIN");

  const presetKey = preset && getPreset(preset).key === preset ? preset : NEUTRAL_PROFILE.key;
  const base = getPreset(presetKey);

  // Only keep what genuinely differs. resolveProfile already ignores fields it
  // does not know, so this cannot smuggle prompt text in through a stray key.
  const resolved = resolveProfile(presetKey, overrides ?? {});
  const diff: Record<string, unknown> = {};
  for (const field of Object.keys(base) as Array<keyof typeof base>) {
    if (field === "key" || field === "name" || field === "description") continue;
    const a = resolved[field];
    const b = base[field];
    if (JSON.stringify(a) !== JSON.stringify(b)) diff[field] = a;
  }

  const saved = await prisma.editorialProfile.upsert({
    where: { workspaceId },
    create: { workspaceId, preset: presetKey, overrides: diff as object, updatedBy: session.user.id ?? null },
    update: { preset: presetKey, overrides: diff as object, updatedBy: session.user.id ?? null },
  });

  return NextResponse.json({
    success: true,
    preset: saved.preset,
    customisedFields: Object.keys(diff),
  });
}

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess } from "@/lib/actions/workspace";
import { addPrompts } from "@/lib/visibility/prompts";
import type { TrackedPromptSource } from "@prisma/client";

export const dynamic = "force-dynamic";

/** Add tracked prompts. Existing ones are reactivated, never duplicated. */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as {
    workspaceId?: string;
    prompts?: Array<{ text?: string; topic?: string; source?: string }>;
  };
  if (!body.workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  await requireWorkspaceAccess(body.workspaceId, "OPERATOR");

  const entries = (body.prompts ?? [])
    .map((p): { text: string; topic?: string; source: TrackedPromptSource } => ({
      text: typeof p.text === "string" ? p.text.trim() : "",
      topic: typeof p.topic === "string" ? p.topic.trim() : undefined,
      source: p.source === "SEARCH_CONSOLE" || p.source === "SUGGESTED" ? p.source : "MANUAL",
    }))
    .filter((p) => p.text.length > 0);

  if (entries.length === 0) return NextResponse.json({ error: "No prompts given" }, { status: 400 });

  const added = await addPrompts(body.workspaceId, entries);
  return NextResponse.json({ added });
}

/**
 * Turn a prompt off, or rename its topic.
 *
 * Deactivation rather than deletion is the default everywhere it is offered:
 * captures reference the prompt, and removing it would take a measured day's
 * history with it. A prompt that stops being asked keeps what it already told
 * us.
 */
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as {
    workspaceId?: string;
    id?: string;
    active?: boolean;
    topic?: string;
  };
  if (!body.workspaceId || !body.id) {
    return NextResponse.json({ error: "workspaceId and id required" }, { status: 400 });
  }
  await requireWorkspaceAccess(body.workspaceId, "OPERATOR");

  // Scoped by workspaceId as well as id: an id from another tenant must not
  // resolve, and updateMany with both makes that structural rather than a
  // check someone can forget.
  const result = await prisma.trackedPrompt.updateMany({
    where: { id: body.id, workspaceId: body.workspaceId },
    data: {
      ...(typeof body.active === "boolean" ? { active: body.active } : {}),
      ...(typeof body.topic === "string" ? { topic: body.topic.trim() || null } : {}),
    },
  });

  if (result.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

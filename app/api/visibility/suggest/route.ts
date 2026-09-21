import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireWorkspaceAccess } from "@/lib/actions/workspace";
import { suggestPrompts } from "@/lib/visibility/prompts";
import { describeRunError } from "@/lib/ai/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Propose prompts worth tracking, without storing any of them.
 *
 * Suggestions are returned for review rather than written straight in. A
 * prompt list is the denominator of every figure on the visibility dashboard,
 * so silently adding twenty of them would move a workspace's headline number
 * for a reason nobody chose.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as { workspaceId?: string; count?: number };
  if (!body.workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  await requireWorkspaceAccess(body.workspaceId, "OPERATOR");

  try {
    const result = await suggestPrompts(body.workspaceId, { count: body.count ?? 20 });
    return NextResponse.json(result);
  } catch (err) {
    const described = describeRunError(err);
    return NextResponse.json({ error: described.message, hint: described.hint }, { status: 400 });
  }
}

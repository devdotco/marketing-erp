import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { forgetAnthropicKey } from "@/lib/ai/client";

export const dynamic = "force-dynamic";

/** Super admin only: who is allowed to spend on the platform's own key. */
export async function PATCH(req: NextRequest) {
  const session = await getServerSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!session.user.isSuperAdmin) {
    return NextResponse.json({ error: "Super admin only" }, { status: 403 });
  }

  const { workspaceId, allowPlatformKey } = (await req.json()) as {
    workspaceId?: string;
    allowPlatformKey?: boolean;
  };

  if (!workspaceId || typeof allowPlatformKey !== "boolean") {
    return NextResponse.json(
      { error: "workspaceId and allowPlatformKey are required" },
      { status: 400 },
    );
  }

  await prisma.workspace.update({ where: { id: workspaceId }, data: { allowPlatformKey } });
  forgetAnthropicKey(workspaceId);

  return NextResponse.json({ success: true, allowPlatformKey });
}

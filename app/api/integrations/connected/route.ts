import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";

export const dynamic = "force-dynamic";

/**
 * Which integrations the active workspace has connected.
 *
 * Exists so a form can stop offering a choice that cannot work. One tenant
 * selected Payload as their CMS Target and pressed Run six times over five
 * days; every run failed instantly with the same accurate, useless message,
 * because nothing told them before they pressed the button.
 *
 * Provider names only — never credentials, and never whether a key is valid.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) return NextResponse.json({ providers: [] });
  await requireWorkspaceAccess(workspaceId);

  const integrations = await prisma.integration.findMany({
    where: { workspaceId },
    select: { provider: true },
  });

  return NextResponse.json(
    { providers: integrations.map((i) => i.provider) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

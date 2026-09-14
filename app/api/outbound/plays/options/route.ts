import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runAccess } from "@/lib/integrations/route-auth";

export const dynamic = "force-dynamic";

/**
 * Read-only options source for a `play_select` Run modal / Configure form field
 * (components/ui/ResourceSelect), following the exact contract
 * app/api/integrations/google/resource/options/route.ts established — this is a second options
 * source reusing the same pluggable component, not a new one. Gated at runAccess(), the same
 * OPERATOR bar POST /api/runs uses: any workspace member who can start a run can see which plays
 * exist, they just can't create or edit one (that stays WORKSPACE_ADMIN, in
 * lib/actions/outbound-plays.ts).
 *
 * Always "connected" — a play isn't an external integration, so there's no not-connected state to
 * render; a workspace with zero enabled plays gets an empty options list instead (ResourceSelect's
 * own "nothing to choose" state).
 */
export async function GET() {
  const who = await runAccess();
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });

  const plays = await prisma.outboundPlay.findMany({
    where: { workspaceId: who.workspaceId, enabled: true },
    orderBy: { createdAt: "asc" },
    select: { slug: true, name: true },
  });

  return NextResponse.json({
    connected: true,
    noun: "play",
    options: plays.map((p) => ({ value: p.slug, label: p.name, detail: p.slug })),
    selected: null,
    providerLabel: "an outbound play",
  });
}

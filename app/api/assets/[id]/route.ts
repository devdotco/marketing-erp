import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireWorkspaceAccess } from "@/lib/actions/workspace";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Serves one AI-generated image (lib/images/*) for the run preview.
 * Authenticated and workspace-scoped — the asset's own workspaceId decides
 * access, the same pattern as app/api/runs/[runId]/route.ts.
 *
 * This is NOT the route a customer's CMS fetches from at publish time:
 * WordPress and Payload need the raw bytes to upload as their own media, and
 * can't authenticate as a signed-in user here. The publish path in
 * lib/agent-handlers/blog-writer.ts reads bytes from GeneratedAsset directly,
 * server-side, instead.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const asset = await prisma.generatedAsset.findUnique({
    where: { id },
    select: { workspaceId: true, mimeType: true, bytes: true },
  });
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await requireWorkspaceAccess(asset.workspaceId);

  return new NextResponse(new Uint8Array(asset.bytes), {
    status: 200,
    headers: {
      "Content-Type": asset.mimeType,
      // Content is immutable once generated (a new image gets a new id), so a
      // long, immutable cache is safe and saves re-fetching the same bytes on
      // every run-page render.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}

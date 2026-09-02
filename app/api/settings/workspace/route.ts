import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess } from "@/lib/actions/workspace";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { workspaceId, name, businessName, websiteUrl, industry } = body as {
    workspaceId: string;
    name?: string;
    businessName?: string;
    websiteUrl?: string;
    industry?: string;
  };

  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });

  await requireWorkspaceAccess(workspaceId, "WORKSPACE_ADMIN");

  const updates: Promise<unknown>[] = [];

  if (name) {
    updates.push(prisma.workspace.update({ where: { id: workspaceId }, data: { name } }));
  }

  if (businessName !== undefined || websiteUrl !== undefined || industry !== undefined) {
    updates.push(
      prisma.businessProfile.upsert({
        where: { workspaceId },
        create: { workspaceId, businessName: businessName ?? "", websiteUrl, industry },
        update: {
          ...(businessName !== undefined ? { businessName } : {}),
          ...(websiteUrl !== undefined ? { websiteUrl } : {}),
          ...(industry !== undefined ? { industry } : {}),
        },
      })
    );
  }

  await Promise.all(updates);

  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getActiveWorkspaceId } from "@/lib/actions/workspace";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = await getActiveWorkspaceId();
  if (!workspaceId) {
    // Fall back to user's first workspace
    const member = await prisma.workspaceMember.findFirst({
      where: { userId: session.user.id },
      orderBy: { createdAt: "asc" },
    });
    if (!member) return NextResponse.json({ error: "No workspace" }, { status: 400 });
  }

  const wsId = workspaceId ?? (
    await prisma.workspaceMember.findFirst({
      where: { userId: session.user.id },
      orderBy: { createdAt: "asc" },
    })
  )?.workspaceId;

  if (!wsId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const body = await req.json();
  const { businessName, websiteUrl, industry, primaryGoal, targetAudience, selectedAgent } = body;

  // Upsert BusinessProfile
  await prisma.businessProfile.upsert({
    where: { workspaceId: wsId },
    create: {
      workspaceId: wsId,
      businessName: businessName || "",
      websiteUrl: websiteUrl || null,
      industry: industry || null,
      targetAudience: targetAudience || null,
      goals: primaryGoal ? ({ primary: primaryGoal } as object) : undefined,
      onboardingCompletedAt: new Date(),
      onboardingStep: 5,
    },
    update: {
      businessName: businessName || undefined,
      websiteUrl: websiteUrl || undefined,
      industry: industry || undefined,
      targetAudience: targetAudience || undefined,
      goals: primaryGoal ? ({ primary: primaryGoal } as object) : undefined,
      onboardingCompletedAt: new Date(),
      onboardingStep: 5,
    },
  });

  // Enable selected agent
  if (selectedAgent) {
    await prisma.agentConfig.upsert({
      where: { workspaceId_agentSlug: { workspaceId: wsId, agentSlug: selectedAgent } },
      create: { workspaceId: wsId, agentSlug: selectedAgent, enabled: true },
      update: { enabled: true },
    });
  }

  return NextResponse.json({ ok: true });
}

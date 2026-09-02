"use server";

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { $Enums } from "@prisma/client";
type MemberRole = $Enums.MemberRole;

const ROLE_ORDER: MemberRole[] = ["VIEWER", "OPERATOR", "WORKSPACE_ADMIN", "SUPER_ADMIN"];

export async function requireWorkspaceAccess(workspaceId: string, minRole: MemberRole = "VIEWER") {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: session.user.id } },
  });

  if (!member && !session.user.isSuperAdmin) {
    throw new Error("Access denied");
  }

  const memberRoleIndex = member ? ROLE_ORDER.indexOf(member.role) : -1;
  const requiredIndex = ROLE_ORDER.indexOf(minRole);

  if (!session.user.isSuperAdmin && memberRoleIndex < requiredIndex) {
    throw new Error("Insufficient permissions");
  }

  return { member, session };
}

export async function getActiveWorkspaceId(): Promise<string | null> {
  const jar = await cookies();
  return jar.get("active_workspace_id")?.value || null;
}

export async function setActiveWorkspace(workspaceId: string) {
  const session = await auth();
  if (!session?.user) return;

  // Verify user is actually a member
  const member = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId: session.user.id },
  });
  if (!member && !session.user.isSuperAdmin) return;

  const jar = await cookies();
  jar.set("active_workspace_id", workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    domain: process.env.NODE_ENV === "production" ? ".erp.io" : undefined,
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
}

export async function getUserWorkspaces() {
  const session = await auth();
  if (!session?.user) return [];

  return prisma.workspace.findMany({
    where: { members: { some: { userId: session.user.id } } },
    include: {
      _count: { select: { members: true, runs: true } },
      members: { where: { userId: session.user.id }, select: { role: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function createWorkspace(formData: FormData) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const name = formData.get("name") as string;
  if (!name || name.length < 2) return { error: "Name must be at least 2 characters" };

  function slugify(s: string) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  }

  let slug = slugify(name);
  let attempt = 0;
  while (true) {
    const candidate = attempt === 0 ? slug : `${slug}-${attempt}`;
    const existing = await prisma.workspace.findUnique({ where: { slug: candidate } });
    if (!existing) { slug = candidate; break; }
    attempt++;
  }

  const workspace = await prisma.workspace.create({
    data: {
      name,
      slug,
      members: { create: { userId: session.user.id, role: "WORKSPACE_ADMIN" } },
      businessProfile: { create: { businessName: name, onboardingStep: 1 } },
    },
  });

  await setActiveWorkspace(workspace.id);
  redirect(`/onboarding?workspace=${workspace.id}`);
}

export async function getDashboardStats(workspaceId: string) {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [activeAgents, runsToday, pendingApprovals, monthlySpend, recentRuns] = await Promise.all([
    prisma.agentConfig.count({ where: { workspaceId, enabled: true } }),
    prisma.agentRun.count({ where: { workspaceId, createdAt: { gte: startOfDay } } }),
    prisma.agentRun.count({ where: { workspaceId, status: "AWAITING_APPROVAL" } }),
    prisma.agentRun.aggregate({
      where: { workspaceId, createdAt: { gte: startOfMonth } },
      _sum: { costUsd: true },
    }),
    prisma.agentRun.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { agentConfig: true },
    }),
  ]);

  return {
    activeAgents,
    runsToday,
    pendingApprovals,
    monthlySpend: Number(monthlySpend._sum.costUsd || 0),
    recentRuns,
  };
}

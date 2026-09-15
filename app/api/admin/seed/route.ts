import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encryptCredentials } from "@/lib/crypto";
import { IntegrationProvider } from "@prisma/client";
import { cookies } from "next/headers";
import { ADMIN_SEED_HEADER, adminSeedGate } from "@/lib/security/admin-seed";

export const dynamic = "force-dynamic";

/**
 * Bootstrap-only. This route is public at the proxy and can promote the admin
 * user to SUPER_ADMIN and overwrite the admin workspace's integration keys, so
 * it is gated by lib/security/admin-seed.ts:
 *  - production: 404 unless ALLOW_ADMIN_SEED=true
 *  - ADMIN_SEED_SECRET unset (or under 32 chars): 404 — no fallback secret
 *  - `x-admin-seed-secret` header, compared in constant time: else 403
 *
 *   curl -H "x-admin-seed-secret: $ADMIN_SEED_SECRET" .../api/admin/seed
 */
function gate(req: NextRequest): NextResponse | null {
  const verdict = adminSeedGate(process.env, req.headers.get(ADMIN_SEED_HEADER));
  if (verdict === "ok") return null;
  if (verdict === "forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

// GET /api/admin/seed — bootstrap the admin workspace (header: x-admin-seed-secret)
export async function GET(req: NextRequest) {
  const denied = gate(req);
  if (denied) return denied;

  const adminEmail = process.env.ADMIN_EMAIL || "nate@dev.co";

  // ?action=list → return all integrations + social accounts for the admin workspace
  if (req.nextUrl.searchParams.get("action") === "list") {
    const user = await prisma.user.findUnique({ where: { email: adminEmail } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const membership = await prisma.workspaceMember.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    if (!membership) return NextResponse.json({ error: "No workspace" }, { status: 404 });
    const integrations = await prisma.integration.findMany({
      where: { workspaceId: membership.workspaceId },
      select: { provider: true, label: true, expiresAt: true, scopes: true, createdAt: true },
    });
    const socialAccounts = await prisma.socialAccount.findMany({
      where: { workspaceId: membership.workspaceId },
      select: { platform: true, accountType: true, displayName: true, username: true, expiresAt: true, scopes: true },
    });
    return NextResponse.json({ workspaceId: membership.workspaceId, integrations, socialAccounts });
  }

  // Find or create the admin user
  let user = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!user) {
    return NextResponse.json(
      { error: `User ${adminEmail} not found — sign up first` },
      { status: 404 }
    );
  }

  // Check if they already have a workspace
  const existingMembership = await prisma.workspaceMember.findFirst({
    where: { userId: user.id },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  });

  let workspaceId: string;

  if (existingMembership) {
    workspaceId = existingMembership.workspaceId;
  } else {
    // Create the admin workspace
    const workspace = await prisma.workspace.create({
      data: {
        name: "dev.co",
        slug: "dev-co",
        members: {
          create: { userId: user.id, role: "SUPER_ADMIN" },
        },
        businessProfile: {
          create: {
            businessName: "dev.co",
            websiteUrl: "https://dev.co",
            industry: "Agency",
            onboardingStep: 5,
            onboardingCompletedAt: new Date(),
          },
        },
      },
    });
    workspaceId = workspace.id;
  }

  // Ensure onboarding is marked complete
  await prisma.businessProfile.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      businessName: "dev.co",
      onboardingStep: 5,
      onboardingCompletedAt: new Date(),
    },
    update: {
      onboardingStep: 5,
      onboardingCompletedAt: new Date(),
    },
  });

  // Promote membership to SUPER_ADMIN if it exists but is lower
  await prisma.workspaceMember.updateMany({
    where: { userId: user.id, workspaceId },
    data: { role: "SUPER_ADMIN" },
  });

  // Enable the active agents
  const agentsToEnable = ["blog-writer", "podcast", "technical-audit"];
  for (const agentSlug of agentsToEnable) {
    await prisma.agentConfig.upsert({
      where: { workspaceId_agentSlug: { workspaceId, agentSlug } },
      create: { workspaceId, agentSlug, enabled: true },
      update: { enabled: true },
    });
  }

  // Set the active_workspace_id cookie so they land in dashboard immediately
  const jar = await cookies();
  jar.set("active_workspace_id", workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    domain: process.env.NODE_ENV === "production" ? ".erp.io" : undefined,
    maxAge: 60 * 60 * 24 * 30,
  });

  return NextResponse.json({
    ok: true,
    userId: user.id,
    workspaceId,
    agentsEnabled: agentsToEnable,
    message: "Admin workspace ready. Visit /agents to proceed.",
  });
}

// POST /api/admin/seed
// Header: x-admin-seed-secret. Body: { provider, credentials }
// Saves an Integration for the admin workspace. No session required.
export async function POST(req: NextRequest) {
  const denied = gate(req);
  if (denied) return denied;

  let body: { provider?: string; credentials?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { provider, credentials } = body;
  if (!provider || !credentials) {
    return NextResponse.json({ error: "provider and credentials are required" }, { status: 400 });
  }

  if (!Object.values(IntegrationProvider).includes(provider as IntegrationProvider)) {
    return NextResponse.json({ error: `Unsupported provider: ${provider}` }, { status: 400 });
  }

  const adminEmail = process.env.ADMIN_EMAIL || "nate@dev.co";
  const user = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!user) {
    return NextResponse.json({ error: `User ${adminEmail} not found` }, { status: 404 });
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
  });
  if (!membership) {
    return NextResponse.json({ error: "No workspace found — call GET first to seed workspace" }, { status: 404 });
  }

  const typedProvider = provider as IntegrationProvider;
  const encrypted = await encryptCredentials(credentials);

  await prisma.integration.upsert({
    where: { workspaceId_provider: { workspaceId: membership.workspaceId, provider: typedProvider } },
    create: {
      workspaceId: membership.workspaceId,
      provider: typedProvider,
      encryptedCredentials: encrypted,
      scopes: [],
      label: provider,
    },
    update: {
      encryptedCredentials: encrypted,
      updatedAt: new Date(),
    },
  });

  return NextResponse.json({
    ok: true,
    provider: typedProvider,
    workspaceId: membership.workspaceId,
    message: `${provider} integration saved.`,
  });
}

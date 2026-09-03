import { getServerSession } from "@/lib/session";
import { resolveWorkspaceId } from "@/lib/actions/workspace";
import { prisma } from "@/lib/prisma";
import { encryptCredentials } from "@/lib/crypto";
import { IntegrationProvider } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ error: "No workspace found" }, { status: 400 });
  }

  let body: { provider?: string; apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { provider, apiKey } = body;
  if (!provider || !apiKey) {
    return NextResponse.json({ error: "provider and apiKey are required" }, { status: 400 });
  }

  if (!Object.values(IntegrationProvider).includes(provider as IntegrationProvider)) {
    return NextResponse.json({ error: "Unsupported provider" }, { status: 400 });
  }

  const typedProvider = provider as IntegrationProvider;
  const encrypted = await encryptCredentials({ apiKey });

  await prisma.integration.upsert({
    where: { workspaceId_provider: { workspaceId, provider: typedProvider } },
    create: {
      workspaceId,
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

  return NextResponse.json({ success: true });
}

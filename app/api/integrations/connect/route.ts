import { getServerSession } from "@/lib/session";
import { resolveWorkspaceId } from "@/lib/actions/workspace";
import { prisma } from "@/lib/prisma";
import { encryptCredentials } from "@/lib/crypto";
import { forgetAnthropicKey, verifyAnthropicKey } from "@/lib/ai/client";
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

  // Check the key before storing it. An unusable key fails identically to a
  // stale model id at run time — except by then someone has queued work and is
  // waiting on it. One cheap call here turns that into a form error.
  if (typedProvider === "ANTHROPIC") {
    const verdict = await verifyAnthropicKey(apiKey);
    if (!verdict.ok) {
      return NextResponse.json({ error: verdict.reason }, { status: 400 });
    }
  }

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

  // The resolver memoises clients for a minute; a rotated key must take effect now.
  if (typedProvider === "ANTHROPIC") forgetAnthropicKey(workspaceId);

  return NextResponse.json({ success: true });
}

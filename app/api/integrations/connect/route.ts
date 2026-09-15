import { prisma } from "@/lib/prisma";
import { encryptCredentials } from "@/lib/crypto";
import { forgetAnthropicKey, verifyAnthropicKey } from "@/lib/ai/client";
import { CONNECT_METHODS, normaliseKeyCredentials } from "@/lib/integrations/catalog";
import { revokeGoogleGrant } from "@/lib/integrations/google";
import { integrationAdmin } from "@/lib/integrations/route-auth";
import { KEY_VERIFIERS } from "@/lib/integrations/verify";
import { webhookTokenForSave } from "@/lib/integrations/webhook-auth";
import { isWebhookProvider } from "@/lib/security/webhook-token";
import { IntegrationProvider } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const who = await integrationAdmin();
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const { workspaceId } = who;

  let body: { provider?: string; apiKey?: string; credentials?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { provider } = body;
  if (!provider || !Object.values(IntegrationProvider).includes(provider as IntegrationProvider)) {
    return NextResponse.json({ error: "Unsupported provider" }, { status: 400 });
  }
  if (CONNECT_METHODS[provider]?.method.kind !== "key") {
    return NextResponse.json({ error: "This provider isn't connected with a key" }, { status: 400 });
  }

  // `apiKey` at the top level is the older single-field form; still accepted.
  const normalised = normaliseKeyCredentials(provider, body.credentials ?? { apiKey: body.apiKey });
  if (!normalised.ok) return NextResponse.json({ error: normalised.error }, { status: 400 });
  const { credentials } = normalised;

  const typedProvider = provider as IntegrationProvider;

  // Check the key before storing it. An unusable key fails identically to a
  // stale model id at run time — except by then someone has queued work and is
  // waiting on it. One cheap call here turns that into a form error.
  if (typedProvider === "ANTHROPIC") {
    const verdict = await verifyAnthropicKey(credentials.apiKey);
    if (!verdict.ok) {
      return NextResponse.json({ error: verdict.reason }, { status: 400 });
    }
  }

  const verify = KEY_VERIFIERS[typedProvider];
  if (verify) {
    const verdict = await verify(credentials).catch((err: Error) => ({ ok: false as const, reason: `Couldn't reach ${typedProvider}: ${err.message}` }));
    if (!verdict.ok) return NextResponse.json({ error: verdict.reason }, { status: 400 });
  }

  // Instantly/Aimfox webhooks authenticate with a per-workspace token kept in
  // these credentials. Carry the existing one across a reconnect so the URL an
  // admin already pasted into the vendor keeps working.
  const toStore: Record<string, string> = isWebhookProvider(typedProvider)
    ? { ...credentials, webhookToken: await webhookTokenForSave(workspaceId, typedProvider) }
    : credentials;

  const encrypted = await encryptCredentials(toStore);

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

/** Disconnect: delete the stored credentials (and end Google's side of an OAuth grant). */
export async function DELETE(req: NextRequest) {
  const who = await integrationAdmin();
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });

  const provider = req.nextUrl.searchParams.get("provider") ?? "";
  if (!Object.values(IntegrationProvider).includes(provider as IntegrationProvider)) {
    return NextResponse.json({ error: "Unsupported provider" }, { status: 400 });
  }
  const typedProvider = provider as IntegrationProvider;

  const integration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: who.workspaceId, provider: typedProvider } },
  });
  if (!integration) return NextResponse.json({ success: true });

  if (CONNECT_METHODS[provider]?.method.kind === "google") await revokeGoogleGrant(integration);
  await prisma.integration.delete({ where: { id: integration.id } });
  if (typedProvider === "ANTHROPIC") forgetAnthropicKey(who.workspaceId);

  return NextResponse.json({ success: true });
}

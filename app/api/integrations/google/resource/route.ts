import { NextRequest, NextResponse } from "next/server";
import { IntegrationProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encryptCredentials } from "@/lib/crypto";
import { googleCredentials, googleScopes } from "@/lib/integrations/google";
import { GOOGLE_RESOURCES, type GoogleResource } from "@/lib/integrations/google-resources";
import { integrationAdmin } from "@/lib/integrations/route-auth";

export const dynamic = "force-dynamic";

async function load(providerParam: string | null | undefined) {
  const provider = (providerParam ?? "").toUpperCase();
  if (!googleScopes(provider) || !Object.values(IntegrationProvider).includes(provider as IntegrationProvider)) {
    return { error: NextResponse.json({ error: "Unknown Google integration" }, { status: 400 }) } as const;
  }
  const resource = GOOGLE_RESOURCES[provider] ?? null;
  const who = await integrationAdmin();
  if (!who.ok) return { error: NextResponse.json({ error: who.error }, { status: who.status }) } as const;
  const integration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: who.workspaceId, provider: provider as IntegrationProvider } },
  });
  if (!integration) return { error: NextResponse.json({ error: "Not connected" }, { status: 404 }) } as const;
  return { integration, resource } as const;
}

/** What this grant can reach, and which one the agents use. */
export async function GET(req: NextRequest) {
  const loaded = await load(req.nextUrl.searchParams.get("provider"));
  if ("error" in loaded) return loaded.error;
  const { resource } = loaded;
  try {
    const creds = (await googleCredentials(loaded.integration)) as Parameters<GoogleResource["selected"]>[0];
    // Connected, and nothing to choose for this provider.
    if (!resource) return NextResponse.json({ noun: null, options: null, selected: null });
    const options = await resource.list(creds.access_token);
    return NextResponse.json({ noun: resource.noun, options, selected: resource.selected(creds) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

/** Choose one. Only a value the grant can actually reach is accepted. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { provider?: string; value?: string };
  const loaded = await load(body.provider);
  if ("error" in loaded) return loaded.error;
  const { resource } = loaded;
  if (!resource) return NextResponse.json({ error: "Nothing to choose for this integration" }, { status: 400 });
  if (!body.value) return NextResponse.json({ error: "value is required" }, { status: 400 });

  try {
    const creds = (await googleCredentials(loaded.integration)) as Parameters<GoogleResource["selected"]>[0];
    const options = await resource.list(creds.access_token);
    const chosen = options.find((o) => o.value === body.value);
    if (!chosen) {
      return NextResponse.json({ error: "That isn't available to the connected Google account" }, { status: 400 });
    }
    await prisma.integration.update({
      where: { id: loaded.integration.id },
      data: {
        encryptedCredentials: await encryptCredentials(resource.apply(creds, body.value)),
        label: chosen.label,
      },
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

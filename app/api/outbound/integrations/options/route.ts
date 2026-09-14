import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { runAccess } from "@/lib/integrations/route-auth";
import { listInstantlyCampaigns } from "@/lib/integrations/instantly";
import { listAimfoxCampaigns } from "@/lib/integrations/aimfox";

export const dynamic = "force-dynamic";

const PROVIDER_LABEL: Record<string, string> = { INSTANTLY: "Instantly", AIMFOX: "Aimfox" };

/**
 * Read-only options source (components/ui/ResourceSelect) for the Outbound Engine play editor's
 * campaign dropdowns — the workspace's real Instantly campaigns (GET /api/v2/campaigns) or Aimfox
 * campaigns (GET /campaigns), via the same shared clients the agent handlers use. Gated at
 * runAccess(), same bar as app/api/integrations/google/resource/options/route.ts and
 * app/api/outbound/plays/options/route.ts — any workspace member who can run agents can see the
 * campaign list; saving a play's choice stays WORKSPACE_ADMIN-only (lib/actions/outbound-plays.ts).
 */
export async function GET(req: NextRequest) {
  const providerParam = (req.nextUrl.searchParams.get("provider") ?? "").toUpperCase();
  if (providerParam !== "INSTANTLY" && providerParam !== "AIMFOX") {
    return NextResponse.json({ error: "provider must be INSTANTLY or AIMFOX" }, { status: 400 });
  }

  const who = await runAccess();
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });

  const providerLabel = PROVIDER_LABEL[providerParam];
  const connectUrl = `/integrations/connect/${providerParam.toLowerCase()}`;

  const integration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: who.workspaceId, provider: providerParam } },
  });
  if (!integration) {
    return NextResponse.json({ connected: false, connectUrl, providerLabel });
  }

  try {
    const creds = await decryptCredentials<{ apiKey: string }>(integration.encryptedCredentials);
    const campaigns =
      providerParam === "INSTANTLY" ? await listInstantlyCampaigns(creds.apiKey) : await listAimfoxCampaigns(creds.apiKey);
    return NextResponse.json({
      connected: true,
      noun: "campaign",
      options: campaigns.map((c) => ({ value: c.id, label: c.name })),
      selected: null,
      providerLabel,
    });
  } catch (err) {
    // Connected, but the live call failed (revoked key, rate limit, ...). Still 200 — the dropdown
    // shows the error inline and the play editor falls back to the plain-text campaign name field.
    return NextResponse.json({
      connected: true,
      error: err instanceof Error ? err.message : String(err),
      providerLabel,
    });
  }
}

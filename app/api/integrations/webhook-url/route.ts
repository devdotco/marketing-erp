import { NextRequest, NextResponse } from "next/server";
import { integrationAdmin } from "@/lib/integrations/route-auth";
import { ensureWebhookToken, webhookUrl } from "@/lib/integrations/webhook-auth";
import { isWebhookProvider } from "@/lib/security/webhook-token";

export const dynamic = "force-dynamic";

/**
 * The active workspace's webhook URL for Instantly or Aimfox — the thing an
 * admin pastes into the vendor. Workspace admins only: the URL is the secret.
 *
 * GET returns it, minting a token for an integration connected before tokens
 * existed. POST rotates it (the old URL stops working immediately).
 */
async function handle(req: NextRequest, rotate: boolean) {
  const who = await integrationAdmin();
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });

  const provider = (req.nextUrl.searchParams.get("provider") ?? "").toUpperCase();
  if (!isWebhookProvider(provider)) {
    return NextResponse.json({ error: "provider must be INSTANTLY or AIMFOX" }, { status: 400 });
  }

  const token = await ensureWebhookToken(who.workspaceId, provider, { rotate });
  if (!token) return NextResponse.json({ connected: false }, { status: 404 });

  return NextResponse.json(
    { connected: true, url: webhookUrl(provider, token) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(req: NextRequest) {
  return handle(req, false);
}

export async function POST(req: NextRequest) {
  return handle(req, true);
}

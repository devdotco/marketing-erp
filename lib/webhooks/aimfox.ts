import { NextRequest, NextResponse } from "next/server";
import { receiveOutboundWebhook } from "./receive";

/**
 * Shared by /api/webhooks/aimfox (header token, or unsigned during the grace window) and
 * /api/webhooks/aimfox/<token>. Payload parsing and the event mapping live in
 * lib/webhooks/outbound-events.ts; the database side in lib/webhooks/receive.ts.
 */
export async function handleAimfoxWebhook(req: NextRequest, token: string | null): Promise<NextResponse> {
  return receiveOutboundWebhook("AIMFOX", req, token);
}

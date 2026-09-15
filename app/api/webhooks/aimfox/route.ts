import { NextRequest } from "next/server";
import { handleAimfoxWebhook } from "@/lib/webhooks/aimfox";
import { WEBHOOK_TOKEN_HEADER } from "@/lib/integrations/webhook-auth";

export const dynamic = "force-dynamic";

/**
 * The bare URL. Authenticated by the `x-webhook-token` header, if the webhook
 * was configured with one. Without it the delivery is refused — unless
 * WEBHOOKS_ALLOW_UNSIGNED=true, a temporary grace window for webhooks set up
 * before tokens existed. The tokenised URL is /api/webhooks/aimfox/<token>, shown on
 * the Aimfox connect page.
 */
export async function POST(req: NextRequest) {
  return handleAimfoxWebhook(req, req.headers.get(WEBHOOK_TOKEN_HEADER));
}

import { NextRequest } from "next/server";
import { handleInstantlyWebhook } from "@/lib/webhooks/instantly";
import { WEBHOOK_TOKEN_HEADER } from "@/lib/integrations/webhook-auth";

export const dynamic = "force-dynamic";

/**
 * The bare URL. Authenticated by the `x-webhook-token` header, if the webhook
 * was configured with one. Without it the delivery is refused — unless
 * WEBHOOKS_ALLOW_UNSIGNED=true, a temporary grace window for webhooks set up
 * before tokens existed. The tokenised URL is /api/webhooks/instantly/<token>, shown on
 * the Instantly connect page.
 */
export async function POST(req: NextRequest) {
  return handleInstantlyWebhook(req, req.headers.get(WEBHOOK_TOKEN_HEADER));
}

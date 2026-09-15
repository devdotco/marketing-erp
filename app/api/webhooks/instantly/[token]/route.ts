import { NextRequest } from "next/server";
import { handleInstantlyWebhook } from "@/lib/webhooks/instantly";

export const dynamic = "force-dynamic";

/** The per-workspace webhook URL shown on the Instantly connect page. The path token decides the workspace. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handleInstantlyWebhook(req, token);
}

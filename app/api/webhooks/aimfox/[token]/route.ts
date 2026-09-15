import { NextRequest } from "next/server";
import { handleAimfoxWebhook } from "@/lib/webhooks/aimfox";

export const dynamic = "force-dynamic";

/** The per-workspace webhook URL shown on the Aimfox connect page. The path token decides the workspace. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handleAimfoxWebhook(req, token);
}

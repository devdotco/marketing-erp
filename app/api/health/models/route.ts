import { NextResponse } from "next/server";
import { checkModelsAvailable } from "@/lib/ai/models";

export const dynamic = "force-dynamic";

/**
 * Are the Claude models this app references actually callable?
 *
 * Returns 503 when any is not, so a deploy check or uptime monitor catches a
 * stale model id before a user does.
 */
export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("force") === "1";
  const health = await checkModelsAvailable(force);
  return NextResponse.json(health, { status: health.ok ? 200 : 503 });
}

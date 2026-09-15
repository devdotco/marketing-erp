import { NextRequest, NextResponse } from "next/server";
import { integrationAdmin } from "@/lib/integrations/route-auth";
import { discoverPayload } from "@/lib/integrations/payload-discover";

export const dynamic = "force-dynamic";

/**
 * Step 1 of the Payload connect form: "Check connection". Read-only — it GETs
 * the customer's Payload (/api/<auth>/me, /api/access, /api/tenants, one post)
 * and returns dropdown options. Nothing is stored; saving still goes through
 * POST /api/integrations/connect and the PAYLOAD verifier.
 *
 * The API key is used only in the outbound Authorization header. It is never
 * echoed in the response and never logged — keep it that way (no console.*
 * of `body` here).
 */
export async function POST(req: NextRequest) {
  const who = await integrationAdmin();
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });

  let body: { baseUrl?: unknown; authCollection?: unknown; apiKey?: unknown; postsCollection?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const result = await discoverPayload({
    baseUrl: text(body.baseUrl, 2048),
    authCollection: text(body.authCollection, 128),
    apiKey: text(body.apiKey, 4096),
    postsCollection: text(body.postsCollection, 128) || undefined,
  }).catch((err: Error) => ({ ok: false as const, step: "network" as const, error: `Couldn't check Payload: ${err.message}` }));

  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}

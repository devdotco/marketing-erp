import { NextResponse } from "next/server";
import { SHELL_ISSUER, shellKeySet } from "@/lib/shell-token";
import { verifyMirrorToken } from "@/lib/shell-mirror/verify";
import { MirrorPayloadError } from "@/lib/shell-mirror/protocol";
import { dbReplayGuard } from "@/lib/shell-mirror/store";
import { applyEvent, mirrorContext } from "@/lib/shell-mirror/apply";
import { mirrorEnabled, readCappedText } from "@/lib/shell-mirror/gate";

/**
 * POST /api/shell-mirror/events — the shell pushes workspace-mirror state here.
 *
 * Body: one compact JWT signed by the shell's Ed25519 key (the JWKS the
 * hand-off already trusts), `aud=marketing`, `typ=erp-mirror+jwt`, single-use
 * jti. The signature is the credential; there is no other. Public in proxy.ts
 * for that reason.
 *
 * Off unless MIRROR_MODULES on this app includes `marketing` (503); bodies over 1 MB
 * are refused before verification (413).
 *
 * 200 with what was applied (stale and duplicate deliveries are 200 no-ops),
 * 401 on verification failure, 409 on a replayed jti, 400 on a malformed
 * payload, 503 when applying failed and the shell should retry.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!mirrorEnabled("marketing")) return NextResponse.json({ error: "mirror disabled" }, { status: 503 });
  // Capped BEFORE verification: this endpoint is public.
  const body = await readCappedText(req);
  if (body === null) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  const token = body.trim();
  if (!token) return NextResponse.json({ error: "empty body" }, { status: 400 });

  let verified;
  try {
    verified = await verifyMirrorToken(token, shellKeySet, SHELL_ISSUER);
  } catch (err) {
    if (err instanceof MirrorPayloadError) return NextResponse.json({ error: err.message }, { status: 400 });
    console.warn("[shell-mirror] rejected event:", (err as Error).message);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (verified.kind !== "event") return NextResponse.json({ error: "expected an event" }, { status: 400 });

  if (!(await dbReplayGuard("shell").claim(verified.jti, verified.expiresAt))) {
    return NextResponse.json({ error: "replayed" }, { status: 409 });
  }

  const ctx = mirrorContext(false);
  try {
    await applyEvent(verified.event, ctx);
  } catch (err) {
    console.error(`[shell-mirror] ${verified.event.type} for ${verified.event.org.id} failed:`, (err as Error).message);
    return NextResponse.json({ error: "apply failed" }, { status: 503 });
  }
  return NextResponse.json({ ok: true, type: verified.event.type, report: ctx.report });
}

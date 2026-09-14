import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { appUrl, withBase } from "@/lib/base-path";
import { MICROSOFT_STATE_COOKIE, microsoftAuthUrl, microsoftScopes } from "@/lib/integrations/microsoft";
import { integrationAdmin } from "@/lib/integrations/route-auth";

export const dynamic = "force-dynamic";

/** Top-level navigation from the Connect button → Microsoft's consent screen. */
export async function GET(req: NextRequest) {
  const back = (error: string) =>
    NextResponse.redirect(appUrl(`/integrations?error=${encodeURIComponent(error)}`));

  const provider = (req.nextUrl.searchParams.get("provider") ?? "").toUpperCase();
  if (!microsoftScopes(provider)) return back("Unknown Microsoft integration");

  const who = await integrationAdmin();
  if (!who.ok) return back(who.error);

  const nonce = randomBytes(24).toString("base64url");
  let url: string;
  try {
    url = microsoftAuthUrl(provider, nonce);
  } catch (err) {
    return back((err as Error).message);
  }

  const res = NextResponse.redirect(url);
  // Binds the callback to this browser, this provider and this workspace —
  // switching workspace mid-consent must not land the grant on the other one.
  res.cookies.set(MICROSOFT_STATE_COOKIE, `${nonce}.${provider}.${who.workspaceId}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: withBase("/api/integrations/microsoft"),
    maxAge: 600,
  });
  return res;
}

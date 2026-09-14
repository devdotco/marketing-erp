import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { appUrl, withBase } from "@/lib/base-path";
import { GOOGLE_STATE_COOKIE, googleAuthUrl, googleScopes } from "@/lib/integrations/google";
import { integrationAdmin } from "@/lib/integrations/route-auth";

export const dynamic = "force-dynamic";

/** Top-level navigation from the Connect button → Google's consent screen. */
export async function GET(req: NextRequest) {
  const back = (error: string) =>
    NextResponse.redirect(appUrl(`/integrations?error=${encodeURIComponent(error)}`));

  const provider = (req.nextUrl.searchParams.get("provider") ?? "").toUpperCase();
  if (!googleScopes(provider)) return back("Unknown Google integration");

  const who = await integrationAdmin();
  if (!who.ok) return back(who.error);

  const nonce = randomBytes(24).toString("base64url");
  let url: string;
  try {
    url = googleAuthUrl(provider, nonce);
  } catch (err) {
    return back((err as Error).message);
  }

  const res = NextResponse.redirect(url);
  // Binds the callback to this browser, this provider and this workspace —
  // switching workspace mid-consent must not land the grant on the other one.
  res.cookies.set(GOOGLE_STATE_COOKIE, `${nonce}.${provider}.${who.workspaceId}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: withBase("/api/integrations/google"),
    maxAge: 600,
  });
  return res;
}

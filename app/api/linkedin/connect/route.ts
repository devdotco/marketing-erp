import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAuthorizationUrl } from "@/lib/social/linkedin-oauth";
import crypto from "crypto";

export const dynamic = "force-dynamic";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.redirect(new URL("/login", APP_URL));

  const includeOrg = req.nextUrl.searchParams.get("org") === "1";
  const state = `${crypto.randomBytes(16).toString("hex")}:${includeOrg ? "1" : "0"}`;

  const res = NextResponse.redirect(getAuthorizationUrl(state, includeOrg));

  res.cookies.set("li_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  return res;
}

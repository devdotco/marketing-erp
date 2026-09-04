import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAuthorizationUrl, generatePKCE } from "@/lib/social/x-oauth";
import crypto from "crypto";

export const dynamic = "force-dynamic";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export async function GET(_req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.redirect(new URL("/login", APP_URL));

  const state = crypto.randomBytes(16).toString("hex");
  const { verifier, challenge } = generatePKCE();

  const res = NextResponse.redirect(getAuthorizationUrl({ state, codeChallenge: challenge }));

  res.cookies.set("x_oauth_state", state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/" });
  res.cookies.set("x_pkce_verifier", verifier, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/" });

  return res;
}

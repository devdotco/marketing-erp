import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { exchangeCode, fetchXUser } from "@/lib/social/x-oauth";
import { prisma } from "@/lib/prisma";
import { getActiveWorkspaceId } from "@/lib/actions/workspace";

export const dynamic = "force-dynamic";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.redirect(new URL("/login", APP_URL));

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const error = req.nextUrl.searchParams.get("error");

  if (error) return NextResponse.redirect(new URL("/social/accounts?error=denied", APP_URL));

  const storedState = req.cookies.get("x_oauth_state")?.value;
  const codeVerifier = req.cookies.get("x_pkce_verifier")?.value;

  if (!state || state !== storedState || !codeVerifier) {
    return NextResponse.redirect(new URL("/social/accounts?error=state", APP_URL));
  }

  if (!code) return NextResponse.redirect(new URL("/social/accounts?error=no_code", APP_URL));

  const workspaceId = await getActiveWorkspaceId();
  if (!workspaceId) return NextResponse.redirect(new URL("/onboarding", APP_URL));

  try {
    const tokens = await exchangeCode(code, codeVerifier);
    const xUser = await fetchXUser(tokens.access_token);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    await prisma.socialAccount.upsert({
      where: {
        workspaceId_platform_platformAccountId: {
          workspaceId,
          platform: "TWITTER_X",
          platformAccountId: xUser.id,
        },
      },
      create: {
        workspaceId,
        platform: "TWITTER_X",
        accountType: "PERSONAL",
        platformAccountId: xUser.id,
        displayName: xUser.name,
        username: xUser.username,
        avatarUrl: xUser.profile_image_url ?? null,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt,
        scopes: tokens.scope,
      },
      update: {
        displayName: xUser.name,
        username: xUser.username,
        avatarUrl: xUser.profile_image_url ?? null,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt,
        scopes: tokens.scope,
        updatedAt: new Date(),
      },
    });

    const res = NextResponse.redirect(new URL("/social/accounts?success=1", APP_URL));
    res.cookies.delete("x_oauth_state");
    res.cookies.delete("x_pkce_verifier");
    return res;
  } catch (err) {
    console.error("X callback error:", err);
    return NextResponse.redirect(new URL("/social/accounts?error=exchange", APP_URL));
  }
}

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { exchangeCode, fetchProfile, fetchAdminOrgs } from "@/lib/social/linkedin-oauth";
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

  const storedState = req.cookies.get("li_oauth_state")?.value;
  if (!state || state !== storedState) {
    return NextResponse.redirect(new URL("/social/accounts?error=state", APP_URL));
  }

  if (!code) return NextResponse.redirect(new URL("/social/accounts?error=no_code", APP_URL));

  const [, includeOrgFlag] = state.split(":");
  const includeOrg = includeOrgFlag === "1";

  const workspaceId = await getActiveWorkspaceId();
  if (!workspaceId) return NextResponse.redirect(new URL("/onboarding", APP_URL));

  try {
    const tokens = await exchangeCode(code);
    const profile = await fetchProfile(tokens.access_token);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Upsert personal account
    await prisma.socialAccount.upsert({
      where: {
        workspaceId_platform_platformAccountId: {
          workspaceId,
          platform: "LINKEDIN",
          platformAccountId: `urn:li:person:${profile.sub}`,
        },
      },
      create: {
        workspaceId,
        platform: "LINKEDIN",
        accountType: "PERSONAL",
        platformAccountId: `urn:li:person:${profile.sub}`,
        displayName: profile.name,
        avatarUrl: profile.picture ?? null,
        platformEmail: profile.email ?? null,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt,
        scopes: tokens.scope,
      },
      update: {
        displayName: profile.name,
        avatarUrl: profile.picture ?? null,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt,
        scopes: tokens.scope,
        updatedAt: new Date(),
      },
    });

    // Optionally connect company pages
    if (includeOrg) {
      const orgs = await fetchAdminOrgs(tokens.access_token);
      for (const org of orgs) {
        await prisma.socialAccount.upsert({
          where: {
            workspaceId_platform_platformAccountId: {
              workspaceId,
              platform: "LINKEDIN",
              platformAccountId: `urn:li:organization:${org.id}`,
            },
          },
          create: {
            workspaceId,
            platform: "LINKEDIN",
            accountType: "COMPANY",
            platformAccountId: `urn:li:organization:${org.id}`,
            organizationUrn: `urn:li:organization:${org.id}`,
            companyName: org.name,
            displayName: org.name,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? null,
            expiresAt,
            scopes: tokens.scope,
          },
          update: {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? null,
            expiresAt,
            updatedAt: new Date(),
          },
        });
      }
    }

    const res = NextResponse.redirect(new URL("/social/accounts?success=1", APP_URL));
    res.cookies.delete("li_oauth_state");
    return res;
  } catch (err) {
    console.error("LinkedIn callback error:", err);
    return NextResponse.redirect(new URL("/social/accounts?error=exchange", APP_URL));
  }
}

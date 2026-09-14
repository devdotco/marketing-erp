import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { IntegrationProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encryptCredentials } from "@/lib/crypto";
import { appUrl, withBase } from "@/lib/base-path";
import {
  GOOGLE_STATE_COOKIE,
  exchangeGoogleCode,
  googleScopes,
  hasGrantedScopes,
  type GoogleCredentials,
} from "@/lib/integrations/google";
import { GOOGLE_RESOURCES } from "@/lib/integrations/google-resources";
import { integrationAdmin } from "@/lib/integrations/route-auth";

export const dynamic = "force-dynamic";

function sameString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function GET(req: NextRequest) {
  const done = (path: string) => {
    const res = NextResponse.redirect(appUrl(path));
    res.cookies.set(GOOGLE_STATE_COOKIE, "", { path: withBase("/api/integrations/google"), maxAge: 0 });
    return res;
  };
  const fail = (error: string) => done(`/integrations?error=${encodeURIComponent(error)}`);

  const params = req.nextUrl.searchParams;
  // The person pressed Cancel on Google's screen.
  if (params.get("error")) {
    return fail(params.get("error") === "access_denied" ? "Google access was not granted" : `Google returned: ${params.get("error")}`);
  }

  const [nonce, provider, workspaceId] = (req.cookies.get(GOOGLE_STATE_COOKIE)?.value ?? "").split(".");
  const state = params.get("state") ?? "";
  const code = params.get("code") ?? "";
  if (!nonce || !state || !code || !sameString(nonce, state) || !googleScopes(provider)) {
    return fail("That Google sign-in expired or didn't start here. Try connecting again.");
  }

  const who = await integrationAdmin();
  if (!who.ok) return fail(who.error);
  if (who.workspaceId !== workspaceId) {
    return fail("You switched workspace while connecting. Try again from the workspace you want to connect.");
  }

  let creds: GoogleCredentials;
  try {
    creds = await exchangeGoogleCode(code);
  } catch (err) {
    console.error("[integrations/google] code exchange failed:", (err as Error).message);
    return fail((err as Error).message);
  }

  if (!hasGrantedScopes(provider, creds.scope)) {
    return fail("Google connected without the permission the agents need. Connect again and leave every requested box ticked.");
  }

  let stored: Record<string, unknown> = creds;
  let label = provider;
  const resource = GOOGLE_RESOURCES[provider];
  if (resource) {
    try {
      const options = await resource.list(creds.access_token);
      if (options.length === 0) {
        return fail(`That Google account has no ${resource.noun} it can use. Connect with the account that owns it.`);
      }
      // One option: nothing to choose. Several: the connect page asks.
      if (options.length === 1) {
        stored = resource.apply(creds, options[0].value);
        label = options[0].label;
      }
    } catch (err) {
      console.error(`[integrations/google] listing ${provider} resources failed:`, (err as Error).message);
      return fail(`Connected to Google, but it refused to list your ${resource.noun}. Check that API is enabled in the Google Cloud project for this OAuth client.`);
    }
  }

  const encryptedCredentials = await encryptCredentials(stored);
  const typedProvider = provider as IntegrationProvider;
  await prisma.integration.upsert({
    where: { workspaceId_provider: { workspaceId, provider: typedProvider } },
    create: {
      workspaceId,
      provider: typedProvider,
      encryptedCredentials,
      scopes: creds.scope.split(/\s+/),
      expiresAt: new Date(creds.expires_at),
      label,
    },
    update: {
      encryptedCredentials,
      scopes: creds.scope.split(/\s+/),
      expiresAt: new Date(creds.expires_at),
      label,
    },
  });

  return done(`/integrations/connect/${provider.toLowerCase()}?connected=1`);
}

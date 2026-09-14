import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { IntegrationProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encryptCredentials } from "@/lib/crypto";
import { appUrl, withBase } from "@/lib/base-path";
import {
  MICROSOFT_STATE_COOKIE,
  exchangeMicrosoftCode,
  microsoftScopes,
  type MicrosoftCredentials,
} from "@/lib/integrations/microsoft";
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
    res.cookies.set(MICROSOFT_STATE_COOKIE, "", { path: withBase("/api/integrations/microsoft"), maxAge: 0 });
    return res;
  };
  const fail = (error: string) => done(`/integrations?error=${encodeURIComponent(error)}`);

  const params = req.nextUrl.searchParams;
  // The person pressed Cancel on Microsoft's screen.
  if (params.get("error")) {
    const code = params.get("error");
    return fail(
      code === "access_denied"
        ? "Microsoft access was not granted"
        : `Microsoft returned: ${params.get("error_description") || code}`,
    );
  }

  const [nonce, provider, workspaceId] = (req.cookies.get(MICROSOFT_STATE_COOKIE)?.value ?? "").split(".");
  const state = params.get("state") ?? "";
  const code = params.get("code") ?? "";
  if (!nonce || !state || !code || !sameString(nonce, state) || !microsoftScopes(provider)) {
    return fail("That Microsoft sign-in expired or didn't start here. Try connecting again.");
  }

  const who = await integrationAdmin();
  if (!who.ok) return fail(who.error);
  if (who.workspaceId !== workspaceId) {
    return fail("You switched workspace while connecting. Try again from the workspace you want to connect.");
  }

  let creds: MicrosoftCredentials;
  try {
    creds = await exchangeMicrosoftCode(code, provider);
  } catch (err) {
    console.error("[integrations/microsoft] code exchange failed:", (err as Error).message);
    return fail((err as Error).message);
  }

  const encryptedCredentials = await encryptCredentials(creds);
  const typedProvider = provider as IntegrationProvider;
  await prisma.integration.upsert({
    where: { workspaceId_provider: { workspaceId, provider: typedProvider } },
    create: {
      workspaceId,
      provider: typedProvider,
      encryptedCredentials,
      scopes: creds.scope.split(/\s+/),
      expiresAt: new Date(creds.expires_at),
      label: provider,
    },
    update: {
      encryptedCredentials,
      scopes: creds.scope.split(/\s+/),
      expiresAt: new Date(creds.expires_at),
      label: provider,
    },
  });

  return done(`/integrations/connect/${provider.toLowerCase()}?connected=1`);
}

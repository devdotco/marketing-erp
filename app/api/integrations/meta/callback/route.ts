import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { IntegrationProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encryptCredentials } from "@/lib/crypto";
import { appUrl, withBase } from "@/lib/base-path";
import {
  META_PICKER_COOKIE,
  META_STATE_COOKIE,
  exchangeMetaCode,
  listMetaPages,
  metaScopes,
  type MetaCredentials,
} from "@/lib/integrations/meta";
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
    res.cookies.set(META_STATE_COOKIE, "", { path: withBase("/api/integrations/meta"), maxAge: 0 });
    return res;
  };
  const fail = (error: string) => done(`/integrations?error=${encodeURIComponent(error)}`);

  const params = req.nextUrl.searchParams;
  // The person pressed Cancel on Facebook's screen.
  if (params.get("error")) {
    return fail(
      params.get("error") === "access_denied"
        ? "Facebook access was not granted"
        : `Facebook returned: ${params.get("error_description") || params.get("error")}`,
    );
  }

  const [nonce, provider, workspaceId] = (req.cookies.get(META_STATE_COOKIE)?.value ?? "").split(".");
  const state = params.get("state") ?? "";
  const code = params.get("code") ?? "";
  if (!nonce || !state || !code || !sameString(nonce, state) || !metaScopes(provider)) {
    return fail("That Facebook sign-in expired or didn't start here. Try connecting again.");
  }

  const who = await integrationAdmin();
  if (!who.ok) return fail(who.error);
  if (who.workspaceId !== workspaceId) {
    return fail("You switched workspace while connecting. Try again from the workspace you want to connect.");
  }

  let userToken: string;
  try {
    userToken = await exchangeMetaCode(code);
  } catch (err) {
    console.error("[integrations/meta] code exchange failed:", (err as Error).message);
    return fail((err as Error).message);
  }

  let pages: Awaited<ReturnType<typeof listMetaPages>>;
  try {
    pages = await listMetaPages(userToken);
  } catch (err) {
    console.error("[integrations/meta] listing Pages failed:", (err as Error).message);
    return fail(`Connected to Facebook, but couldn't list your Pages: ${(err as Error).message}`);
  }

  if (pages.length === 0) {
    return fail(
      "That Facebook account doesn't manage any Pages. Agents post as a Page, not a personal profile — add the account as an admin or editor on a Page and try again.",
    );
  }

  const typedProvider = provider as IntegrationProvider;

  // One Page: nothing to choose, connect it directly. Several: the connect
  // page asks — the long-lived USER token that can list them is never
  // persisted, so it rides along in a short-lived encrypted cookie instead of
  // the database (see lib/integrations/meta.ts for why).
  if (pages.length === 1) {
    const page = pages[0];
    const credentials: MetaCredentials = {
      page_access_token: page.access_token,
      page_id: page.id,
      page_name: page.name,
      ig_user_id: page.instagram_business_account?.id,
      ig_username: page.instagram_business_account?.username,
    };
    await prisma.integration.upsert({
      where: { workspaceId_provider: { workspaceId, provider: typedProvider } },
      create: {
        workspaceId,
        provider: typedProvider,
        encryptedCredentials: await encryptCredentials(credentials),
        scopes: metaScopes(provider) ?? [],
        label: page.name,
      },
      update: {
        encryptedCredentials: await encryptCredentials(credentials),
        scopes: metaScopes(provider) ?? [],
        label: page.name,
      },
    });
    return done(`/integrations/connect/${provider.toLowerCase()}?connected=1`);
  }

  const res = NextResponse.redirect(appUrl(`/integrations/connect/${provider.toLowerCase()}?picker=1`));
  res.cookies.set(META_STATE_COOKIE, "", { path: withBase("/api/integrations/meta"), maxAge: 0 });
  // Only the one user token rides in the cookie, never the Page list: every
  // Page carries its own token, so an account managing a dozen or more Pages
  // pushed the cookie past the ~4KB browsers keep, it was silently dropped,
  // and the picker reported "expired". The picker re-lists with this token.
  res.cookies.set(META_PICKER_COOKIE, await encryptCredentials({ workspaceId, provider, userToken }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: withBase("/api/integrations/meta"),
    maxAge: 600,
  });
  return res;
}

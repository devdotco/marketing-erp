import { NextRequest, NextResponse } from "next/server";
import { IntegrationProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptCredentials, encryptCredentials } from "@/lib/crypto";
import { withBase } from "@/lib/base-path";
import { META_PICKER_COOKIE, listMetaPages, metaScopes, type MetaCredentials, type MetaPage } from "@/lib/integrations/meta";
import { integrationAdmin } from "@/lib/integrations/route-auth";

export const dynamic = "force-dynamic";

type PickerCookie = { workspaceId: string; provider: string; userToken: string };

/**
 * The Page-picker step of connecting Meta. The long-lived user token that can
 * enumerate Pages is only ever held in the short-lived cookie the callback set,
 * never in the database (see lib/integrations/meta.ts), so this step can't be
 * revisited once that cookie expires — reconnecting starts the OAuth flow over.
 * Pages are listed live from that token on each call rather than carried in the
 * cookie, which would overflow it for accounts with many Pages.
 */
async function loadPicker(
  who: { workspaceId: string },
  req: NextRequest,
): Promise<{ provider: string; pages: MetaPage[] } | null | { error: string }> {
  const raw = req.cookies.get(META_PICKER_COOKIE)?.value;
  if (!raw) return null;
  let picked: PickerCookie;
  try {
    picked = await decryptCredentials<PickerCookie>(raw);
  } catch {
    return null;
  }
  if (picked.workspaceId !== who.workspaceId || !picked.userToken) return null;
  try {
    return { provider: picked.provider, pages: await listMetaPages(picked.userToken) };
  } catch (err) {
    return { error: `Couldn't list your Facebook Pages: ${(err as Error).message}` };
  }
}

export async function GET(req: NextRequest) {
  const who = await integrationAdmin();
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });

  const picked = await loadPicker(who, req);
  if (!picked) {
    return NextResponse.json(
      { error: "That Facebook connection expired before a Page was chosen. Connect again." },
      { status: 410 },
    );
  }
  if ("error" in picked) return NextResponse.json({ error: picked.error }, { status: 502 });

  return NextResponse.json({
    noun: "Facebook Page",
    options: picked.pages.map((p) => ({
      value: p.id,
      label: p.name,
      detail: p.instagram_business_account ? `+ Instagram @${p.instagram_business_account.username ?? p.instagram_business_account.id}` : undefined,
    })),
  });
}

export async function POST(req: NextRequest) {
  const who = await integrationAdmin();
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });

  const body = (await req.json().catch(() => ({}))) as { provider?: string; value?: string };
  const provider = (body.provider ?? "").toUpperCase();
  if (!Object.values(IntegrationProvider).includes(provider as IntegrationProvider) || !metaScopes(provider)) {
    return NextResponse.json({ error: "Unsupported provider" }, { status: 400 });
  }
  if (!body.value) return NextResponse.json({ error: "value is required" }, { status: 400 });

  const picked = await loadPicker(who, req);
  if (!picked) {
    return NextResponse.json(
      { error: "That Facebook connection expired before a Page was chosen. Connect again." },
      { status: 410 },
    );
  }
  if ("error" in picked) return NextResponse.json({ error: picked.error }, { status: 502 });

  const page = picked.pages.find((p) => p.id === body.value);
  if (!page) return NextResponse.json({ error: "That isn't one of the Pages this Facebook account manages" }, { status: 400 });

  const credentials: MetaCredentials = {
    page_access_token: page.access_token,
    page_id: page.id,
    page_name: page.name,
    ig_user_id: page.instagram_business_account?.id,
    ig_username: page.instagram_business_account?.username,
  };

  const typedProvider = provider as IntegrationProvider;
  await prisma.integration.upsert({
    where: { workspaceId_provider: { workspaceId: who.workspaceId, provider: typedProvider } },
    create: {
      workspaceId: who.workspaceId,
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

  const res = NextResponse.json({ success: true });
  res.cookies.set(META_PICKER_COOKIE, "", { path: withBase("/api/integrations/meta"), maxAge: 0 });
  return res;
}

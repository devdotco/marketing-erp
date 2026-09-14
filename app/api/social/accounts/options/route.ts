import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runAccess } from "@/lib/integrations/route-auth";

export const dynamic = "force-dynamic";

/**
 * Connected LinkedIn/X accounts (the Social module's `SocialAccount` rows) for a Run modal /
 * Configure "Account" dropdown — answers the same ResourceSelect contract as
 * /api/integrations/google/resource/options and /api/runs/drafts.
 *
 * Deliberately its own endpoint rather than folded into /api/integrations/*: there is no
 * `Integration` row for LINKEDIN or TWITTER_X (see lib/integrations/catalog.ts's CONNECT_METHODS —
 * neither provider has an entry), so the Google-resource route's "not connected → OAuth connect
 * URL" contract doesn't apply here. Accounts are connected at /social/accounts instead, which is
 * what the empty state below links to.
 */
export async function GET(req: NextRequest) {
  const who = await runAccess();
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });

  const platform = req.nextUrl.searchParams.get("platform");
  if (platform !== "LINKEDIN" && platform !== "TWITTER_X") {
    return NextResponse.json({ error: "platform must be LINKEDIN or TWITTER_X" }, { status: 400 });
  }
  const providerLabel = platform === "LINKEDIN" ? "LinkedIn" : "X";

  const accounts = await prisma.socialAccount.findMany({
    where: { workspaceId: who.workspaceId, platform },
    orderBy: { createdAt: "asc" },
    select: { id: true, accountType: true, displayName: true, username: true, companyName: true, expiresAt: true },
  });

  if (accounts.length === 0) {
    return NextResponse.json({ connected: false, connectUrl: "/social/accounts", providerLabel });
  }

  const now = new Date();
  const options = accounts.map((a) => ({
    value: a.id,
    label: a.displayName || a.companyName || a.username || a.id,
    detail:
      (a.accountType === "COMPANY" ? "Company page" : "Personal profile") +
      (a.expiresAt.getTime() <= now.getTime() ? " · token expired, reconnect at /social/accounts" : ""),
  }));

  return NextResponse.json({ connected: true, noun: "account", options, selected: null, providerLabel });
}

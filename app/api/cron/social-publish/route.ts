import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { publishLinkedInPost, refreshLinkedInToken } from "@/lib/social/linkedin-publish";
import { publishXPost, refreshXToken } from "@/lib/social/x-publish";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  const due = await prisma.socialPost.findMany({
    where: {
      status: "SCHEDULED",
      scheduledAt: { lte: now },
    },
    include: { socialAccount: true },
  });

  const results: { id: string; status: "published" | "failed"; error?: string }[] = [];

  for (const post of due) {
    const account = post.socialAccount;
    try {
      let accessToken = account.accessToken;

      // Refresh token if expired (5-min buffer)
      if (account.expiresAt < new Date(now.getTime() + 5 * 60 * 1000)) {
        if (!account.refreshToken) throw new Error("Token expired and no refresh token");

        const refreshed =
          account.platform === "LINKEDIN"
            ? await refreshLinkedInToken(account.refreshToken)
            : await refreshXToken(account.refreshToken);

        accessToken = refreshed.accessToken;

        await prisma.socialAccount.update({
          where: { id: account.id },
          data: {
            accessToken: refreshed.accessToken,
            expiresAt: refreshed.expiresAt,
            updatedAt: new Date(),
          },
        });
      }

      let platformPostId: string;

      if (account.platform === "LINKEDIN") {
        const authorUrn =
          account.accountType === "COMPANY"
            ? account.organizationUrn!
            : account.platformAccountId;
        const { urn } = await publishLinkedInPost({ accessToken, authorUrn, content: post.content });
        platformPostId = urn;
      } else {
        // TWITTER_X
        const { id } = await publishXPost({ accessToken, content: post.content });
        platformPostId = id;
      }

      await prisma.socialPost.update({
        where: { id: post.id },
        data: {
          status: "PUBLISHED",
          publishedAt: new Date(),
          platformPostId,
          errorMessage: null,
          updatedAt: new Date(),
        },
      });

      results.push({ id: post.id, status: "published" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`Failed to publish post ${post.id}:`, message);

      await prisma.socialPost.update({
        where: { id: post.id },
        data: { status: "FAILED", errorMessage: message, updatedAt: new Date() },
      });

      results.push({ id: post.id, status: "failed", error: message });
    }
  }

  return NextResponse.json({ processed: results.length, results });
}

export async function GET() {
  return NextResponse.json({ ok: true, time: new Date().toISOString() });
}

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SITES } from "@/lib/social/auto-post-sites";
import { generateAutoPost } from "@/lib/social/generate";
import { publishLinkedInPost, refreshLinkedInToken } from "@/lib/social/linkedin-publish";
import { uploadImage } from "@/lib/social/linkedin-upload";
import { searchPhotos, downloadPhoto } from "@/lib/social/pexels";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Optional filters: ?workspaceId=xxx&siteKeys=seo-co,ppc-co,dev-co
  const { searchParams } = req.nextUrl;
  const workspaceIdParam = searchParams.get("workspaceId");
  const siteKeysParam = searchParams.get("siteKeys");
  const allowedKeys = siteKeysParam ? siteKeysParam.split(",").map((s) => s.trim()) : null;

  const activeSites = allowedKeys ? SITES.filter((s) => allowedKeys.includes(s.key)) : SITES;

  if (activeSites.length === 0) {
    return NextResponse.json({ error: "No sites matched the provided siteKeys" }, { status: 400 });
  }

  // Resolve workspace — use query param or fall back to first available workspace
  let workspaceId: string | null = workspaceIdParam;

  if (!workspaceId) {
    const firstWorkspace = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
    workspaceId = firstWorkspace?.id ?? null;
  }

  if (!workspaceId) {
    return NextResponse.json({ error: "No workspace found" }, { status: 400 });
  }

  // Find the LinkedIn personal account scoped to this workspace
  const account = await prisma.socialAccount.findFirst({
    where: { workspaceId, platform: "LINKEDIN", accountType: "PERSONAL" },
  });

  if (!account) {
    return NextResponse.json({ error: "No LinkedIn account connected for this workspace" }, { status: 400 });
  }

  // RATE LIMIT: hard cap at 3 posts/day per account
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayCount = await prisma.socialPost.count({
    where: {
      socialAccountId: account.id,
      status: "PUBLISHED",
      publishedAt: { gte: today },
    },
  });

  if (todayCount >= 3) {
    return NextResponse.json({ skipped: true, reason: "Daily limit reached (3 posts/day)" });
  }

  // Round-robin: find last auto-post for this account and advance the site index
  const allRecent = await prisma.socialPost.findMany({
    where: { socialAccountId: account.id },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { aiGenerated: true },
  });

  const lastAutoPost = allRecent.find((r) => {
    try {
      const meta = r.aiGenerated as { type?: string } | null;
      return meta?.type === "auto";
    } catch {
      return false;
    }
  });

  let nextSiteIndex = 0;
  if (lastAutoPost?.aiGenerated) {
    try {
      const meta = lastAutoPost.aiGenerated as { siteIndex?: number };
      nextSiteIndex = ((meta.siteIndex ?? -1) + 1) % activeSites.length;
    } catch { /* first run */ }
  }

  const site = activeSites[nextSiteIndex];
  const subPage = site.subPages[Math.floor(Math.random() * site.subPages.length)];

  // Generate content
  const content = await generateAutoPost(site, subPage);

  // Refresh token if needed (5-min buffer)
  const now = new Date();
  let accessToken = account.accessToken;

  if (account.expiresAt < new Date(now.getTime() + 5 * 60 * 1000)) {
    if (!account.refreshToken) {
      return NextResponse.json({ error: "LinkedIn token expired, no refresh token" }, { status: 400 });
    }
    const refreshed = await refreshLinkedInToken(account.refreshToken);
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

  // Fetch 3 Pexels images and upload to LinkedIn for carousel
  let imageAssetUrns: string[] = [];
  try {
    const photos = await searchPhotos(site.topics[0], 3);
    imageAssetUrns = (
      await Promise.all(
        photos.map(async (photo) => {
          try {
            const buf = await downloadPhoto(photo.src.large2x ?? photo.src.large);
            return await uploadImage({ accessToken, ownerUrn: account.platformAccountId, imageBuffer: buf });
          } catch {
            return null;
          }
        })
      )
    ).filter((u): u is string => u !== null);
  } catch (err) {
    console.error("Image fetch/upload failed, posting without images:", err);
  }

  // Publish to LinkedIn
  const { urn } = await publishLinkedInPost({
    accessToken,
    authorUrn: account.platformAccountId,
    content,
    imageAssetUrns: imageAssetUrns.length > 0 ? imageAssetUrns : undefined,
  });

  // Record in socialPost table
  const post = await prisma.socialPost.create({
    data: {
      workspaceId,
      socialAccountId: account.id,
      content,
      status: "PUBLISHED",
      scheduledAt: now,
      publishedAt: now,
      platformPostId: urn,
      aiGenerated: {
        type: "auto",
        siteIndex: nextSiteIndex,
        site: site.key,
        subPage: subPage.url,
        images: imageAssetUrns.length,
      },
    },
  });

  return NextResponse.json({
    published: true,
    postId: post.id,
    site: site.key,
    subPage: subPage.url,
    images: imageAssetUrns.length,
    urn,
  });
}

export async function GET() {
  return NextResponse.json({ ok: true, sites: SITES.length });
}

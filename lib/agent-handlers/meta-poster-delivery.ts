/**
 * Meta Poster's stage/publish split — pulled out of meta-poster.ts (which touches Prisma and
 * Anthropic) so this pure/network-injectable half can run from test/content.test.ts without a
 * live database or a real Graph API call, the same reason
 * lib/agent-handlers/linkedin-engager-delivery.ts is its own file.
 *
 * Meta has no SocialPlatform enum value (see prisma/schema.prisma — LINKEDIN and TWITTER_X are
 * the only two), so unlike LinkedIn/X Poster this agent does not create SocialPost rows for the
 * social-publish cron to pick up. It stays on the workspace's connected META `Integration` (a real
 * connect method — see lib/integrations/catalog.ts's CONNECT_METHODS.META — unlike the LINKEDIN/
 * TWITTER_X entries that don't exist there) and publishes directly from the approval hook,
 * per-post, with the same per-post error capture the run used to have when it published live
 * during the run. The only change is WHEN it runs: never during the run, only after a workspace
 * admin approves the staged batch.
 */

import { META_GRAPH_VERSION, type MetaCredentials } from "@/lib/integrations/meta";

export type MetaPostStatus = "pending" | "published" | "failed" | "manual";

export interface MetaStagedPost {
  id: string;
  platform: "Facebook" | "Instagram";
  surface: "feed" | "story" | "reel";
  caption: string;
  hashtags?: string[];
  /** Only ever set by a person editing the staged batch before approval — nothing in this agent
   * generates one. Blog Writer's visuals agent (lib/content/*, out of scope here) is the only
   * thing in this codebase that produces an image; Instagram feed posts without one are marked
   * "manual" rather than skipped silently. */
  imageUrl?: string;
  status: MetaPostStatus;
  fbPostId?: string;
  igPostId?: string;
  publishedAt?: string;
  publishError?: string;
  publishNote?: string;
}

export interface PublishMetaBatchDeps {
  fetchImpl?: typeof fetch;
}

function fullText(post: MetaStagedPost): string {
  const hashtags = (post.hashtags ?? []).join(" ");
  return [post.caption, hashtags].filter(Boolean).join("\n\n");
}

/**
 * Publishes every not-yet-settled post in `posts` for the platform(s) named in `targetPlatforms`.
 * Never throws — a per-post failure is recorded on that post and the loop continues, mirroring
 * executeLinkedinEngagerBatch's contract in linkedin-engager-delivery.ts: on-approve.ts writes back
 * whatever this returns in one shot, so losing partial progress to a thrown error would erase the
 * record of posts that already went out. Idempotent: a post already "published" or "manual" is
 * left untouched, so re-invoking on the same batch (a retried approval call) never double-posts.
 */
export async function publishMetaBatch(
  posts: MetaStagedPost[],
  creds: MetaCredentials,
  targetPlatforms: "Facebook" | "Instagram" | "Both",
  deps: PublishMetaBatchDeps = {},
): Promise<{ posts: MetaStagedPost[]; publishedCount: number }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const out = [...posts];
  let publishedCount = 0;

  for (let i = 0; i < out.length; i++) {
    const post = out[i]!;
    if (post.status === "published" || post.status === "manual") {
      if (post.status === "published") publishedCount++;
      continue;
    }

    const text = fullText(post);

    if (
      (targetPlatforms === "Facebook" || targetPlatforms === "Both") &&
      post.platform === "Facebook" &&
      post.surface === "feed" &&
      creds.page_id &&
      creds.page_access_token
    ) {
      try {
        const res = await fetchImpl(`https://graph.facebook.com/${META_GRAPH_VERSION}/${creds.page_id}/feed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text.slice(0, 63206), access_token: creds.page_access_token }),
        });
        if (res.ok) {
          const data = (await res.json()) as { id?: string };
          out[i] = { ...post, status: "published", fbPostId: data.id, publishedAt: new Date().toISOString() };
          publishedCount++;
        } else {
          const errBody = await res.text().catch(() => "");
          out[i] = { ...post, status: "failed", publishError: `Facebook API ${res.status}: ${errBody}` };
        }
      } catch (err) {
        out[i] = { ...post, status: "failed", publishError: `Facebook feed publish failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      continue;
    }

    if (
      (targetPlatforms === "Instagram" || targetPlatforms === "Both") &&
      post.platform === "Instagram" &&
      post.surface === "feed" &&
      creds.ig_user_id
    ) {
      if (!post.imageUrl) {
        out[i] = { ...post, status: "manual", publishNote: "Instagram requires an image URL, which this agent does not generate — add one to the post and publish it to Instagram by hand." };
        continue;
      }
      try {
        const containerRes = await fetchImpl(`https://graph.facebook.com/${META_GRAPH_VERSION}/${creds.ig_user_id}/media`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ caption: text.slice(0, 2200), image_url: post.imageUrl, access_token: creds.page_access_token }),
        });
        if (!containerRes.ok) {
          const errBody = await containerRes.text().catch(() => "");
          out[i] = { ...post, status: "failed", publishError: `Instagram media (container) ${containerRes.status}: ${errBody}` };
          continue;
        }
        const containerData = (await containerRes.json()) as { id?: string };
        if (!containerData.id) {
          out[i] = { ...post, status: "failed", publishError: "Instagram media container was created without an id" };
          continue;
        }
        const publishRes = await fetchImpl(`https://graph.facebook.com/${META_GRAPH_VERSION}/${creds.ig_user_id}/media_publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ creation_id: containerData.id, access_token: creds.page_access_token }),
        });
        if (publishRes.ok) {
          const igData = (await publishRes.json()) as { id?: string };
          out[i] = { ...post, status: "published", igPostId: igData.id, publishedAt: new Date().toISOString() };
          publishedCount++;
        } else {
          const errBody = await publishRes.text().catch(() => "");
          out[i] = { ...post, status: "failed", publishError: `Instagram media_publish ${publishRes.status}: ${errBody}` };
        }
      } catch (err) {
        out[i] = { ...post, status: "failed", publishError: `Instagram publish failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      continue;
    }

    // Neither branch matched this post's platform/surface (e.g. a Story or Reel — no Graph API
    // call for those is wired up anywhere in this codebase, and Facebook Stories/Reels are not
    // enabled by the "Both"/"Facebook"/"Instagram" targetPlatforms filter above either) — mark it
    // manual with a note rather than leaving it "pending" forever with nothing that will ever
    // advance it.
    out[i] = {
      ...post,
      status: "manual",
      publishNote: post.publishNote ?? `${post.platform} ${post.surface} publishing is not automated — post this one manually.`,
    };
  }

  return { posts: out, publishedCount };
}

/** Idempotency helper mirroring social-poster-shared.ts's postsStillToCreate: true once every post
 * has left the "pending" state (published, failed, or manual), so on-approve.ts knows not to call
 * publishMetaBatch again on a batch that's already been fully processed. */
export function isMetaBatchSettled(posts: MetaStagedPost[]): boolean {
  return posts.length > 0 && posts.every((p) => p.status !== "pending");
}

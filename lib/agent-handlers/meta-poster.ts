import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { resolveInputs } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { META_GRAPH_VERSION, type MetaCredentials } from "@/lib/integrations/meta";

export const metaPosterHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  const platforms = (config.platforms as string) ?? "Both";
  const postingFrequency = (config.postingFrequency as string) ?? "3x week";
  const contentStyle = (config.contentStyle as string) ?? "Mixed";
  const hashtagStrategy = (config.hashtagStrategy as string) ?? "Mixed";
  const batchSize = typeof config.batchSize === "number" ? config.batchSize : 7;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const metaIntegration = await prisma.integration.findUnique({
    where: {
      workspaceId_provider: {
        workspaceId: run.agentConfig.workspaceId,
        provider: "META",
      },
    },
  });

  const systemPrompt = `You are a Meta social media strategist specialising in Facebook and Instagram content. Write distinct content optimised per surface (feed, story, reel) with appropriate tone, length, and CTA for each. Feed posts can be longer and educational. Stories are punchy and visual. Reels scripts are hook-first and direct. Respond ONLY with valid JSON — no markdown, no explanations.`;

  const userPrompt = `Generate a batch of ${batchSize} Meta posts for ${businessProfile?.businessName ?? "the client"}.

Business context:
- Industry: ${businessProfile?.industry ?? "General"}
- Value proposition: ${businessProfile?.uniqueValueProp ?? "Not specified"}
- Target audience: ${businessProfile?.targetAudience ?? "Not specified"}
- Competitors: ${(businessProfile?.competitors ?? []).join(", ") || "Not specified"}

Publishing config:
- Platforms: ${platforms}
- Posting frequency: ${postingFrequency}
- Content style: ${contentStyle}
- Hashtag strategy: ${hashtagStrategy}

Distribute the ${batchSize} posts across Facebook and Instagram, and across feed/story/reel surfaces as appropriate. Schedule them starting from today, spread across the posting frequency.

Return exactly this JSON structure:
{
  "posts": [
    {
      "id": "meta_post_1",
      "platform": "Facebook",
      "surface": "feed",
      "caption": "full caption text",
      "hashtags": ["#hashtag1"],
      "callToAction": "e.g. Link in bio / Comment below / DM us",
      "visualBrief": "description of the ideal image or video for this post",
      "scheduledFor": "ISO 8601 date string",
      "charCount": 0,
      "approved": false
    }
  ],
  "batchSize": ${batchSize},
  "strategyNotes": "2-3 sentences on the strategic intent and expected outcomes"
}`;

  const message = await client.messages.create({
    model: MODELS.standard,
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = textFrom(message);
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { result: rawText };
  } catch {
    output = { result: rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  // ── Auto-publish Facebook text posts when approval not required ──────────
  if (!requireApproval && metaIntegration) {
    // Deliberately NOT wrapped in try/catch: a decrypt failure here means the
    // stored credentials are corrupt or this integration predates the current
    // shape — a real config fault, and nothing has posted yet, so throwing is
    // safe and correct (the run fails legibly instead of reporting "draft",
    // which would read as "nothing happened" when the actual state is
    // unknown). Once posting starts, per-post failures below are caught
    // individually instead, because by then some posts may already be live
    // on Facebook/Instagram — losing that fact by throwing mid-loop would be
    // worse than recording it.
    const creds = await decryptCredentials<MetaCredentials>(metaIntegration.encryptedCredentials);

    const posts = (output.posts as Array<Record<string, unknown>>) ?? [];
    let publishedCount = 0;

    for (const post of posts) {
      const caption = String(post.caption ?? "");
      const hashtags = ((post.hashtags as string[]) ?? []).join(" ");
      const fullText = [caption, hashtags].filter(Boolean).join("\n\n");
      const platform = String(post.platform ?? "Facebook");
      const surface = String(post.surface ?? "feed");

      // Facebook feed posts — publish via Pages API (text only; media requires upload)
      if (
        (platforms === "Facebook" || platforms === "Both") &&
        platform === "Facebook" &&
        surface === "feed" &&
        creds.page_id &&
        creds.page_access_token
      ) {
        try {
          const fbRes = await fetch(
            `https://graph.facebook.com/${META_GRAPH_VERSION}/${creds.page_id}/feed`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                message: fullText.slice(0, 63206),
                access_token: creds.page_access_token,
              }),
            }
          );

          if (fbRes.ok) {
            const fbData = (await fbRes.json()) as { id?: string };
            post.published = true;
            post.fbPostId = fbData.id;
            post.publishedAt = new Date().toISOString();
            publishedCount++;
          } else {
            const errBody = await fbRes.text().catch(() => "");
            post.publishError = `Facebook API ${fbRes.status}: ${errBody}`;
          }
        } catch (err) {
          post.publishError = `Facebook feed publish failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // Instagram feed posts require an image_url — skip without media
      // Mark Instagram posts as needing manual publish if no image URL is provided
      if (
        (platforms === "Instagram" || platforms === "Both") &&
        platform === "Instagram" &&
        surface === "feed" &&
        creds.ig_user_id
      ) {
        const imageUrl = post.imageUrl as string | undefined;
        if (imageUrl) {
          try {
            // Step 1: create container
            const containerRes = await fetch(
              `https://graph.facebook.com/${META_GRAPH_VERSION}/${creds.ig_user_id}/media`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  caption: fullText.slice(0, 2200),
                  image_url: imageUrl,
                  access_token: creds.page_access_token,
                }),
              }
            );
            if (!containerRes.ok) {
              const errBody = await containerRes.text().catch(() => "");
              post.publishError = `Instagram media (container) ${containerRes.status}: ${errBody}`;
            } else {
              const containerData = (await containerRes.json()) as { id?: string };
              if (!containerData.id) {
                post.publishError = "Instagram media container was created without an id";
              } else {
                // Step 2: publish container
                const publishRes = await fetch(
                  `https://graph.facebook.com/${META_GRAPH_VERSION}/${creds.ig_user_id}/media_publish`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      creation_id: containerData.id,
                      access_token: creds.page_access_token,
                    }),
                  }
                );
                if (publishRes.ok) {
                  const igData = (await publishRes.json()) as { id?: string };
                  post.published = true;
                  post.igPostId = igData.id;
                  post.publishedAt = new Date().toISOString();
                  publishedCount++;
                } else {
                  const errBody = await publishRes.text().catch(() => "");
                  post.publishError = `Instagram media_publish ${publishRes.status}: ${errBody}`;
                }
              }
            }
          } catch (err) {
            post.publishError = `Instagram publish failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          post.publishNote = "Provide imageUrl field to enable Instagram auto-publish";
        }
      }
    }

    output.posts = posts;
    output.publishedCount = publishedCount;
    // "live": at least one post actually went out. "draft": Meta is connected
    // and posting was attempted but nothing went out — check each post's
    // publishError/publishNote for why, rather than treating this the same
    // as "not connected".
    output.source = publishedCount > 0 ? "live" : "draft";
  } else if (!metaIntegration) {
    output.source = "draft";
    output.simulationNote =
      "Connect Meta in Settings > Integrations to enable auto-publishing via Facebook Graph API.";
  }

  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  return { output, costUsd };
};

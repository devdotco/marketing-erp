import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

export const metaPosterHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

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
    model: "claude-sonnet-5-20251015",
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = message.content[0].type === "text" ? message.content[0].text : "";
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
    try {
      const creds = await decryptCredentials<{
        page_access_token: string;
        page_id: string;
        ig_user_id?: string;
      }>(metaIntegration.encryptedCredentials);

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
          const fbRes = await fetch(
            `https://graph.facebook.com/v21.0/${creds.page_id}/feed`,
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
            // Step 1: create container
            const containerRes = await fetch(
              `https://graph.facebook.com/v21.0/${creds.ig_user_id}/media`,
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
            if (containerRes.ok) {
              const containerData = (await containerRes.json()) as { id?: string };
              if (containerData.id) {
                // Step 2: publish container
                const publishRes = await fetch(
                  `https://graph.facebook.com/v21.0/${creds.ig_user_id}/media_publish`,
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
                }
              }
            }
          } else {
            post.publishNote = "Provide imageUrl field to enable Instagram auto-publish";
          }
        }
      }

      output.posts = posts;
      output.publishedCount = publishedCount;
      output.source = publishedCount > 0 ? "live" : "draft";
    } catch (err) {
      output.publishError = err instanceof Error ? err.message : "Meta publish failed";
      output.source = "draft";
    }
  } else if (!metaIntegration) {
    output.source = "draft";
    output.simulationNote =
      "Connect Meta in Settings > Integrations to enable auto-publishing via Facebook Graph API. Store { page_access_token, page_id } for Facebook Pages; add ig_user_id for Instagram Business accounts.";
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return { output, costUsd };
};

import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

export const xPosterHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const contentSeed = (config.contentSeed as string) ?? "";
  const postType = (config.postType as string) ?? "Standalone";
  const threadLength = (config.threadLength as number) ?? 6;
  const postingFrequency = (config.postingFrequency as string) ?? "3x week";
  const batchSize = (config.batchSize as number) ?? 7;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const xIntegration = await prisma.integration.findUnique({
    where: {
      workspaceId_provider: {
        workspaceId: run.agentConfig.workspaceId,
        provider: "TWITTER_X",
      },
    },
  });

  const horizonDays =
    postingFrequency === "Daily" ? 7 : postingFrequency === "3x week" ? 17 : 28;

  const systemPrompt = `You are an elite X (Twitter) content strategist for ${
    businessProfile?.businessName ?? "a business"
  } in the ${businessProfile?.industry ?? "business"} space.
You write posts that lead with the conclusion, pack insight per word, and never pad.
Thread rule: tweet 1 must contain the full thesis — the rest amplify, prove, or nuance.
Always respond with ONLY a valid JSON object — no markdown fences, no extra prose.`;

  const userPrompt = `Generate a ${batchSize}-post X content batch (post type: ${postType}) for the next ${horizonDays} days.

Content seed / ideas:
${contentSeed || "Share contrarian takes on industry trends, tactical how-tos, hot-takes backed by data, and company milestones"}

Business context:
- Company: ${businessProfile?.businessName ?? "Our Business"}
- Industry: ${businessProfile?.industry ?? "Business Services"}
- Target audience on X: ${businessProfile?.targetAudience ?? "Founders, operators, and industry professionals"}
- Value prop: ${businessProfile?.uniqueValueProp ?? "Cutting through noise with real expertise"}

Post type: ${postType}
${postType === "Thread" ? `Thread length: ${threadLength} tweets per thread` : ""}
${postType === "Reply" ? "Draft replies to hypothetical high-impression posts in our niche" : ""}
${postType === "Quote" ? "Draft quote-posts that add a distinct layer of commentary" : ""}

Return exactly this JSON shape:
{
  "posts": [
    {
      "id": "x_post_1",
      "postType": "${postType}",
      "scheduledDate": "YYYY-MM-DD",
      "scheduledTime": "HH:MM",
      "topic": "concise topic label",
      "tweets": [
        {
          "tweetNumber": 1,
          "text": "tweet text (max 280 chars)",
          "characterCount": 240,
          "isThread": false,
          "mediaNote": "optional image/gif description"
        }
      ],
      "threadThesis": "one-sentence core argument (for threads)",
      "estimatedImpressions": 8400,
      "estimatedEngagementRate": 2.8,
      "estimatedReplies": 14,
      "estimatedReposts": 32,
      "approved": false,
      "tags": ["#IndustryTag"]
    }
  ],
  "weeklyDistribution": {
    "Monday": 1, "Tuesday": 1, "Wednesday": 1, "Thursday": 1, "Friday": 1, "Saturday": 0, "Sunday": 0
  },
  "contentThemes": ["theme1", "theme2"],
  "strategyNotes": "2-3 sentences on the strategic intent and expected growth outcomes"
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

  // ── Auto-post first tweet/thread when approval not required ─────────────
  if (!requireApproval && xIntegration) {
    try {
      const creds = await decryptCredentials<{ access_token: string }>(
        xIntegration.encryptedCredentials
      );

      const posts = (output.posts as Array<Record<string, unknown>>) ?? [];
      const firstPost = posts[0];

      if (firstPost) {
        const tweets = (firstPost.tweets as Array<{ tweetNumber: number; text: string }>) ?? [];
        const firstTweet = tweets[0];

        if (firstTweet?.text) {
          // Post the first tweet (or thread root)
          const xRes = await fetch("https://api.twitter.com/2/tweets", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${creds.access_token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ text: firstTweet.text.slice(0, 280) }),
          });

          if (xRes.ok) {
            const xData = (await xRes.json()) as { data?: { id: string; text: string } };
            const tweetId = xData.data?.id;
            let replyToId = tweetId;

            // Post thread continuation tweets if applicable
            if (postType === "Thread" && tweets.length > 1 && replyToId) {
              for (const tweet of tweets.slice(1)) {
                const replyRes = await fetch("https://api.twitter.com/2/tweets", {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${creds.access_token}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    text: tweet.text.slice(0, 280),
                    reply: { in_reply_to_tweet_id: replyToId },
                  }),
                });
                if (replyRes.ok) {
                  const replyData = (await replyRes.json()) as { data?: { id: string } };
                  replyToId = replyData.data?.id;
                } else {
                  break; // stop thread on first failure
                }
              }
            }

            posts[0] = {
              ...firstPost,
              published: true,
              tweetId,
              tweetUrl: tweetId ? `https://x.com/i/web/status/${tweetId}` : undefined,
              publishedAt: new Date().toISOString(),
            };
            output.posts = posts;
            output.publishedCount = 1;
            output.source = "live";
          } else {
            const errBody = await xRes.text().catch(() => "");
            output.publishError = `X API ${xRes.status}: ${errBody}`;
            output.source = "draft";
          }
        }
      }
    } catch (err) {
      output.publishError = err instanceof Error ? err.message : "X publish failed";
      output.source = "draft";
    }
  } else if (!xIntegration) {
    output.source = "draft";
    output.simulationNote =
      "Connect X (Twitter) in Settings > Integrations to enable auto-publishing. Store OAuth 2.0 user access token as { access_token } with tweet.write and users.read scopes.";
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return { output, costUsd };
};

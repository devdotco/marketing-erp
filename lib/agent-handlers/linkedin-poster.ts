import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

export const linkedinPosterHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const accountType = (config.accountType as string) ?? "Personal Profile";
  const postingFrequency = (config.postingFrequency as string) ?? "3x week";
  const contentPillars = (config.contentPillars as string) ?? "";
  const toneOverride = (config.toneOverride as string) ?? "Use Brand default";
  const batchSize = (config.batchSize as number) ?? 7;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const linkedinIntegration = await prisma.integration.findUnique({
    where: {
      workspaceId_provider: {
        workspaceId: run.agentConfig.workspaceId,
        provider: "LINKEDIN",
      },
    },
  });

  const resolvedTone =
    toneOverride === "Use Brand default"
      ? (businessProfile?.brandVoice ?? "Professional")
      : toneOverride;

  const horizonLabel =
    postingFrequency === "Daily"
      ? "7 days"
      : postingFrequency === "3x week"
      ? "2.5 weeks"
      : "4 weeks";

  const systemPrompt = `You are an expert LinkedIn content strategist specialising in ${
    businessProfile?.industry ?? "business"
  }.
Your task is to create a batch of high-performing LinkedIn posts for ${
    accountType === "Company Page" ? "a company LinkedIn page" : "a personal LinkedIn profile"
  }.
Tone/voice: ${resolvedTone}
Company: ${businessProfile?.businessName ?? "the business"}
Always respond with ONLY a valid JSON object — no markdown fences, no extra prose.`;

  const userPrompt = `Create ${batchSize} LinkedIn posts to distribute over ${horizonLabel}.

Content pillars to draw from:
${contentPillars || "Thought Leadership, Industry Trends, Company Culture, Product Value, Client Success Stories"}

Business context:
- Company: ${businessProfile?.businessName ?? "Our Business"}
- Industry: ${businessProfile?.industry ?? "Business Services"}
- Target audience: ${businessProfile?.targetAudience ?? "Business professionals and decision-makers"}
- Key value proposition: ${businessProfile?.uniqueValueProp ?? "Delivering exceptional results for clients"}
- Website: ${businessProfile?.websiteUrl ?? "https://example.com"}

Return exactly this JSON shape (no other keys at root level):
{
  "posts": [
    {
      "id": "post_1",
      "scheduledDate": "YYYY-MM-DD",
      "scheduledTime": "HH:MM",
      "contentPillar": "string",
      "hook": "first line engineered to stop the scroll — no clickbait",
      "body": "full post body with \\n line breaks between paragraphs",
      "cta": "specific call-to-action sentence",
      "hashtags": ["#Hashtag1", "#Hashtag2", "#Hashtag3"],
      "postFormat": "text|carousel|poll|document|video",
      "mediaNote": "description of accompanying visual or leave empty string",
      "characterCount": 920,
      "estimatedImpressions": 4200,
      "estimatedEngagementRate": 3.6,
      "approved": false
    }
  ],
  "calendarSummary": {
    "startDate": "YYYY-MM-DD",
    "endDate": "YYYY-MM-DD",
    "totalPosts": 7,
    "pillarsDistribution": { "Thought Leadership": 2, "Industry Trends": 2, "Company Culture": 1, "Product Value": 1, "Client Success": 1 },
    "formatsMix": { "text": 4, "carousel": 2, "poll": 1 }
  },
  "strategyNotes": "2-3 sentences explaining strategic intent and expected outcomes"
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

  // ── Auto-publish first post when approval not required ───────────────────
  if (!requireApproval && linkedinIntegration) {
    try {
      const creds = await decryptCredentials<{
        access_token: string;
        person_id: string;
        company_id?: string;
      }>(linkedinIntegration.encryptedCredentials);

      const posts = (output.posts as Array<Record<string, unknown>>) ?? [];
      const firstPost = posts[0];

      if (firstPost) {
        const postText = [
          String(firstPost.hook ?? ""),
          String(firstPost.body ?? ""),
          String(firstPost.cta ?? ""),
          ((firstPost.hashtags as string[]) ?? []).join(" "),
        ]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 3000);

        const isCompanyPage = accountType === "Company Page" && creds.company_id;
        const author = isCompanyPage
          ? `urn:li:organization:${creds.company_id}`
          : `urn:li:person:${creds.person_id}`;

        const liRes = await fetch("https://api.linkedin.com/rest/posts", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${creds.access_token}`,
            "LinkedIn-Version": "202410",
            "X-Restli-Protocol-Version": "2.0.0",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            author,
            commentary: postText,
            visibility: "PUBLIC",
            distribution: {
              feedDistribution: "MAIN_FEED",
              targetEntities: [],
              thirdPartyDistributionChannels: [],
            },
            lifecycleState: "PUBLISHED",
            isReshareDisabledByAuthor: false,
          }),
        });

        if (liRes.ok || liRes.status === 201) {
          const postId = liRes.headers.get("x-restli-id") ?? liRes.headers.get("x-linkedin-id");
          posts[0] = { ...firstPost, published: true, linkedinPostId: postId, publishedAt: new Date().toISOString() };
          output.posts = posts;
          output.publishedCount = 1;
          output.source = "live";
        } else {
          const errBody = await liRes.text().catch(() => "");
          output.publishError = `LinkedIn API ${liRes.status}: ${errBody}`;
          output.source = "draft";
        }
      }
    } catch (err) {
      output.publishError = err instanceof Error ? err.message : "LinkedIn publish failed";
      output.source = "draft";
    }
  } else if (!linkedinIntegration) {
    output.source = "draft";
    output.simulationNote =
      "Connect LinkedIn in Settings > Integrations to enable auto-publishing. Store credentials as { access_token, person_id } for personal profiles or add company_id for Company Pages.";
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return { output, costUsd };
};

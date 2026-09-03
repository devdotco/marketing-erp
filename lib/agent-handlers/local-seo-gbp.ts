import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

interface GbpLocalPost {
  name?: string;
  summary?: string;
  topicType?: string;
  createTime?: string;
}

interface GbpQuestion {
  name?: string;
  text?: string;
  upvoteCount?: number;
}

export const localSeoGbpHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const gbpLocation = String(config.gbpLocation ?? "");
  const businessCategory = String(config.businessCategory ?? "");
  const postFrequency = String(config.postFrequency ?? "Weekly");
  const reviewResponseStyle = String(config.reviewResponseStyle ?? "Professional");
  const citationCheckUrls = String(config.citationCheckUrls ?? "");

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business name: ${businessProfile.businessName}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.brandVoice ? `Brand voice: ${businessProfile.brandVoice}` : "",
        businessProfile.targetAudience ? `Target audience: ${businessProfile.targetAudience}` : "",
        businessProfile.goals ? `Business goals: ${JSON.stringify(businessProfile.goals)}` : "",
        businessProfile.uniqueValueProp ? `Unique value: ${businessProfile.uniqueValueProp}` : "",
        businessProfile.websiteUrl ? `Website: ${businessProfile.websiteUrl}` : "",
      ].filter(Boolean).join("\n")
    : "";

  const effectiveBrandVoice =
    reviewResponseStyle === "Brand Voice"
      ? (businessProfile?.brandVoice ?? "professional and helpful")
      : reviewResponseStyle.toLowerCase();

  // --- Live GBP integration ---
  const integration = await prisma.integration.findUnique({
    where: {
      workspaceId_provider: {
        workspaceId: run.agentConfig.workspaceId,
        provider: "GOOGLE_BUSINESS_PROFILE",
      },
    },
  });

  let gbpCreds: { access_token: string; account_id: string; location_id: string } | null = null;
  let isLive = false;
  let liveContext = "";
  let existingQuestions: GbpQuestion[] = [];

  if (integration) {
    try {
      gbpCreds = await decryptCredentials<{
        access_token: string;
        account_id: string;
        location_id: string;
      }>(integration.encryptedCredentials);

      const baseUrl = `https://mybusiness.googleapis.com/v4/accounts/${gbpCreds.account_id}/locations/${gbpCreds.location_id}`;
      const authHeaders = { Authorization: `Bearer ${gbpCreds.access_token}` };

      const [postsRes, questionsRes] = await Promise.all([
        fetch(`${baseUrl}/localPosts?pageSize=5`, { headers: authHeaders }),
        fetch(`${baseUrl}/questions?pageSize=10`, { headers: authHeaders }),
      ]);

      if (postsRes.ok) {
        const postsData = (await postsRes.json()) as { localPosts?: GbpLocalPost[] };
        const recentPosts = postsData.localPosts ?? [];
        if (recentPosts.length > 0) {
          liveContext += "\nRecent GBP posts (last 5 — avoid repeating these topics):\n";
          for (const p of recentPosts) {
            liveContext += `- [${p.topicType ?? "POST"}] ${p.summary ?? "(no summary)"} (${p.createTime ?? ""})\n`;
          }
        }
        isLive = true;
      }

      if (questionsRes.ok) {
        const questionsData = (await questionsRes.json()) as { questions?: GbpQuestion[] };
        existingQuestions = questionsData.questions ?? [];
        if (existingQuestions.length > 0) {
          liveContext += "\nExisting Q&A already on the GBP listing (do not duplicate):\n";
          for (const q of existingQuestions.slice(0, 5)) {
            liveContext += `- ${q.text ?? "(no text)"}\n`;
          }
        }
        isLive = true;
      }
    } catch {
      // decryption or network error — fall back to simulation
      gbpCreds = null;
      isLive = false;
      liveContext = "";
    }
  }
  // --- end live GBP setup ---

  const systemPrompt = [
    "You are a local SEO specialist with deep expertise in Google Business Profile optimisation.",
    "GBP posts should be informative and timely — not just promotional. Mix value-driven content with offers.",
    "Review responses must acknowledge the specific feedback, not use generic templates.",
    "Each response should feel personal and written by a human who read the review carefully.",
    "Return ONLY valid JSON — no markdown fences, no preamble.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ].filter(Boolean).join("\n");

  const postCounts: Record<string, number> = {
    Weekly: 4,
    "3x week": 12,
    Daily: 28,
  };
  const postCount = postCounts[postFrequency] ?? 4;

  const citationDirectories = citationCheckUrls
    .split(/[\n,]+/)
    .map((u) => u.trim())
    .filter(Boolean);

  const jsonExample = {
    gbpPosts: [
      {
        postType: "update",
        headline: "Post headline (max 58 chars for preview)",
        body: "Post body text (100-300 characters)...",
        cta: { type: "Learn more | Call now | Book | Shop | Sign up", url: "https://..." },
        scheduledDate: new Date().toISOString().split("T")[0],
        imageNote: "Description of ideal image for this post...",
      },
    ],
    reviewReplies: [
      {
        reviewRating: 5,
        reviewSnippet: "Snippet of what the reviewer might say...",
        suggestedReply:
          "Full reply text that acknowledges specific feedback and feels personal...",
        tone: effectiveBrandVoice,
      },
    ],
    qaAnswers: [
      {
        question: "Common customer question...",
        answer: "Clear, helpful answer (max 300 chars for GBP)...",
      },
    ],
    citationReport: {
      checkedDirectories: citationDirectories.length > 0 ? citationDirectories : ["google.com", "yelp.com", "bing.com", "maps.apple.com", "facebook.com"],
      inconsistencies: [
        {
          directory: "yelp.com",
          issue: "Description of the NAP inconsistency found...",
          correctValue: "The correct value that should be used...",
        },
      ],
      napScore: 85,
    },
    ...(isLive
      ? {}
      : {
          simulationNote:
            "Connect Google Business Profile in Settings to post directly and monitor real reviews",
        }),
  };

  const userPrompt = [
    `Generate a Google Business Profile content plan for: ${gbpLocation || "the client location"}`,
    businessCategory ? `Business category: ${businessCategory}` : "",
    `Post frequency: ${postFrequency} (generate ${postCount} posts)`,
    `Review response tone: ${effectiveBrandVoice}`,
    liveContext ? `\nLive GBP data:${liveContext}` : "",
    "",
    "Generate:",
    `1. ${postCount} GBP posts (mix of update, offer, event, and product types)`,
    "   - Posts should be 100-300 characters",
    "   - Include a natural CTA where appropriate",
    "   - Stagger scheduled dates starting from today",
    "   - Note what image type would work best",
    "",
    "2. 5 example review reply templates covering:",
    "   - 5-star enthusiastic review",
    "   - 5-star brief review",
    "   - 4-star review with minor concern",
    "   - 3-star neutral review",
    "   - 1-2 star negative review",
    "",
    "3. 5 common Q&A pairs for the GBP Q&A section",
    "",
    citationDirectories.length > 0
      ? `4. Citation consistency check for these directories:\n${citationDirectories.join("\n")}`
      : "4. Citation consistency check for top 5 local directories (Google, Yelp, Bing, Apple Maps, Facebook)",
    "",
    "Return this exact JSON structure:",
    JSON.stringify(jsonExample),
  ].filter(Boolean).join("\n");

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { gbpContent: rawText };
  } catch {
    output = { gbpContent: rawText };
  }

  // Mark source and clean up simulationNote when live
  if (isLive) {
    output.source = "live";
    delete output.simulationNote;
  } else {
    output.source = "simulation";
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  // Haiku 4.5 pricing: $0.80/M input, $4/M output
  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  const requireApproval = config.requireApproval !== false;

  // Auto-create posts via GBP API when live and approval not required
  if (gbpCreds && isLive && !requireApproval) {
    const posts = (output.gbpPosts as Array<{
      body?: string;
      headline?: string;
      cta?: { url?: string };
    }>) ?? [];

    const baseUrl = `https://mybusiness.googleapis.com/v4/accounts/${gbpCreds.account_id}/locations/${gbpCreds.location_id}`;
    const postHeaders = {
      Authorization: `Bearer ${gbpCreds.access_token}`,
      "Content-Type": "application/json",
    };

    const createdPostIds: string[] = [];
    for (const post of posts.slice(0, postCount)) {
      try {
        const bodyText = post.body ?? post.headline ?? "";
        if (!bodyText) continue;
        const payload: Record<string, unknown> = {
          languageCode: "en-US",
          summary: bodyText,
          topicType: "STANDARD",
        };
        if (post.cta?.url) {
          payload.callToAction = { actionType: "LEARN_MORE", url: post.cta.url };
        }
        const res = await fetch(`${baseUrl}/localPosts`, {
          method: "POST",
          headers: postHeaders,
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          const data = (await res.json()) as { name?: string };
          createdPostIds.push(data.name ?? "created");
        }
      } catch {
        // skip individual post errors; remaining posts still attempted
      }
    }

    if (createdPostIds.length > 0) {
      output.createdPostIds = createdPostIds;
    }
  }

  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};

import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { googleCredentials, liveCallFailed } from "@/lib/integrations/google";
import { resolvePropertyOverride } from "@/lib/integrations/google-resources";
import { AgentInputError } from "@/lib/ai/errors";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { lines, resolveInputs, str } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";

interface GbpLocalPost {
  name?: string;
  summary?: string;
  topicType?: string;
  createTime?: string;
}

export const localSeoGbpHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);

  const config = resolveInputs(run);
  const gbpLocation = String(config.gbpLocation ?? "");
  const businessCategory = String(config.businessCategory ?? "");
  const postFrequency = String(config.postFrequency ?? "Weekly");
  const reviewResponseStyle = String(config.reviewResponseStyle ?? "Professional");
  const citationCheckUrls = String(config.citationCheckUrls ?? "");
  const targetKeywords = lines(config, "targetKeywords", 25);
  const serviceArea = str(config, "serviceArea");
  const postImageUrl = str(config, "postImageUrl");

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

  // Not connected → simulating below is fine. Connected but the call fails →
  // fail the run rather than quietly ship simulated content as "live".
  if (integration) {
    try {
      const creds = await googleCredentials(integration);
      // A submitted dropdown choice ("accountId/locationId") wins over the
      // integration's saved default — but it's still just a client string,
      // so it's checked against what this grant can actually reach first.
      const resolvedLocation = await resolvePropertyOverride("GOOGLE_BUSINESS_PROFILE", creds, gbpLocation);
      const [resolvedAccountId, resolvedLocationId] = resolvedLocation
        ? resolvedLocation.split("/")
        : [creds.account_id, creds.location_id];
      if (!resolvedAccountId || !resolvedLocationId) {
        throw new AgentInputError(
          "Google Business Profile is connected, but no location has been selected.",
          "Open Integrations → Google Business Profile and choose a location.",
          "integration_not_configured",
        );
      }
      gbpCreds = { access_token: creds.access_token, account_id: resolvedAccountId, location_id: resolvedLocationId };

      // Local Posts is still live on the legacy v4 host. Its sibling Q&A API
      // was discontinued 2025-11-03 — do not add a /questions call back here.
      const baseUrl = `https://mybusiness.googleapis.com/v4/accounts/${gbpCreds.account_id}/locations/${gbpCreds.location_id}`;
      const postsRes = await fetch(`${baseUrl}/localPosts?pageSize=5`, {
        headers: { Authorization: `Bearer ${gbpCreds.access_token}` },
      });
      if (!postsRes.ok) {
        throw new Error(`Business Profile Local Posts API ${postsRes.status}: ${(await postsRes.text()).slice(0, 300)}`);
      }

      const postsData = (await postsRes.json()) as { localPosts?: GbpLocalPost[] };
      const recentPosts = postsData.localPosts ?? [];
      if (recentPosts.length > 0) {
        liveContext += "\nRecent GBP posts (last 5 — avoid repeating these topics):\n";
        for (const p of recentPosts) {
          liveContext += `- [${p.topicType ?? "POST"}] ${p.summary ?? "(no summary)"} (${p.createTime ?? ""})\n`;
        }
      }
      isLive = true;
    } catch (err) {
      if (err instanceof AgentInputError) throw err;
      throw liveCallFailed("Google Business Profile", err instanceof Error ? err.message : String(err));
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
    serviceArea ? `Primary service area: ${serviceArea} — ground posts and Q&A answers in this area by name where it reads naturally` : "",
    targetKeywords.length > 0
      ? `Target local keywords (work these naturally into post copy and Q&A answers — never stuff): ${targetKeywords.join(", ")}`
      : "",
    postImageUrl ? "Posts will carry a supplied default photo, so imageNote may simply confirm the default image fits." : "",
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
    model: MODELS.fast,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = textFrom(message);
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
  if (postImageUrl) output.defaultPostImageUrl = postImageUrl;
  // Priced from lib/ai/models.ts — Haiku 4.5 is $1/M input, $5/M output.
  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

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
        if (postImageUrl) {
          payload.media = [{ mediaFormat: "PHOTO", sourceUrl: postImageUrl }];
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

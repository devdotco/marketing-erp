import type { AgentHandler } from "./index";
import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { createMessage } from "@/lib/ai/messages";
import { resolveInputs, str, num, bool } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { AgentInputError } from "@/lib/ai/errors";
import { strictSchema, asArray } from "@/lib/content/article";
import type { MetaStagedPost } from "./meta-poster-delivery";

/**
 * Drafts a batch of Facebook/Instagram posts and stages them — nothing is published during this
 * run. Meta (unlike LinkedIn/X) has no SocialPlatform enum value (prisma/schema.prisma only has
 * LINKEDIN and TWITTER_X), so this agent keeps using the workspace's connected META `Integration` —
 * a real connect method (lib/integrations/catalog.ts's CONNECT_METHODS.META), unlike the missing
 * LINKEDIN/TWITTER_X entries linkedin-poster.ts and x-poster.ts used to (wrongly) depend on.
 * Publishing happens from the approval hook (lib/agent-handlers/on-approve.ts's metaPosterOnApprove),
 * not here, and not during the run.
 *
 * Meta's Graph API endpoints this integration calls (POST /{page}/feed, the Instagram container +
 * publish pair) publish immediately — there is no native scheduling for either, unlike LinkedIn/X
 * Poster which schedule through SocialPost + app/api/cron/social-publish. So approving this run
 * publishes every staged post in the batch right away, not spread across the days a cadence would
 * imply; the copy here and in lib/agent-metadata.ts says so rather than promising a schedule this
 * integration cannot keep.
 */

const SUBMIT_BATCH_TOOL_NAME = "submit_meta_batch";

export const SUBMIT_BATCH_TOOL: Anthropic.Tool = {
  name: SUBMIT_BATCH_TOOL_NAME,
  strict: true,
  description: "Submit the drafted batch of Facebook/Instagram posts.",
  input_schema: strictSchema({
    type: "object",
    required: ["posts", "strategyNotes"],
    properties: {
      posts: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["platform", "caption", "hashtags", "callToAction"],
          properties: {
            platform: { type: "string", enum: ["Facebook", "Instagram"] },
            caption: { type: "string", description: "Full caption text, platform-adapted." },
            hashtags: { type: "array", minItems: 0, items: { type: "string" } },
            callToAction: { type: "string", description: "e.g. Link in bio / Comment below / DM us." },
          },
        },
      },
      strategyNotes: { type: "string", description: "2-3 sentences on the strategic intent across the batch." },
    },
  }),
};

export const metaPosterHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const workspaceId = run.agentConfig.workspaceId;
  const config = resolveInputs(run);

  const sourceUrl = str(config, "sourceUrl");
  const rawBrief = str(config, "rawBrief");
  const targetPlatformsLabel = str(config, "targetPlatforms", "Facebook + Instagram");
  const contentStyle = str(config, "contentStyle", "Mixed");
  const includeHashtags = bool(config, "includeHashtags", true);
  const batchSize = num(config, "batchSize", 5, { min: 1, max: 10 });

  const targetPlatforms: "Facebook" | "Instagram" | "Both" =
    targetPlatformsLabel === "Facebook only" ? "Facebook" : targetPlatformsLabel === "Instagram only" ? "Instagram" : "Both";

  const metaIntegration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId, provider: "META" } },
  });
  if (!metaIntegration) {
    throw new AgentInputError(
      "No Meta integration is connected for this workspace.",
      "Connect Meta under Settings → Integrations before running this agent — there is nowhere for an approved post to publish to otherwise.",
      "meta_not_connected",
    );
  }

  const { client } = await resolveAnthropic(workspaceId);
  const businessProfile = await prisma.businessProfile.findFirst({ where: { workspaceId } });

  const system = [
    "You are a Meta social media strategist specialising in Facebook and Instagram content.",
    "Write distinct content optimised per platform with appropriate tone, length, and CTA for each.",
    `Content style: ${contentStyle}.`,
    includeHashtags ? "Include a relevant hashtag set per post." : "Do not include hashtags.",
    "Respond ONLY with the submit_meta_batch tool call.",
  ].join("\n");

  const userPrompt = [
    `Draft a batch of ${batchSize} Meta posts for ${businessProfile?.businessName ?? "the client"}, distributed across ${targetPlatformsLabel}.`,
    sourceUrl ? `Source URL to adapt: ${sourceUrl}` : "",
    rawBrief ? `Brief:\n${rawBrief}` : "",
    `Business context:`,
    `- Industry: ${businessProfile?.industry ?? "General"}`,
    `- Value proposition: ${businessProfile?.uniqueValueProp ?? "Not specified"}`,
    `- Target audience: ${businessProfile?.targetAudience ?? "Not specified"}`,
    `- Competitors: ${(businessProfile?.competitors ?? []).join(", ") || "Not specified"}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const message = await createMessage(client, {
    model: MODELS.standard,
    max_tokens: 8096,
    system,
    tools: [SUBMIT_BATCH_TOOL],
    tool_choice: { type: "tool", name: SUBMIT_BATCH_TOOL_NAME },
    messages: [{ role: "user", content: userPrompt }],
  });

  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  const block = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === SUBMIT_BATCH_TOOL_NAME,
  );
  if (!block) throw new Error("Meta Poster's drafting call did not submit a batch.");

  const submitted = block.input as { posts?: unknown; strategyNotes?: string };
  const rawPosts = asArray<{ platform?: unknown; caption?: unknown; hashtags?: unknown; callToAction?: unknown }>(submitted.posts);

  const pendingPosts: MetaStagedPost[] = rawPosts.map((p, i) => ({
    id: `post_${i + 1}`,
    platform: p.platform === "Instagram" ? "Instagram" : "Facebook",
    surface: "feed",
    caption: typeof p.caption === "string" ? p.caption : "",
    hashtags: (Array.isArray(p.hashtags) ? p.hashtags : []).filter((h): h is string => typeof h === "string"),
    status: "pending",
  }));

  const output: Record<string, unknown> = {
    pendingPosts,
    targetPlatforms,
    callsToAction: rawPosts.map((p) => (typeof p.callToAction === "string" ? p.callToAction : "")),
    strategyNotes: submitted.strategyNotes ?? "",
    generatedAt: new Date().toISOString(),
    workspaceId,
    howItWorks:
      "Nothing is published during this run. Approving it publishes every post in this batch immediately, via Meta's Graph API — Facebook feed posts as text, Instagram feed posts only for entries that carry an imageUrl (add one to a post's imageUrl field before approving, or it is marked for manual posting). Neither Meta endpoint this integration calls supports native scheduling, so unlike LinkedIn/X Poster this batch does not spread out over the days a cadence would imply — it all goes out at once, on approval.",
    approvalNote: "Nothing is sent to Facebook or Instagram until a workspace admin approves this run.",
  };

  await updateStatus("AWAITING_APPROVAL", output);

  return { output, costUsd };
};

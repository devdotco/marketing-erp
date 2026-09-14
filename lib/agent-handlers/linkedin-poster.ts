import type { AgentHandler } from "./index";
import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { createMessage } from "@/lib/ai/messages";
import { resolveInputs, str, num, bool } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { AgentInputError } from "@/lib/ai/errors";
import { strictSchema, asArray } from "@/lib/content/article";
import {
  computeScheduledTimes,
  validateSocialAccount,
  type PendingSocialPost,
  type PostingFrequency,
} from "./social-poster-shared";

/**
 * Drafts a batch of LinkedIn posts and stages them — nothing is written to LinkedIn during this
 * run. Credentials come from the Social module's `SocialAccount` (connected at /social/accounts,
 * OAuth in app/api/linkedin/callback), not a `prisma.integration` row: LINKEDIN has no entry in
 * lib/integrations/catalog.ts's CONNECT_METHODS, so an Integration row with that provider could
 * never have been created by anything in this app. See lib/agent-handlers/social-poster-shared.ts
 * for the scheduling/validation helpers this file shares with x-poster.ts, and
 * lib/agent-handlers/on-approve.ts's socialPosterOnApprove for what happens once a workspace admin
 * approves this run: it creates one `SocialPost` per staged post, scheduled at the time computed
 * below, and app/api/cron/social-publish is what actually calls the LinkedIn API — reusing that
 * cron's existing token refresh and company-page handling instead of duplicating it here.
 */

const SUBMIT_BATCH_TOOL_NAME = "submit_linkedin_batch";

export const SUBMIT_BATCH_TOOL: Anthropic.Tool = {
  name: SUBMIT_BATCH_TOOL_NAME,
  strict: true,
  description: "Submit the drafted batch of LinkedIn posts.",
  input_schema: strictSchema({
    type: "object",
    required: ["posts", "strategyNotes"],
    properties: {
      posts: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["contentPillar", "hook", "body", "cta", "hashtags", "postFormat"],
          properties: {
            contentPillar: { type: "string", description: "Which content pillar this post draws from." },
            hook: { type: "string", description: "First line engineered to stop the scroll — no clickbait." },
            body: { type: "string", description: "Full post body, with blank lines between paragraphs." },
            cta: { type: "string", description: "Specific call-to-action sentence." },
            hashtags: { type: "array", minItems: 0, items: { type: "string" } },
            postFormat: { type: "string", enum: ["text", "carousel", "poll", "document"] },
          },
        },
      },
      strategyNotes: { type: "string", description: "2-3 sentences on the strategic intent across the batch." },
    },
  }),
};

export const linkedinPosterHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const workspaceId = run.agentConfig.workspaceId;
  const config = resolveInputs(run);

  const socialAccountId = str(config, "socialAccountId");
  const sourceUrl = str(config, "sourceUrl");
  const rawBrief = str(config, "rawBrief");
  const contentPillars = str(config, "contentPillars");
  const targetAudience = str(config, "targetAudience");
  const toneOverride = str(config, "toneOverride", "Use Brand default");
  const postFormat = str(config, "postFormat", "Auto-detect");
  const includeEmoji = bool(config, "includeEmoji", true);
  const hashtagCount = num(config, "hashtagCount", 4, { min: 0, max: 8 });
  const postingFrequency = str(config, "postingFrequency", "3x week") as PostingFrequency;
  const postingWindow = str(config, "postingWindow", "Auto (peak audience)");
  const batchSize = num(config, "batchSize", 7, { min: 1, max: 14 });

  if (!socialAccountId) {
    throw new AgentInputError(
      "No LinkedIn account was selected.",
      "Pick a connected LinkedIn account, or connect one at /social/accounts.",
      "no_account_selected",
    );
  }

  // Validate the account BEFORE spending any Anthropic tokens — an expired or foreign account is
  // exactly as much a dead end after drafting as before it, so there's no reason to draft first.
  const account = await prisma.socialAccount.findUnique({ where: { id: socialAccountId } });
  const validation = validateSocialAccount(account, { workspaceId, platform: "LINKEDIN" });
  if (!validation.ok) {
    throw new AgentInputError(validation.message, validation.hint, `linkedin_account_${validation.code}`);
  }

  const { client } = await resolveAnthropic(workspaceId);
  const businessProfile = await prisma.businessProfile.findFirst({ where: { workspaceId } });

  const resolvedTone =
    toneOverride === "Use Brand default" ? (businessProfile?.brandVoice ?? "Professional") : toneOverride;
  const isCompanyPage = account!.accountType === "COMPANY";

  const system = [
    `You are an expert LinkedIn content strategist specialising in ${businessProfile?.industry ?? "business"}.`,
    `Draft a batch of high-performing LinkedIn posts for ${isCompanyPage ? "a company LinkedIn page" : "a personal LinkedIn profile"} (${account!.displayName}).`,
    `Tone: ${resolvedTone}.`,
    `Company: ${businessProfile?.businessName ?? "the business"}.`,
    postFormat !== "Auto-detect" ? `Preferred post format: ${postFormat}.` : "Choose whichever format (text, carousel, poll, document) best suits each post's content.",
    targetAudience ? `Target audience: ${targetAudience}.` : "",
    `${includeEmoji ? "Use emoji sparingly for scannability." : "Do not use emoji — keep a formal, executive tone."}`,
    `Include roughly ${hashtagCount} relevant hashtags per post.`,
    "Return ONLY the submit_linkedin_batch tool call.",
  ]
    .filter(Boolean)
    .join("\n");

  const userPrompt = [
    `Draft ${batchSize} LinkedIn posts.`,
    sourceUrl ? `Source URL to adapt: ${sourceUrl}` : "",
    rawBrief ? `Brief:\n${rawBrief}` : "",
    `Content pillars to draw from:\n${contentPillars || "Thought Leadership, Industry Trends, Company Culture, Product Value, Client Success Stories"}`,
    `Business context:`,
    `- Company: ${businessProfile?.businessName ?? "Our Business"}`,
    `- Industry: ${businessProfile?.industry ?? "Business Services"}`,
    `- Target audience: ${targetAudience || businessProfile?.targetAudience || "Business professionals and decision-makers"}`,
    `- Key value proposition: ${businessProfile?.uniqueValueProp ?? "Delivering exceptional results for clients"}`,
    `- Website: ${businessProfile?.websiteUrl ?? "https://example.com"}`,
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
  if (!block) throw new Error("LinkedIn Poster's drafting call did not submit a batch.");

  const submitted = block.input as { posts?: unknown; strategyNotes?: string };
  const rawPosts = asArray<{
    contentPillar?: unknown;
    hook?: unknown;
    body?: unknown;
    cta?: unknown;
    hashtags?: unknown;
    postFormat?: unknown;
  }>(submitted.posts);

  const startAt = new Date();
  const scheduledTimes = computeScheduledTimes({ batchSize: rawPosts.length, frequency: postingFrequency, window: postingWindow, startAt });

  const draftedPosts = rawPosts.map((p, i) => {
    const hook = typeof p.hook === "string" ? p.hook.trim() : "";
    const body = typeof p.body === "string" ? p.body.trim() : "";
    const cta = typeof p.cta === "string" ? p.cta.trim() : "";
    const hashtags = (Array.isArray(p.hashtags) ? p.hashtags : []).filter((h): h is string => typeof h === "string");
    const content = [hook, body, cta, hashtags.join(" ")].filter(Boolean).join("\n\n").slice(0, 3000);
    return {
      id: `post_${i + 1}`,
      contentPillar: typeof p.contentPillar === "string" ? p.contentPillar : "",
      hook,
      body,
      cta,
      hashtags,
      postFormat: typeof p.postFormat === "string" ? p.postFormat : "text",
      content,
      scheduledAt: (scheduledTimes[i] ?? startAt).toISOString(),
    };
  });

  const pendingPosts: PendingSocialPost[] = draftedPosts.map((p) => ({ id: p.id, content: p.content, scheduledAt: p.scheduledAt }));

  const output: Record<string, unknown> = {
    posts: draftedPosts,
    pendingPosts,
    platform: "LINKEDIN",
    socialAccountId: account!.id,
    accountLabel: account!.displayName,
    accountType: account!.accountType,
    createdSocialPostIds: {},
    strategyNotes: submitted.strategyNotes ?? "",
    generatedAt: new Date().toISOString(),
    workspaceId,
    howItWorks:
      `Nothing is sent to LinkedIn during this run. Approving it schedules each post as a SocialPost tied to ${account!.displayName}; ` +
      `app/api/cron/social-publish publishes each one at its scheduled time via LinkedIn's UGC Posts API (refreshing the token first if needed) — ` +
      `there is no such thing as a LinkedIn "Scheduled Posts API"; LinkedIn's API only publishes immediately, so scheduling is done on this side.`,
    approvalNote: "Nothing is sent to LinkedIn until a workspace admin approves this run.",
  };

  await updateStatus("AWAITING_APPROVAL", output);

  return { output, costUsd };
};

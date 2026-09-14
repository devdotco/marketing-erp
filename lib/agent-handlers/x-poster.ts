import type { AgentHandler } from "./index";
import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { createMessage } from "@/lib/ai/messages";
import { resolveInputs, str, num } from "@/lib/agents/inputs";
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
 * Drafts a batch of X posts/threads and stages them — nothing is written to X during this run.
 * Credentials come from the Social module's `SocialAccount` (connected at /social/accounts, OAuth
 * in app/api/x/callback), not a `prisma.integration` row: TWITTER_X has no entry in
 * lib/integrations/catalog.ts's CONNECT_METHODS, so an Integration row with that provider could
 * never have been created by anything in this app. See social-poster-shared.ts for the scheduling/
 * validation helpers this file shares with linkedin-poster.ts.
 *
 * KNOWN GAP (reported, not fixed here — see the task report): SocialPost/app/api/cron/social-publish
 * publish a single tweet each; there is no reply-chaining field on SocialPost, so a drafted THREAD's
 * continuation tweets cannot be auto-posted as replies to the root tweet the way the old inline
 * handler attempted. Only each queue item's first tweet is scheduled as a SocialPost; any
 * additional thread tweets are returned in the output for the person to post manually as replies.
 */

const SUBMIT_BATCH_TOOL_NAME = "submit_x_batch";

export const SUBMIT_BATCH_TOOL: Anthropic.Tool = {
  name: SUBMIT_BATCH_TOOL_NAME,
  strict: true,
  description: "Submit the drafted batch of X posts.",
  input_schema: strictSchema({
    type: "object",
    required: ["posts", "strategyNotes"],
    properties: {
      posts: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["topic", "tweets"],
          properties: {
            topic: { type: "string", description: "Concise topic label for this post/thread." },
            tweets: {
              type: "array",
              minItems: 1,
              description: "Tweet 1 must contain the full thesis; further entries only for a Thread.",
              items: {
                type: "object",
                required: ["text"],
                properties: {
                  text: { type: "string", description: "Tweet text, max 280 characters." },
                },
              },
            },
          },
        },
      },
      strategyNotes: { type: "string", description: "2-3 sentences on the strategic intent across the batch." },
    },
  }),
};

export const xPosterHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const workspaceId = run.agentConfig.workspaceId;
  const config = resolveInputs(run);

  const socialAccountId = str(config, "socialAccountId");
  const sourceUrl = str(config, "sourceUrl");
  const rawBrief = str(config, "rawBrief");
  const postType = str(config, "postType", "Standalone");
  const threadLength = num(config, "threadLength", 6, { min: 2, max: 10 });
  const hashtagStyle = str(config, "hashtagStyle", "None");
  const postingFrequency = str(config, "postingFrequency", "3x week") as PostingFrequency;
  const postingWindow = str(config, "postingWindow", "Auto (peak audience)");
  const batchSize = num(config, "batchSize", 7, { min: 1, max: 14 });

  if (!socialAccountId) {
    throw new AgentInputError(
      "No X account was selected.",
      "Pick a connected X account, or connect one at /social/accounts.",
      "no_account_selected",
    );
  }

  const account = await prisma.socialAccount.findUnique({ where: { id: socialAccountId } });
  const validation = validateSocialAccount(account, { workspaceId, platform: "TWITTER_X" });
  if (!validation.ok) {
    throw new AgentInputError(validation.message, validation.hint, `x_account_${validation.code}`);
  }

  const { client } = await resolveAnthropic(workspaceId);
  const businessProfile = await prisma.businessProfile.findFirst({ where: { workspaceId } });

  const horizonDays = postingFrequency === "Daily" ? 7 : postingFrequency === "Weekly" ? 28 : 17;

  const system = [
    `You are an elite X (Twitter) content strategist for ${businessProfile?.businessName ?? "a business"} in the ${businessProfile?.industry ?? "business"} space, posting as ${account!.displayName}.`,
    "You write posts that lead with the conclusion, pack insight per word, and never pad.",
    "Thread rule: tweet 1 must contain the full thesis — the rest amplify, prove, or nuance.",
    `Post type for this batch: ${postType}.`,
    postType === "Thread" ? `Thread length: ${threadLength} tweets per thread.` : "",
    postType === "Reply" ? "Draft replies to hypothetical high-impression posts in our niche — tweet 1 is the reply." : "",
    postType === "Quote" ? "Draft quote-posts that add a distinct layer of commentary — tweet 1 is the quote commentary." : "",
    hashtagStyle === "None" ? "Do not use hashtags." : hashtagStyle === "Inline (1-2 tags)" ? "Use 1-2 hashtags inline, sparingly." : "Put hashtags at the end of the post, 1-2 only.",
    "Return ONLY the submit_x_batch tool call.",
  ]
    .filter(Boolean)
    .join("\n");

  const userPrompt = [
    `Draft ${batchSize} X posts for the next ${horizonDays} days.`,
    sourceUrl ? `Source URL to adapt: ${sourceUrl}` : "",
    rawBrief ? `Content seed / brief:\n${rawBrief}` : "",
    `Business context:`,
    `- Company: ${businessProfile?.businessName ?? "Our Business"}`,
    `- Industry: ${businessProfile?.industry ?? "Business Services"}`,
    `- Target audience on X: ${businessProfile?.targetAudience ?? "Founders, operators, and industry professionals"}`,
    `- Value prop: ${businessProfile?.uniqueValueProp ?? "Cutting through noise with real expertise"}`,
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
  if (!block) throw new Error("X Poster's drafting call did not submit a batch.");

  const submitted = block.input as { posts?: unknown; strategyNotes?: string };
  const rawPosts = asArray<{ topic?: unknown; tweets?: unknown }>(submitted.posts);

  const startAt = new Date();
  const scheduledTimes = computeScheduledTimes({ batchSize: rawPosts.length, frequency: postingFrequency, window: postingWindow, startAt });

  const draftedPosts = rawPosts.map((p, i) => {
    const tweets = asArray<{ text?: unknown }>(p.tweets)
      .map((t) => (typeof t.text === "string" ? t.text.trim().slice(0, 280) : ""))
      .filter(Boolean);
    const rootTweet = tweets[0] ?? "";
    return {
      id: `post_${i + 1}`,
      topic: typeof p.topic === "string" ? p.topic : "",
      postType,
      tweets,
      content: rootTweet,
      additionalTweets: tweets.slice(1),
      scheduledAt: (scheduledTimes[i] ?? startAt).toISOString(),
    };
  });

  const pendingPosts: PendingSocialPost[] = draftedPosts
    .filter((p) => p.content)
    .map((p) => ({ id: p.id, content: p.content, scheduledAt: p.scheduledAt }));

  const threadNote =
    postType === "Thread"
      ? "Only each thread's first tweet is scheduled and auto-posted — the Social module has no reply-chaining support yet, so continuation tweets (see additionalTweets on each post) must be posted manually as replies once the root tweet is live."
      : undefined;

  const output: Record<string, unknown> = {
    posts: draftedPosts,
    pendingPosts,
    platform: "TWITTER_X",
    socialAccountId: account!.id,
    accountLabel: account!.displayName,
    createdSocialPostIds: {},
    strategyNotes: submitted.strategyNotes ?? "",
    generatedAt: new Date().toISOString(),
    workspaceId,
    threadNote,
    howItWorks:
      `Nothing is posted to X during this run. Approving it schedules each post as a SocialPost tied to ${account!.displayName}; ` +
      `app/api/cron/social-publish posts each one at its scheduled time via X API v2 (refreshing the token first if needed).`,
    approvalNote: "Nothing is sent to X until a workspace admin approves this run.",
  };

  await updateStatus("AWAITING_APPROVAL", output);

  return { output, costUsd };
};

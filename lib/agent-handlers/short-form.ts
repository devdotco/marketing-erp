import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const shortFormHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const platform = String(config.platform ?? "All");
  const durationSeconds = Number(config.durationSeconds ?? 60);
  const hook = String(config.hook ?? "");
  const topic = String(config.topic ?? "");
  const batchSize = Number(config.batchSize ?? 5);

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business: ${businessProfile.businessName}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.targetAudience ? `Target audience: ${businessProfile.targetAudience}` : "",
        businessProfile.uniqueValueProp ? `Unique value proposition: ${businessProfile.uniqueValueProp}` : "",
        businessProfile.websiteUrl ? `Website: ${businessProfile.websiteUrl}` : "",
        businessProfile.competitors?.length
          ? `Competing with: ${businessProfile.competitors.join(", ")}`
          : "",
      ].filter(Boolean).join("\n")
    : "";

  const systemPrompt = [
    "You are a short-form video script specialist.",
    "Every script opens with a pattern interrupt hook in the first 2 seconds.",
    "Scripts are written for teleprompter reading at a natural pace.",
    "On-screen text reinforces (not repeats) spoken words.",
    "Respond ONLY with valid JSON — no markdown fences, no preamble.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ].filter(Boolean).join("\n");

  const platformLine = platform === "All"
    ? "TikTok, Instagram Reels, and YouTube Shorts"
    : platform;

  const userPrompt = [
    `Generate ${batchSize} short-form video script(s) for ${platformLine}.`,
    `Each script should be approximately ${durationSeconds} seconds long.`,
    topic ? `Topic: ${topic}` : "",
    hook ? `Use this hook concept as inspiration: ${hook}` : "Craft original pattern-interrupt hooks for each script.",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      scripts: [
        {
          platform: "TikTok | Instagram Reels | YouTube Shorts",
          durationSeconds: 0,
          hook: "Opening hook text (first 2 seconds)",
          scenes: [
            {
              startSecond: 0,
              endSecond: 0,
              script: "Spoken words for this scene",
              onScreenText: "Text that appears on screen (reinforces, not repeats)",
              brollNote: "Suggested B-roll or visual note",
              pacing: "fast | medium | slow",
            },
          ],
          caption: "Platform caption copy",
          hashtags: ["hashtag1", "hashtag2"],
          callToAction: "CTA text",
        },
      ],
    }),
  ].filter(Boolean).join("\n");

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

  // claude-sonnet-5-20251015 pricing: $3/M input, $15/M output
  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return { output, costUsd };
};

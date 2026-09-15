import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { num, resolveInputs, str } from "@/lib/agents/inputs";
import { applyRenamedInputs } from "./renamed-inputs";
import { resolveAnthropic } from "@/lib/ai/client";

export const shortFormHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);

  const config = resolveInputs(run);
  // Renamed to the Run form's keys on 2026-09-14; the old names still work from a saved config.
  applyRenamedInputs(run, config, {
    targetPlatforms: { from: "platform", map: (v: unknown) => (v === "All" ? "All (Reels + TikTok + Shorts)" : v) },
    maxClips: "batchSize",
    topicPriorities: "topic",
    hookStyle: "hook",
  });
  const platform = str(config, "targetPlatforms", "All (Reels + TikTok + Shorts)");
  const minClipDuration = num(config, "minClipDuration", 30, { min: 5, max: 180 });
  const maxClipDuration = Math.max(minClipDuration, num(config, "maxClipDuration", 90, { min: 5, max: 180 }));
  const hookStyle = str(config, "hookStyle", "Bold statement");
  const topicPriorities = str(config, "topicPriorities");
  const batchSize = num(config, "maxClips", 5, { min: 1, max: 10 });
  const sourceVideoUrl = str(config, "sourceVideoUrl");
  const rawTranscript = str(config, "rawTranscript");

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

  const platformsByOption: Record<string, string> = {
    "All (Reels + TikTok + Shorts)": "TikTok, Instagram Reels, and YouTube Shorts",
    "Reels only": "Instagram Reels",
    "TikTok only": "TikTok",
    "YouTube Shorts only": "YouTube Shorts",
    "Reels + TikTok": "Instagram Reels and TikTok",
  };
  const platformLine = platformsByOption[platform] ?? platform;
  const hasTranscript = rawTranscript.length > 0;

  const userPrompt = [
    hasTranscript
      ? `From the long-form transcript below, select up to ${batchSize} clip window(s) with the highest short-form potential (emotional intensity, quotability, standalone coherence) and write one script per clip for each of ${platformLine}.`
      : `Generate ${batchSize} short-form video concept(s), with one script per concept for each of ${platformLine}.`,
    `Every clip must run between ${minClipDuration} and ${maxClipDuration} seconds; exclude any moment that can't stand alone within that range.`,
    topicPriorities ? `Topic priorities — favour moments and angles on these themes: ${topicPriorities}` : "",
    `Hook style for every script's opening: ${hookStyle}`,
    sourceVideoUrl ? `Source video URL (for reference only — this agent cannot fetch or transcribe it): ${sourceVideoUrl}` : "",
    hasTranscript
      ? `\nTranscript:\n${rawTranscript}`
      : "No transcript was provided, so there are no real clip windows to select: write original scripts from the topic priorities and client context, and set sourceStartTimestamp and sourceEndTimestamp to null.",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      scripts: [
        {
          platform: "TikTok | Instagram Reels | YouTube Shorts",
          sourceStartTimestamp: "00:12:04 or null",
          sourceEndTimestamp: "00:13:02 or null",
          selectionRationale: "Why this window scores highly, or null",
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
    model: MODELS.standard,
    // One script per clip per platform — the form defaults (5 clips × 3 platforms) outgrow 8096.
    max_tokens: 16000,
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

  output.source = hasTranscript ? "transcript" : "simulation";
  if (!hasTranscript) {
    output.simulationNote = "No transcript was pasted, so these are original scripts rather than clips cut from your recording. Paste the Raw Transcript to select real clip windows.";
  }
  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }
  // Priced from lib/ai/models.ts — Sonnet 5 is $2/M input, $10/M output.
  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  return { output, costUsd };
};

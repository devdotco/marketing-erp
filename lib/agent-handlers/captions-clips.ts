import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { bool, lines, num, resolveInputs, str } from "@/lib/agents/inputs";
import { applyRenamedInputs } from "./renamed-inputs";
import { resolveAnthropic } from "@/lib/ai/client";

// The handler's old free-text platform names, mapped onto the form's Target Platforms options.
const OLD_PLATFORM_NAMES: Record<string, string> = {
  Reels: "TikTok / Reels (9:16)",
  TikTok: "TikTok / Reels (9:16)",
  Shorts: "YouTube Shorts (9:16)",
  LinkedIn: "LinkedIn (1:1)",
  YouTube: "YouTube (16:9)",
  All: "All Platforms",
};

export const captionsClipsHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);

  const config = resolveInputs(run);
  // Renamed to the Run form's keys on 2026-09-14; the old names still work from a saved config.
  applyRenamedInputs(run, config, {
    mediaFileUrl: "videoUrl",
    targetPlatforms: {
      from: "targetPlatform",
      map: (v: unknown) => OLD_PLATFORM_NAMES[String(v)] ?? v,
    },
    clipsPerHour: "clipCount",
  });

  const mediaFileUrl = str(config, "mediaFileUrl");
  const clipsPerHour = num(config, "clipsPerHour", 4, { min: 1, max: 20 });
  const minClipSeconds = num(config, "minimumClipLengthSeconds", 30, { min: 5, max: 600 });
  const maxClipSeconds = Math.max(minClipSeconds, num(config, "maximumClipLengthSeconds", 90, { min: 5, max: 600 }));
  const captionStyle = str(config, "captionStyle", "Bold White + Black Outline");
  const targetPlatform = str(config, "targetPlatforms", "All Platforms");
  // The form collects speaker names; an older saved config stored a plain on/off flag.
  const speakerNames = typeof config.speakerLabels === "string" ? lines(config, "speakerLabels") : [];
  const speakerLabels = config.speakerLabels !== false;
  const videoTranscript = str(config, "videoTranscript");
  const transcriptOnly = bool(config, "transcriptOnly", false);

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business: ${businessProfile.businessName}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.brandVoice ? `Brand voice: ${businessProfile.brandVoice}` : "",
        businessProfile.targetAudience ? `Target audience: ${businessProfile.targetAudience}` : "",
      ].filter(Boolean).join("\n")
    : "";

  const systemPrompt = [
    "You are a video editor specialising in short-form clip selection.",
    "Identify moments with natural narrative peaks, surprising statements, or strong emotional beats.",
    "Clips should work without context from the full video — each must be self-contained.",
    "Captions should be punchy, readable, and timed to the spoken rhythm.",
    "Return ONLY valid JSON — no markdown fences, no preamble.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ].filter(Boolean).join("\n");

  const hasTranscript = videoTranscript.trim().length > 0;

  const userPrompt = [
    `Analyse the following and suggest short-form clips optimised for ${targetPlatform}: about ${clipsPerHour} clip(s) per hour of source content (at least 1), keeping only the highest-scoring candidates.`,
    mediaFileUrl ? `Source media URL (for reference only — this agent cannot download or transcribe it): ${mediaFileUrl}` : "",
    hasTranscript
      ? `Transcript:\n${videoTranscript}`
      : "No transcript provided — generate example clips based on the business context above.",
    transcriptOnly ? "" : `Caption style: ${captionStyle}`,
    speakerNames.length > 0
      ? `Speakers, in the order they first speak: ${speakerNames.join(", ")}. Use these names as speaker labels.`
      : speakerLabels ? "Include speaker labels in the transcript where identifiable." : "No speaker labels needed.",
    "",
    "For each clip:",
    "- Pick the most engaging, self-contained moment",
    "- Identify the exact hook moment within the clip",
    transcriptOnly
      ? "- Transcript and timestamps only: leave caption empty and hashtags as an empty array"
      : "- Suggest platform-native captions and hashtags",
    `- Keep every clip between ${minClipSeconds} and ${maxClipSeconds} seconds; discard candidates outside that range`,
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      transcript: [
        {
          startTime: "00:00:00",
          endTime: "00:00:05",
          speaker: speakerLabels ? "Speaker Name or null" : null,
          text: "Transcribed text segment...",
        },
      ],
      suggestedClips: [
        {
          clipNumber: 1,
          startTimestamp: "00:01:23",
          endTimestamp: "00:01:53",
          durationSeconds: 30,
          reason: "Why this moment works as a standalone clip...",
          hookMoment: "The exact sentence or moment that serves as the hook...",
          caption: transcriptOnly ? "" : "Short punchy caption text for the clip...",
          platform: targetPlatform,
          hashtags: transcriptOnly ? [] : ["#hashtag1", "#hashtag2", "#hashtag3"],
        },
      ],
      captionStyle: transcriptOnly ? null : captionStyle,
      simulationNote:
        "Paste a transcript to select clips from real footage — this agent does not download, transcribe, or render media.",
    }),
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
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { clips: rawText };
  } catch {
    output = { clips: rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;
  // Priced from lib/ai/models.ts — Haiku 4.5 is $1/M input, $5/M output.
  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};

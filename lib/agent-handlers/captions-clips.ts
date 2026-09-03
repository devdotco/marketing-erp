import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const captionsClipsHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const videoUrl = String(config.videoUrl ?? "");
  const clipCount = Number(config.clipCount ?? 5);
  const captionStyle = String(config.captionStyle ?? "Auto");
  const targetPlatform = String(config.targetPlatform ?? "Reels");
  const speakerLabels = config.speakerLabels !== false;
  const videoTranscript = String(config.videoTranscript ?? "");

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
    `Analyse the following and suggest ${clipCount} short-form clips optimised for ${targetPlatform}.`,
    videoUrl ? `Video URL: ${videoUrl}` : "",
    hasTranscript
      ? `Transcript:\n${videoTranscript}`
      : "No transcript provided — generate example clips based on the business context above.",
    `Caption style: ${captionStyle}`,
    speakerLabels ? "Include speaker labels in the transcript where identifiable." : "No speaker labels needed.",
    "",
    "For each clip:",
    "- Pick the most engaging, self-contained moment",
    "- Identify the exact hook moment within the clip",
    "- Suggest platform-native captions and hashtags",
    `- Keep clips between 15–90 seconds for ${targetPlatform}`,
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
          caption: "Short punchy caption text for the clip...",
          platform: targetPlatform,
          hashtags: ["#hashtag1", "#hashtag2", "#hashtag3"],
        },
      ],
      captionStyle,
      simulationNote:
        "Provide a video transcript or connect a video processing integration to generate clips from real footage",
    }),
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
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { clips: rawText };
  } catch {
    output = { clips: rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  // Haiku 4.5 pricing: $0.80/M input, $4/M output
  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};

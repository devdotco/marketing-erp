import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const videoScriptHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const videoTopic = String(config.videoTopic ?? "");
  const durationMinutes = Number(config.durationMinutes ?? 10);
  const videoStyle = String(config.videoStyle ?? "Educational");
  const targetPlatform = String(config.targetPlatform ?? "YouTube");
  const audienceLevel = String(config.audienceLevel ?? "Beginner");

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business: ${businessProfile.businessName}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.brandVoice ? `Brand voice: ${businessProfile.brandVoice}` : "",
        businessProfile.targetAudience ? `Target audience: ${businessProfile.targetAudience}` : "",
        businessProfile.uniqueValueProp ? `Unique value proposition: ${businessProfile.uniqueValueProp}` : "",
        businessProfile.websiteUrl ? `Website: ${businessProfile.websiteUrl}` : "",
      ].filter(Boolean).join("\n")
    : "";

  const systemPrompt = [
    "You are a professional video script writer specialising in educational and branded content.",
    "Cold opens hook viewers in the first 15 seconds — use a surprising fact, provocative question, or bold claim.",
    "Scripts use conversational language that sounds natural when spoken, not read.",
    "Write for the ear, not the eye: short sentences, active voice, no jargon without explanation.",
    "Return ONLY valid JSON — no markdown fences, no preamble.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ].filter(Boolean).join("\n");

  const sceneCount = Math.max(4, Math.round(durationMinutes * 1.5));

  const userPrompt = [
    `Write a complete ${durationMinutes}-minute video script.`,
    videoTopic ? `Topic: ${videoTopic}` : "",
    `Style: ${videoStyle}`,
    `Target platform: ${targetPlatform}`,
    `Audience level: ${audienceLevel}`,
    "",
    "Requirements:",
    "- Cold open must hook viewers within the first 15 seconds",
    "- Divide the video into logical chapters",
    `- Write approximately ${sceneCount} scenes spread across the chapters`,
    "- Each scene should include full spoken script, b-roll notes, on-screen text, and camera direction",
    "- Include a strong CTA at the end",
    "- Suggest 3 thumbnail concepts",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      videoTitle: "Compelling video title",
      videoDescription: "YouTube/platform description (150-300 words with keywords)",
      totalDurationMinutes: durationMinutes,
      targetPlatform,
      chapters: [
        { chapterNumber: 1, title: "Chapter title", startMinute: 0, durationMinutes: 2 },
      ],
      scenes: [
        {
          sceneNumber: 1,
          chapter: "Chapter title",
          durationSeconds: 30,
          script: "Full word-for-word spoken script for this scene...",
          brollNotes: "Visual footage or animation to show while narrator speaks...",
          onScreenText: "Text overlay or lower-third caption...",
          cameraNotes: "Camera angle, movement, or framing direction...",
          pacing: "medium",
        },
      ],
      coldOpen: "Full word-for-word cold open script (first 15 seconds)...",
      ctaScript: "Full word-for-word call-to-action script...",
      thumbnailIdeas: [
        "Thumbnail concept 1: description of text, imagery, and layout",
        "Thumbnail concept 2: description of text, imagery, and layout",
        "Thumbnail concept 3: description of text, imagery, and layout",
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
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { script: rawText };
  } catch {
    output = { script: rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  // Sonnet 5 pricing: $3/M input, $15/M output
  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};

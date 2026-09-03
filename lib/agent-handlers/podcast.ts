import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const podcastHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const episodeLength = Number(config.episodeLength ?? 15);
  const episodeTopic = String(config.episodeTopic ?? "");
  const audienceLevel = String(config.audienceLevel ?? "intermediate");
  const hostStyle = String(config.hostStyle ?? "Solo host");
  const voiceId = String(config.voiceId ?? "sonic-2");
  const showName = String(config.showName ?? "");

  // Fetch business profile for show context
  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const showContext = showName || businessProfile?.businessName
    ? `Podcast / show name: ${showName || businessProfile?.businessName}`
    : "";
  const industryContext = businessProfile?.industry
    ? `Industry: ${businessProfile.industry}`
    : "";

  const systemPrompt = [
    "You are an expert podcast script writer.",
    "You write engaging, conversational scripts that sound natural when read aloud.",
    "Scripts use short sentences, natural pauses (marked with [PAUSE]), and clear verbal transitions.",
    "Always open with a hook in the first 30 seconds. Never start with 'Welcome to...' as the very first words.",
    "Return ONLY valid JSON — no markdown fences, no preamble.",
    showContext,
    industryContext,
  ].filter(Boolean).join("\n");

  const userPrompt = [
    `Write a ${episodeLength}-minute podcast episode script.`,
    episodeTopic ? `Topic: ${episodeTopic}` : "Choose a relevant topic for the industry.",
    `Audience knowledge level: ${audienceLevel}`,
    `Format: ${hostStyle}`,
    "",
    "Script structure:",
    "1. Cold open hook (30-60 sec) — a surprising fact, bold claim, or short story",
    "2. Brief intro / episode preview (30 sec)",
    "3. Main content: 3 segments with clear transitions",
    "4. Recap (60 sec)",
    "5. Call-to-action close (30 sec)",
    "",
    "Mark speaker cues, pauses, and emphasis: [PAUSE], [EMPHASIS], [TRANSITION]",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      episodeTitle: "Podcast episode title",
      episodeDescription: "2-3 sentence show notes description for Transistor/podcast directories",
      estimatedMinutes: episodeLength,
      hostStyle,
      segments: [
        { name: "Cold Open", durationMinutes: 1, script: "Full word-for-word script..." },
        { name: "Segment 1: ...", durationMinutes: 5, script: "..." },
        { name: "Segment 2: ...", durationMinutes: 5, script: "..." },
        { name: "Segment 3: ...", durationMinutes: 5, script: "..." },
        { name: "Close & CTA", durationMinutes: 1, script: "..." },
      ],
      fullScript: "Complete concatenated script for TTS...",
      showNotes: "Markdown show notes with timestamps...",
      tags: ["tag1", "tag2"],
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
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { script: rawText };
  } catch {
    output = { script: rawText };
  }

  output.voiceId = voiceId;
  output.ttsStatus = "pending";
  output.ttsNote = "Script approved — submit to Cartesia TTS to generate audio. Audio will be uploaded to Transistor for review before publishing.";
  output.generatedAt = new Date().toISOString();

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

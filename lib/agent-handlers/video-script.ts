import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { num, resolveInputs, str } from "@/lib/agents/inputs";
import { applyRenamedInputs } from "./renamed-inputs";
import { resolveAnthropic } from "@/lib/ai/client";

export const videoScriptHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);

  const config = resolveInputs(run);
  // Renamed to the Run form's keys on 2026-09-14; the old names still work from a saved config.
  applyRenamedInputs(run, config, {
    desiredLengthMinutes: "durationMinutes",
    toneOfVoice: "videoStyle",
    targetAudienceDescription: "audienceLevel",
  });
  const videoTopic = String(config.videoTopic ?? "");
  const durationMinutes = num(config, "desiredLengthMinutes", 5, { min: 0.25, max: 60 });
  const toneOfVoice = str(config, "toneOfVoice", "Conversational");
  const targetPlatform = String(config.targetPlatform ?? "YouTube");
  const targetAudience = str(config, "targetAudienceDescription");
  const videoGoal = str(config, "videoGoal");
  const keyMessages = str(config, "keyMessages");
  const callToAction = str(config, "callToAction");

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
    `Tone of voice: ${toneOfVoice} (overrides the brand voice above where they differ)`,
    `Target platform: ${targetPlatform}`,
    targetAudience ? `Target audience: ${targetAudience} — match their vocabulary, depth and awareness level.` : "",
    videoGoal ? `Video goal: ${videoGoal} — shape the narrative arc, proof placement and CTA around it.` : "",
    keyMessages ? `Key messages that must appear in the script, stated as given (never invent figures beyond these):\n${keyMessages}` : "",
    "",
    "Requirements:",
    "- Cold open must hook viewers within the first 15 seconds",
    "- Divide the video into logical chapters",
    `- Write approximately ${sceneCount} scenes spread across the chapters`,
    "- Each scene should include full spoken script, b-roll notes, on-screen text, and camera direction",
    callToAction
      ? `- End with this call to action, and place it mid-roll too if the length allows: ${callToAction}`
      : "- Include a strong CTA at the end",
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
    model: MODELS.standard,
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = textFrom(message);
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { script: rawText };
  } catch {
    output = { script: rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;
  // Priced from lib/ai/models.ts — Sonnet 5 is $2/M input, $10/M output.
  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};

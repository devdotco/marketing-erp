import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { num, resolveInputs, str } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";

export const youtubeHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  // The handler used to invent placeholder optimisation for N videos on a channel from
  // fields the form never collected (channelUrl, videoCount, commentSweepDays — none has a
  // YouTube integration behind it). It now builds the one-video metadata package the Run
  // form describes, from the transcript the person pastes.
  const videoTranscript = str(config, "videoTranscript");
  const videoUrl = str(config, "videoUrl");
  const primaryKeyword = str(config, "primaryKeyword");
  const contentCategory = str(config, "contentCategory", "Tutorial / How-to");
  const targetAudience = str(config, "targetAudience");
  const titleVariants = num(config, "titleVariants", 3, { min: 1, max: 10 });
  const metaStyle = str(config, "metaStyle", "Balanced");

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const systemPrompt = `You are a YouTube SEO specialist. Write descriptions that front-load keywords in the first 2 lines (for above-fold display). Chapters should aid watch time by grouping content clearly, and every chapter timestamp must come from the transcript — never invent one. The pinned comment should sound like a knowledgeable team member, not a PR firm. Respond ONLY with valid JSON — no markdown, no code fences.`;

  const userPrompt = `Generate a complete YouTube metadata package for one video from ${businessProfile?.businessName ?? "the client"}.

Business context:
- Industry: ${businessProfile?.industry ?? "General"}
- Value proposition: ${businessProfile?.uniqueValueProp ?? "Not specified"}
- Target audience: ${targetAudience || businessProfile?.targetAudience || "Not specified"}

Video:
- URL: ${videoUrl || "Not uploaded yet"}
- Primary keyword: ${primaryKeyword || "Infer the strongest keyword from the transcript"}
- Content category: ${contentCategory} (shapes the title formats, description structure and chapter style)

Configuration:
- Meta style: ${metaStyle} (SEO-first = keyword-dense, Click-first = curiosity/hook, Balanced = both)
- Title variants: ${titleVariants}

Rules:
- The primary keyword appears in every title variant and within the first 100 characters of the description.
- Description is about 250 words, with the chapter block included.
- Up to 30 tags, ordered from most to least specific.
- If the transcript has no timestamps, return an empty chapters array and say so in chaptersNote.

Transcript or script:
${videoTranscript || "No transcript was provided — base the package on the business context and primary keyword, and return no chapters."}

Return exactly this JSON structure:
{
  "titleOptions": ["exactly ${titleVariants} title(s), mixing question, list and bold-statement formats"],
  "description": "Full YouTube description with keywords in the first 2 lines, then chapters, then links and CTA",
  "chapters": [
    {"timestamp": "0:00", "title": "Chapter title"}
  ],
  "chaptersNote": "Only when chapters is empty: why",
  "tags": ["tag1", "tag2"],
  "pinnedComment": "First-comment template with an engagement prompt and CTA",
  "thumbnailTextSuggestions": ["Text option 1", "Text option 2", "Text option 3"]
}`;

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
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { result: rawText };
  } catch {
    output = { result: rawText };
  }

  output.deliveryNote = "Copy-paste package — this agent does not write to YouTube; there is no YouTube Data API integration yet.";
  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

  return { output, costUsd };
};

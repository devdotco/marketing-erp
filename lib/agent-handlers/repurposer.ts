import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const repurposerHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const sourceUrl = typeof config.sourceUrl === "string" ? config.sourceUrl : "";
  const sourceContent = typeof config.sourceContent === "string" ? config.sourceContent : "";
  const targetFormats = typeof config.targetFormats === "string" ? config.targetFormats : "All";
  const platformPriority = typeof config.platformPriority === "string" ? config.platformPriority : "All";
  const toneOverride = typeof config.toneOverride === "string" ? config.toneOverride : "";

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandVoiceStr =
    businessProfile?.brandVoice != null
      ? String(businessProfile.brandVoice)
      : "";

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business: ${businessProfile.businessName}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        brandVoiceStr ? `Brand voice: ${brandVoiceStr}` : "",
        businessProfile.targetAudience ? `Target audience: ${businessProfile.targetAudience}` : "",
        businessProfile.uniqueValueProp ? `Unique value proposition: ${businessProfile.uniqueValueProp}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const effectiveTone =
    toneOverride.trim()
      ? toneOverride.trim()
      : brandVoiceStr || "professional and engaging";

  const systemPrompt = [
    "You are an expert content repurposing specialist who adapts brand voice and tone for each platform's unique format, length constraints, and audience expectations.",
    "You understand that X/Twitter demands punchy hooks under 280 characters, carousels need scannable visual-first slides, video scripts require verbal rhythm and scene transitions, and newsletters need editorial depth.",
    "You preserve the source content's core insights while making each format feel native to its platform — never just copy-pasted from the original.",
    "Return ONLY valid JSON — no markdown fences, no preamble, no trailing commentary.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const sourceDescription = [
    sourceUrl ? `Source URL: ${sourceUrl}` : "",
    sourceContent ? `Source content:\n${sourceContent}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const formatInstructions =
    targetFormats === "All"
      ? "Generate all four formats: X Thread, Carousel Outline, Video Script, and Newsletter Section."
      : `Generate only the following format: ${targetFormats}.`;

  const platformNote =
    platformPriority !== "All"
      ? `Primary platform priority: ${platformPriority}. Optimise tone, hashtags, and CTAs for this platform's culture first.`
      : "Optimise each format for its native platform.";

  const userPrompt = [
    "Repurpose the following published content into platform-native formats.",
    "",
    sourceDescription,
    "",
    formatInstructions,
    platformNote,
    `Tone: ${effectiveTone}`,
    "",
    "X Thread rules: each post ≤ 280 chars, first post is the hook, last post has a CTA.",
    "Carousel rules: 6–10 slides, slide 1 = hook, slide 2–N = value points, final slide = CTA.",
    "Video Script rules: 60–90 second short-form script, include b-roll notes, write as spoken word.",
    "Newsletter Section rules: written for email, include a compelling subject line and preview text.",
    "",
    "Return this exact JSON structure (use empty arrays/strings for formats not requested):",
    JSON.stringify({
      sourceTitle: "Extracted or inferred title of the source content",
      xThread: {
        hook: "The opening post that stops the scroll",
        posts: [
          {
            text: "Post text (≤280 chars)",
            charCount: 0,
          },
        ],
        totalPosts: 0,
      },
      carouselOutline: {
        slides: [
          {
            slideNumber: 1,
            headline: "Slide headline",
            bulletPoints: ["Point 1", "Point 2"],
            visualNote: "What to show visually on this slide",
          },
        ],
      },
      videoScript: {
        hook: "Opening line spoken on camera",
        totalSeconds: 0,
        scenes: [
          {
            seconds: 0,
            script: "Spoken words for this scene",
            broll: "B-roll or visual suggestion",
          },
        ],
      },
      newsletterSection: {
        subjectLine: "Email subject line",
        previewText: "Preview text shown in inbox (90 chars max)",
        body: "Full email body text in HTML",
        cta: "Call to action text and link placeholder",
      },
    }),
  ]
    .filter(Boolean)
    .join("\n");

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

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return { output, costUsd };
};

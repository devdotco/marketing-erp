import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { num, resolveInputs, str } from "@/lib/agents/inputs";
import { applyRenamedInputs } from "./renamed-inputs";
import { resolveAnthropic } from "@/lib/ai/client";

export const repurposerHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  // Renamed to the Run form's keys on 2026-09-14; the old names still work from a saved config.
  applyRenamedInputs(run, config, {
    sourceArticleUrl: "sourceUrl",
    sourceArticleText: "sourceContent",
    targetPlatforms: { from: "targetFormats", map: (v: unknown) => (v === "All" ? "All platforms" : v === "X Thread" ? "X only" : v) },
  });

  const sourceUrl = str(config, "sourceArticleUrl");
  const sourceContent = str(config, "sourceArticleText");
  const targetPlatforms = str(config, "targetPlatforms", "All platforms");
  const toneOverride = str(config, "toneOverride", "Use Brand Profile default");
  const linkedInAuthorName = str(config, "linkedInAuthorName");
  const videoHookDurationSeconds = num(config, "videoHookDurationSeconds", 30, { min: 5, max: 180 });
  const brandHashtags = str(config, "brandHashtags");

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
    toneOverride && toneOverride !== "Use Brand Profile default"
      ? toneOverride
      : brandVoiceStr || "professional and engaging";

  const systemPrompt = [
    "You are an expert content repurposing specialist who adapts brand voice and tone for each platform's unique format, length constraints, and audience expectations.",
    "You understand that X/Twitter demands punchy hooks under 280 characters, carousels need scannable visual-first slides, video scripts require verbal rhythm and scene transitions, and LinkedIn articles need a professional narrative with real depth.",
    "You preserve the source content's core insights while making each format feel native to its platform — never just copy-pasted from the original.",
    "Return ONLY valid JSON — no markdown fences, no preamble, no trailing commentary.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const sourceDescription = [
    sourceUrl
      ? `Source URL: ${sourceUrl}${sourceContent ? "" : " (you have the URL only, not the article — do not invent what it says; work from the title the URL implies and say so in sourceTitle)"}`
      : "",
    sourceContent ? `Source content:\n${sourceContent}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const formatsByPlatform: Record<string, string> = {
    "All platforms": "all four formats: LinkedIn Article, X Thread, Carousel Outline (Instagram), and Video Script",
    "LinkedIn only": "only the LinkedIn Article",
    "X only": "only the X Thread",
    "Instagram + Video only": "only the Carousel Outline (Instagram) and the Video Script",
  };
  const formatInstructions = `Generate ${formatsByPlatform[targetPlatforms] ?? formatsByPlatform["All platforms"]}.`;

  const platformNote = "Optimise each format for its native platform.";

  const userPrompt = [
    "Repurpose the following published content into platform-native formats.",
    "",
    sourceDescription,
    "",
    formatInstructions,
    platformNote,
    `Tone: ${effectiveTone}`,
    brandHashtags
      ? `Brand hashtags — include these on every social format, and add contextual tags alongside them: ${brandHashtags}`
      : "",
    "",
    `LinkedIn Article rules: professional narrative structure with a strong opening and subheadings, written in the first person${linkedInAuthorName ? ` as ${linkedInAuthorName}` : ""}.`,
    "X Thread rules: each post ≤ 280 chars, first post is the hook, last post has a CTA.",
    "Carousel rules: 6–10 slides, slide 1 = hook, slide 2–N = value points, final slide = CTA.",
    `Video Script rules: a ${videoHookDurationSeconds}-second short-form hook script (totalSeconds must be ${videoHookDurationSeconds}), include b-roll notes, write as spoken word.`,
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
      linkedInArticle: {
        authorName: linkedInAuthorName || null,
        headline: "Article headline",
        body: "Full article body in Markdown",
        hashtags: ["#tag"],
      },
    }),
  ]
    .filter(Boolean)
    .join("\n");

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

  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  return { output, costUsd };
};

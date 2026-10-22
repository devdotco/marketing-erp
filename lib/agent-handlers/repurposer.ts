import type { AgentHandler } from "./index";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { jsonFrom, textFrom } from "@/lib/ai/extract";
import { num, resolveInputs, str } from "@/lib/agents/inputs";
import { applyRenamedInputs } from "./renamed-inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { completeMessage } from "@/lib/ai/messages";
import { addReview } from "@/lib/agents/integrity";
import { repurposeWarnings, wordBudget } from "@/lib/agents/repurpose-check";

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
  // Where the carousel will be posted decides its CTA ("link in bio" is an Instagram convention).
  const carouselPlatform = str(config, "carouselPlatform", "Instagram");

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
    "Use ONLY facts, figures, names, dates and quotes that appear in the source text. Add nothing from your own knowledge: no extra statistics, market sizes, funding rounds, studies or quotes, even if you believe they are true.",
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
    `Source rules: use only facts, figures, names and quotes that appear in the source text above. Add nothing from your own knowledge.${sourceContent ? "" : " Only a URL was given, no text, so write NO specific figures, percentages, prices, names or quotes at all."}`,
    "Consistency rules: state each figure identically in every format, with its time horizon (\"$17 billion by 2035\", never \"$17 billion\"). Copy numbers exactly as the source writes them; do not round or re-express them. Keep the source's hedging: if it says \"weak on ARIA labels\", do not write \"frequently missing\". Do not restate a price differently from one format to another.",
    `Voice rules: the X thread, carousel and video speak as the company (${businessProfile?.businessName ? `"we", ${businessProfile.businessName}` : '"we"'}); never \"I\". ${
      linkedInAuthorName
        ? `The LinkedIn article alone is written in the first person as ${linkedInAuthorName}.`
        : "The LinkedIn article is also in the company voice (\"we\"), since no author name was given."
    }`,
    `URL rule: when you link to the source, use exactly ${sourceUrl ? `"${sourceUrl}"` : "the source URL if one was given, otherwise omit links"} — character for character, never reconstructed or shortened. Do not invent any other URL.`,
    `LinkedIn Article rules: professional narrative structure with a strong opening and subheadings, 600-900 words.`,
    `X Thread rules: each post ≤ 280 chars (a URL counts as 23), first post is the hook, the last post is the CTA and ends with the full source URL${sourceUrl ? ` (${sourceUrl})` : ""}. Leave charCount at 0; it is computed for you.`,
    `Carousel rules (for ${carouselPlatform}): 6–10 slides, slide 1 = hook, slide 2–N = value points, final slide = CTA. ${
      carouselPlatform === "Instagram"
        ? 'The final slide ends with "link in bio" (Instagram captions cannot hold clickable links), and its visualNote must not ask for a URL to be shown.'
        : `Do NOT say "link in bio". The final slide shows the full source URL${sourceUrl ? ` (${sourceUrl})` : ""} and its visualNote says so.`
    }`,
    `Video Script rules: a ${videoHookDurationSeconds}-second short-form hook script (totalSeconds must be ${videoHookDurationSeconds}), include b-roll notes, write as spoken word. Pacing: speech runs at 150 words per minute, 2.5 words per second, so a scene lasting D seconds has at most D x 2.5 words (4s = ${wordBudget(4)}, 6s = ${wordBudget(6)}, 8s = ${wordBudget(8)}); the whole script has at most ${wordBudget(videoHookDurationSeconds)} spoken words. Each scene's "seconds" is its START time. The scenes tile exactly: the first starts at 0, each next scene starts when the previous one ends, and the last runs to ${videoHookDurationSeconds}. The last scene is a closing spoken CTA that starts no earlier than ${Math.max(0, videoHookDurationSeconds - 8)}s and tells viewers where to read more.`,
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

  const message = await completeMessage(client, {
    model: MODELS.standard,
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = textFrom(message);
  const output: Record<string, unknown> = jsonFrom(rawText) ?? { result: rawText };

  // The model writes the character counts and gets them wrong, so they are computed here, and the
  // figures, URLs and video pacing are checked against the source so the reviewer sees what to verify.
  if (!("result" in output)) {
    addReview(output, {
      warnings: repurposeWarnings(output, { sourceUrl, sourceText: sourceContent, videoSeconds: videoHookDurationSeconds }),
    });
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

import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { lines, num, resolveInputs, str } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";

export const placementHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);

  const config = resolveInputs(run);
  const targetTopics = String(config.targetTopics ?? "");
  const campaignName = str(config, "campaignName", "Placement campaign");
  const targetPlacements = num(config, "targetPlacements", 10, { min: 1 });
  // One run drafts a batch, not the whole campaign: three full articles is what
  // an 8k-token reply holds. The campaign target is carried through for tracking.
  const articlesThisRun = Math.min(targetPlacements, 3);
  const targetPages = lines(config, "targetPages", 20);
  const anchorTexts = lines(config, "defaultAnchorText", 20);
  const wordCount = num(config, "articleLengthTarget", 1200, { min: 300, max: 3000 });
  const requireGuidelineCheck = config.requireGuidelineCheck !== false;
  const budgetUsd = Number(config.budgetUsd ?? 300);
  const targetDa = Number(config.targetDa ?? 40);
  const preferredPublishers = String(config.preferredPublishers ?? "");
  const articleStyle = String(config.articleStyle ?? "Informational");

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business: ${businessProfile.businessName}` : "",
        businessProfile.websiteUrl ? `Website: ${businessProfile.websiteUrl}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.brandVoice ? `Brand voice: ${businessProfile.brandVoice}` : "",
        businessProfile.targetAudience ? `Target audience: ${businessProfile.targetAudience}` : "",
        businessProfile.uniqueValueProp ? `Unique value proposition: ${businessProfile.uniqueValueProp}` : "",
        businessProfile.goals ? `Business goals: ${JSON.stringify(businessProfile.goals)}` : "",
      ].filter(Boolean).join("\n")
    : "";

  const systemPrompt = [
    "You are a content writer specialising in editorial placements for link acquisition.",
    "Articles must read as genuine editorial content — not advertorials. Publishers reject anything that feels promotional.",
    "The link placement must be contextually natural and add value to the reader, not just exist to pass link equity.",
    "Write to the target publication's audience and style — not your client's style guide.",
    "Return ONLY valid JSON — no markdown fences, no preamble.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ].filter(Boolean).join("\n");

  const userPrompt = [
    `Write editorial placement articles for the campaign "${campaignName}" (campaign target: ${targetPlacements} live placements; this batch: ${articlesThisRun}).`,
    targetTopics ? `Topics to cover: ${targetTopics}` : "",
    targetPages.length > 0
      ? `Destination URLs — every linkPlacements.targetUrl must be one of these, exactly as written:\n${targetPages.join("\n")}`
      : "",
    anchorTexts.length > 0
      ? `Preferred anchor text variations (use these where they read naturally; vary them across articles): ${anchorTexts.join(" | ")}`
      : "",
    `Article style: ${articleStyle}`,
    `Target word count per article: ${wordCount} words`,
    `Target Domain Authority: ${targetDa}+`,
    `Budget per article: $${budgetUsd}`,
    preferredPublishers ? `Preferred publishers / niches: ${preferredPublishers}` : "",
    "",
    `Write ${articlesThisRun} complete article${articlesThisRun === 1 ? "" : "s"}, each targeting a different realistic publication in the relevant niche.`,
    "Each article must include a full content field — not just an outline. Link placements must feel natural to a reader, not forced.",
    "The submissionNote for each article should mention specific editorial guidelines or what the publisher typically accepts.",
    requireGuidelineCheck
      ? "Before finalising each article, check it against that publication's typical contributor guidelines (length, link policy, promotional tone, formatting) and record the result in guidelineCheck. Fix anything non-compliant in the article itself rather than only noting it."
      : "Set guidelineCheck to null.",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      articles: [
        {
          targetPublication: "Publication name",
          targetDa: targetDa,
          articleTitle: "Article title",
          slug: "url-friendly-slug",
          outline: [
            {
              heading: "Section heading",
              wordCount: 0,
              keyPoints: ["Key point covered in this section"],
            },
          ],
          fullContent: "<h2>...</h2><p>Full article HTML content...</p>",
          authorBio: "Short author bio for submission",
          linkPlacements: [
            {
              anchorText: "natural anchor text",
              targetUrl: "https://target-url.com/page",
              contextSentence: "The full sentence containing the anchor text as it appears in the article",
            },
          ],
          submissionNote: "Notes on how to submit and what to expect from this publisher",
          guidelineCheck: requireGuidelineCheck
            ? { compliant: true, checkedAgainst: ["Guideline checked"], fixesApplied: ["Change made to comply"] }
            : null,
          estimatedCost: budgetUsd,
        },
      ],
      campaignName,
      targetPlacements,
      totalArticles: 0,
      simulationNote:
        "These articles are ready to submit to publishers in our vetted marketplace (1,100+ publishers at members-only rates).",
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
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { rawText };
  } catch {
    output = { rawText };
  }

  output.campaignName = campaignName;
  output.targetPlacements = targetPlacements;
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

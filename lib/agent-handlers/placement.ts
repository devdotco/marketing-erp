import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const placementHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const targetTopics = String(config.targetTopics ?? "");
  const wordCount = Number(config.wordCount ?? 800);
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
    `Write editorial placement articles for the following campaign.`,
    targetTopics ? `Topics to cover: ${targetTopics}` : "",
    `Article style: ${articleStyle}`,
    `Target word count per article: ${wordCount} words`,
    `Target Domain Authority: ${targetDa}+`,
    `Budget per article: $${budgetUsd}`,
    preferredPublishers ? `Preferred publishers / niches: ${preferredPublishers}` : "",
    "",
    "Write at least 3 complete articles, each targeting a different realistic publication in the relevant niche.",
    "Each article must include a full content field — not just an outline. Link placements must feel natural to a reader, not forced.",
    "The submissionNote for each article should mention specific editorial guidelines or what the publisher typically accepts.",
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
          estimatedCost: budgetUsd,
        },
      ],
      totalArticles: 0,
      simulationNote:
        "These articles are ready to submit to publishers in our vetted marketplace (1,100+ publishers at members-only rates).",
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
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { rawText };
  } catch {
    output = { rawText };
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

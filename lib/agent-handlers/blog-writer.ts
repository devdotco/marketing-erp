import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const blogWriterHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const wordCount = Number(config.wordCount ?? 1500);
  const targetKeyword = String(config.targetKeyword ?? "");
  const topicBrief = String(config.topicBrief ?? "");
  const audienceDescription = String(config.audienceDescription ?? "");
  const toneOverride = String(config.toneOverride ?? "Use Brand Profile default");
  const cmsTarget = String(config.cmsTarget ?? "None (draft only)");
  const competitorUrls = String(config.competitorUrls ?? "");
  const includeStatistics = config.includeStatistics !== false;

  // Fetch business profile for brand voice context
  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business: ${businessProfile.businessName}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.brandVoice ? `Brand voice: ${businessProfile.brandVoice}` : "",
        businessProfile.targetAudience ? `Target audience: ${businessProfile.targetAudience}` : "",
        businessProfile.websiteUrl ? `Website: ${businessProfile.websiteUrl}` : "",
      ].filter(Boolean).join("\n")
    : "";

  const effectiveTone =
    toneOverride === "Use Brand Profile default"
      ? (businessProfile?.brandVoice ?? "professional and helpful")
      : toneOverride.toLowerCase();

  const systemPrompt = [
    "You are an expert SEO content writer.",
    "You write publication-ready articles that rank in search engines and genuinely help readers.",
    "Always verify statistics mentally before including them — prefer well-known, citable sources.",
    "Return ONLY valid JSON — no markdown fences, no preamble.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ].filter(Boolean).join("\n");

  const userPrompt = [
    `Write a ${wordCount}-word SEO-optimised blog article.`,
    targetKeyword ? `Primary keyword: "${targetKeyword}" — use naturally in title, first 100 words, and 2-3 subheadings.` : "",
    topicBrief ? `Topic brief: ${topicBrief}` : "",
    audienceDescription ? `Reader: ${audienceDescription}` : "",
    `Tone: ${effectiveTone}`,
    includeStatistics ? "Include specific, cited statistics from authoritative sources where they strengthen claims." : "Avoid third-party statistics.",
    competitorUrls ? `Cover angles these competitor articles miss:\n${competitorUrls}` : "",
    cmsTarget !== "None (draft only)" ? `Format the HTML output for ${cmsTarget} (use standard heading tags and <p> tags, no inline styles).` : "",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      title: "SEO-optimised article title",
      slug: "url-friendly-slug",
      metaDescription: "150-160 character meta description",
      focusKeyword: targetKeyword || "primary keyword",
      content: "<h1>...</h1><p>...</p>... (full HTML body)",
      wordCount: 0,
      estimatedReadMinutes: 0,
      internalLinkPlaceholders: ["[[relevant topic]]"],
      citations: [{ claim: "stat or claim", source: "Source name (year)", url: "https://..." }],
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
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { content: rawText };
  } catch {
    output = { content: rawText };
  }

  output.cmsTarget = cmsTarget;
  output.generatedAt = new Date().toISOString();

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

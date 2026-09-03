import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const onboarderHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const interviewDepth = String(config.interviewDepth ?? "Standard");
  const readWebsite = config.readWebsite !== false;
  const focusAreas = String(config.focusAreas ?? "All");
  const outputFormat = String(config.outputFormat ?? "Full Profile");

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const knownContext = businessProfile
    ? [
        businessProfile.businessName
          ? `Business name: ${businessProfile.businessName}`
          : "",
        businessProfile.websiteUrl
          ? `Website: ${businessProfile.websiteUrl}`
          : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.targetAudience
          ? `Target audience: ${businessProfile.targetAudience}`
          : "",
        businessProfile.brandVoice
          ? `Brand voice: ${businessProfile.brandVoice}`
          : "",
        businessProfile.uniqueValueProp
          ? `Unique value proposition: ${businessProfile.uniqueValueProp}`
          : "",
        businessProfile.competitors.length > 0
          ? `Known competitors: ${businessProfile.competitors.join(", ")}`
          : "",
        businessProfile.goals
          ? `Primary goals: ${JSON.stringify(businessProfile.goals)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const depthInstruction =
    interviewDepth === "Quick"
      ? "Focus on the highest-impact fields only. Be concise — 1-2 sentences per field."
      : interviewDepth === "Deep"
        ? "Go deep on every field. Extrapolate nuanced details about the business model, competitive positioning, and customer psychology."
        : "Balance depth and speed. Fill all fields with meaningful, specific content.";

  const focusInstruction =
    focusAreas === "Content"
      ? "Pay special attention to content strategy, brand voice, and editorial direction."
      : focusAreas === "SEO"
        ? "Pay special attention to keyword strategy, search intent, and organic growth opportunities."
        : focusAreas === "Paid"
          ? "Pay special attention to paid channel strategy, audience targeting, and ad creative angles."
          : focusAreas === "Social"
            ? "Pay special attention to social media presence, community, and engagement strategy."
            : "Cover all marketing channels equally.";

  const formatInstruction =
    outputFormat === "Summary"
      ? "Keep each section concise. 2-3 bullet points maximum per section."
      : outputFormat === "Action Plan"
        ? "Emphasise actionable next steps and quick wins throughout. Every section should end with a concrete action."
        : "Produce a complete, detailed profile suitable for configuring 48 AI marketing agents.";

  const systemPrompt = `You are a senior marketing strategist conducting a business onboarding interview.
Your goal: extract enough information to configure 48 AI marketing agents appropriately.
${depthInstruction}
${focusInstruction}
${formatInstruction}
Ask about the business, customer, competition, current marketing state, and goals. Be conversational and specific — avoid generic corporate questions.
Infer realistic details where the business profile is incomplete. Never return placeholder text or "N/A" — always synthesise something useful.
Return ONLY valid JSON — no markdown fences, no preamble.`;

  const websiteNote = readWebsite
    ? `Assume you have reviewed the business website (${businessProfile?.websiteUrl ?? "URL not provided"}) and incorporate insights accordingly.`
    : "";

  const userPrompt = `Conduct a ${interviewDepth.toLowerCase()} marketing onboarding for this business and produce a comprehensive profile.

Known business information:
${knownContext || "No business profile configured yet. Infer a realistic example business."}

${websiteNote}

Focus areas: ${focusAreas}
Output format: ${outputFormat}

Generate a complete onboarding output that would let a marketing team hit the ground running. Include realistic, specific details — not generic placeholders.

Return this exact JSON structure:
${JSON.stringify({
  businessProfile: {
    businessName: "string",
    industry: "string",
    businessModel: "B2B SaaS | B2C eCommerce | Professional Services | etc.",
    targetCustomer: {
      description: "string",
      painPoints: ["string"],
      goals: ["string"],
    },
    uniqueValue: "string",
    primaryProducts: ["string"],
    competitors: ["string"],
    currentChannels: ["string"],
    goals: {
      primary: "string",
      secondary: ["string"],
      timeframe: "string",
    },
    budget: {
      range: "string",
      allocation: "string",
    },
  },
  brandVoiceGuide: {
    tone: ["string"],
    vocabulary: {
      preferred: ["string"],
      avoid: ["string"],
    },
    examplePhrases: ["string"],
    writingStyle: "string",
  },
  marketingAudit: {
    strengths: ["string"],
    gaps: ["string"],
    quickWins: ["string"],
  },
  agentRecommendations: [
    {
      agentSlug: "string",
      agentName: "string",
      rationale: "string",
      priority: "start immediately" as const,
    },
  ],
  nextSteps: ["string"],
})}

Populate agentRecommendations with 6-8 agents from this platform (use real slugs like blog-writer, keyword-research, technical-audit, weekly-report, competitor-watch, email-marketing, linkedin-poster, x-poster, on-site-publisher, rank-tracker). Assign priorities honestly. Include 5-6 next steps that are specific and sequenced.`;

  const message = await client.messages.create({
    model: "claude-sonnet-5-20251015",
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText =
    message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { result: rawText };
  } catch {
    output = { result: rawText };
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

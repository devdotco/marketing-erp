import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const proposalHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const prospectName = String(config.prospectName ?? "");
  const prospectCompany = String(config.prospectCompany ?? "");
  const callNotes = String(config.callNotes ?? "");
  const rateCard = String(config.rateCard ?? "");
  const scopeLevel = String(config.scopeLevel ?? "Growth");
  const trackOpens = config.trackOpens !== false;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const agencyContext = businessProfile
    ? [
        businessProfile.businessName
          ? `Agency / preparer: ${businessProfile.businessName}`
          : "",
        businessProfile.websiteUrl
          ? `Agency website: ${businessProfile.websiteUrl}`
          : "",
        businessProfile.uniqueValueProp
          ? `Agency UVP: ${businessProfile.uniqueValueProp}`
          : "",
        businessProfile.brandVoice
          ? `Writing tone: ${businessProfile.brandVoice}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const scopeAgents =
    scopeLevel === "Starter"
      ? "5-8 agents: blog-writer, keyword-research, technical-audit, weekly-report, on-site-publisher"
      : scopeLevel === "Scale"
        ? "20-30 agents: full suite including content, SEO, paid, social, email, outreach, analytics, and AI strategy layers"
        : "10-15 agents: blog-writer, keyword-research, technical-audit, weekly-report, competitor-watch, email-marketing, linkedin-poster, x-poster, rank-tracker, topic-planner, on-site-publisher";

  const scopePricing =
    scopeLevel === "Starter"
      ? { monthly: 2500, setup: 1500 }
      : scopeLevel === "Scale"
        ? { monthly: 9500, setup: 5000 }
        : { monthly: 5000, setup: 2500 };

  const today = new Date();
  const proposalDate = today.toISOString().split("T")[0];
  const validUntilDate = new Date(today);
  validUntilDate.setDate(validUntilDate.getDate() + 30);
  const validUntil = validUntilDate.toISOString().split("T")[0];

  const systemPrompt = `You are a senior business development specialist who writes winning proposals.
Proposals that win are specific to the prospect's situation (not generic), show understanding of their pain before proposing solutions, and make the next step crystal clear.
Mirror the prospect's language from the call notes. Reference specific problems they mentioned.
Never use "synergy", "leverage", or "ecosystem".
Write in a confident, direct tone — not corporate fluff.
Return ONLY valid JSON — no markdown fences, no preamble.`;

  const rateCardSection = rateCard
    ? `\nRate card / pricing context:\n${rateCard}`
    : `\nDefault pricing for ${scopeLevel} scope: $${scopePricing.monthly}/month retainer + $${scopePricing.setup} setup fee.`;

  const userPrompt = `Write a winning proposal based on these call notes.

Prospect: ${prospectName} at ${prospectCompany}
Proposal date: ${proposalDate}
Valid until: ${validUntil}
Scope level: ${scopeLevel} (${scopeAgents})

Agency / preparer context:
${agencyContext || "Marketing agency preparing this proposal."}

Call notes:
${callNotes || "No call notes provided. Infer a realistic prospect situation."}
${rateCardSection}

Write a proposal that:
1. Opens with an executive summary that names the specific problems ${prospectName} mentioned
2. Shows you listened — reference exact pain points from the call notes
3. Proposes a concrete scope with named agents and delivery cadence
4. Makes the investment feel like a no-brainer relative to the problem being solved
5. Has crystal-clear next steps with named owners

Return this exact JSON structure:
${JSON.stringify({
  proposal: {
    prospectName: "",
    prospectCompany: "",
    preparedBy: businessProfile?.businessName ?? "Your Agency",
    date: proposalDate,
    validUntil,
    executiveSummary: "string",
    situationAnalysis: "string",
    proposedScope: {
      level: scopeLevel,
      agentsIncluded: [
        {
          agentName: "string",
          description: "string",
          cadence: "Weekly | Monthly | On-demand | Daily",
        },
      ],
      deliverables: ["string"],
      timeline: "string",
      onboardingProcess: "string",
    },
    investment: {
      monthlyRetainer: scopePricing.monthly as number | null,
      setupFee: scopePricing.setup as number | null,
      perRunCost: null as string | null,
      paymentTerms: "Net 30",
      whatIsIncluded: ["string"],
      whatIsNotIncluded: ["string"],
    },
    whyUs: "string",
    nextSteps: [
      {
        step: 1,
        action: "string",
        owner: "string",
        timeline: "string",
      },
    ],
    callNotesSummary: "string",
  },
  trackingNote: trackOpens
    ? "Proposal open tracking enabled. You will be notified when this proposal is viewed."
    : null,
})}

Make the executive summary and situation analysis specific to ${prospectCompany}'s situation from the call notes.
Include 5-8 agents in proposedScope.agentsIncluded with realistic cadences.
Write 4-6 deliverables, 4-6 inclusions, 3-4 exclusions.
Write 4-5 next steps with specific owners (prospect vs agency) and timelines.
Keep whyUs to 2-3 sentences — confident, not boastful.`;

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

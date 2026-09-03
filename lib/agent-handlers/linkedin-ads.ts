import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const linkedinAdsHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const funnelStage = (config.funnelStage as string) ?? "Awareness";
  const icp = (config.icp as string) ?? "Not specified";
  const offerType = (config.offerType as string) ?? "Content";
  const adFormats = (config.adFormats as string) ?? "All";
  const qualifiedLeadCostTarget = (config.qualifiedLeadCostTarget as number) ?? 200;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const systemPrompt = `You are a B2B LinkedIn Ads strategist. LinkedIn CPCs are expensive — every ad must target precisely and convert at the decision-making level. Carousel ads outperform single image for consideration stage. Message ads require carefully calibrated copy length.

Respond ONLY with a valid JSON object. No markdown, no explanations outside the JSON.`;

  const userPrompt = `Generate a comprehensive LinkedIn Ads strategy for:

Business: ${businessProfile?.businessName ?? "The client"}
Industry: ${businessProfile?.industry ?? "General"}
Website: ${businessProfile?.websiteUrl ?? "Not specified"}
Value Proposition: ${businessProfile?.uniqueValueProp ?? "Not specified"}
Target Audience: ${businessProfile?.targetAudience ?? "Not specified"}
Brand Voice: ${businessProfile?.brandVoice ?? "Not specified"}
Competitors: ${businessProfile?.competitors?.join(", ") ?? "Not specified"}
Goals: ${businessProfile?.goals ? JSON.stringify(businessProfile.goals) : "Not specified"}

Campaign Configuration:
- Funnel Stage: ${funnelStage}
- Ideal Customer Profile: ${icp}
- Offer Type: ${offerType}
- Ad Formats: ${adFormats}
- Qualified Lead Cost Target: $${qualifiedLeadCostTarget}

Generate ads for the requested formats. If adFormats is "All", produce one ad per format (Single Image, Carousel, Video, Message). Match targeting and copy precisely to the ICP and funnel stage.

Return a JSON object with this exact structure:
{
  "ads": [
    {
      "format": string,
      "funnelStage": string,
      "headline": string,
      "primaryText": string,
      "callToAction": string,
      "audienceTargeting": {
        "jobTitles": [string],
        "industries": [string],
        "companySizes": [string],
        "seniorityLevels": [string],
        "skills": [string]
      },
      "budgetRecommendation": string,
      "expectedCPL": string,
      "creative_brief": string
    }
  ],
  "audienceStrategy": string,
  "bidStrategy": string,
  "simulationNote": "Connect LinkedIn Ads in Settings to push these directly to Campaign Manager. Cost targets are benchmarks for your ICP."
}`;

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
  output.simulationNote =
    "Connect LinkedIn Ads in Settings to push these directly to Campaign Manager. Cost targets are benchmarks for your ICP.";

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return { output, costUsd };
};

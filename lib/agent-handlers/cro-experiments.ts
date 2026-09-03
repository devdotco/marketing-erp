import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const croExperimentsHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const pageUrl = (config.pageUrl as string) ?? "Not specified";
  const conversionGoal = (config.conversionGoal as string) ?? "Not specified";
  const trafficMonthly = (config.trafficMonthly as number) ?? 10000;
  const hypothesisCount = (config.hypothesisCount as number) ?? 5;
  const baselineConvRate = (config.baselineConvRate as number | undefined) ?? null;
  const ga4Property = (config.ga4Property as string) ?? "Not specified";

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const systemPrompt = `You are a conversion rate optimisation specialist. Hypotheses must specify mechanism (WHY will this change behaviour) not just what to change. Sample size calculations must use correct statistical formulas. Never recommend running more than one test on the same page simultaneously.

Respond ONLY with a valid JSON object. No markdown, no explanations outside the JSON.`;

  const userPrompt = `Generate a CRO experiment plan for:

Business: ${businessProfile?.businessName ?? "The client"}
Industry: ${businessProfile?.industry ?? "General"}
Website: ${businessProfile?.websiteUrl ?? "Not specified"}
Target Audience: ${businessProfile?.targetAudience ?? "Not specified"}
Unique Value Proposition: ${businessProfile?.uniqueValueProp ?? "Not specified"}

Page Configuration:
- Page URL: ${pageUrl}
- Conversion Goal: ${conversionGoal}
- Monthly Traffic: ${trafficMonthly}
- Number of Hypotheses: ${hypothesisCount}
- Baseline Conversion Rate: ${baselineConvRate !== null ? `${baselineConvRate}%` : "Unknown"}
- GA4 Property: ${ga4Property}

For sample size calculations, use 80% statistical power, 95% confidence level, and assume a minimum detectable effect of 20% relative lift unless the baseline conversion rate suggests otherwise. Calculate required sample size per variant.

Return a JSON object with this exact structure:
{
  "pageAnalysis": {
    "url": string,
    "conversionGoal": string,
    "currentConversionRate": number | null,
    "identifiedFriction": [string],
    "strengthsToKeep": [string]
  },
  "hypotheses": [
    {
      "hypothesisNumber": number,
      "element": string,
      "currentState": string,
      "proposedChange": string,
      "mechanism": string,
      "expectedLift": string,
      "confidence": "high" | "medium" | "low",
      "effort": "low" | "medium" | "high",
      "priority": number
    }
  ],
  "sampleSizeCalculations": [
    {
      "hypothesisNumber": number,
      "baselineConvRate": number,
      "minimumDetectableEffect": number,
      "requiredSampleSize": number,
      "estimatedRunTimeDays": number,
      "statisticalPower": number
    }
  ],
  "prioritisedTestingRoadmap": string,
  "simulationNote": "Connect GA4 in Settings to pull real page performance data. These hypotheses are generated from your page description."
}`;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
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
    "Connect GA4 in Settings to pull real page performance data. These hypotheses are generated from your page description.";

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  return { output, costUsd };
};

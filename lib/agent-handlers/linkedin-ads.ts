import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { bool, lines, num, resolveInputs, str } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";

export const linkedinAdsHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  const funnelStage = str(config, "funnelStages", "Full funnel");
  const icpJobTitles = lines(config, "icpJobTitles", 30);
  const icpCompanySize = str(config, "icpCompanySize");
  const icpIndustries = lines(config, "icpIndustries", 20);
  const offerType = str(config, "offerType", "Content");
  const adFormats = str(config, "adFormats", "All");
  const messageAdEnabled = bool(config, "messageAdEnabled", false);
  const targetCpl = num(config, "targetCPL", 200, { min: 1 });
  const brandVoiceNotes = str(config, "brandVoiceNotes");

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const icp = [
    icpJobTitles.length > 0 ? `Job titles: ${icpJobTitles.join(", ")}` : "",
    icpCompanySize ? `Company size: ${icpCompanySize} employees` : "",
    icpIndustries.length > 0 ? `Industries: ${icpIndustries.join(", ")}` : "",
  ].filter(Boolean).join("; ") || businessProfile?.targetAudience || "Not specified";

  const formatList = [...(adFormats === "All" ? ["Single Image", "Carousel", "Video"] : [adFormats]), ...(messageAdEnabled ? ["Message"] : [])];
  const stageList =
    funnelStage === "TOFU only" ? ["TOFU (awareness)"]
      : funnelStage === "MOFU only" ? ["MOFU (consideration)"]
        : funnelStage === "BOFU only" ? ["BOFU (conversion)"]
          : ["TOFU (awareness)", "MOFU (consideration)", "BOFU (conversion)"];

  const systemPrompt = `You are a B2B LinkedIn Ads strategist. LinkedIn CPCs are expensive — every ad must target precisely and convert at the decision-making level. Carousel ads outperform single image for consideration stage. Message ads require carefully calibrated copy length.

Respond ONLY with a valid JSON object. No markdown, no explanations outside the JSON.`;

  const userPrompt = `Generate a comprehensive LinkedIn Ads strategy for:

Business: ${businessProfile?.businessName ?? "The client"}
Industry: ${businessProfile?.industry ?? "General"}
Website: ${businessProfile?.websiteUrl ?? "Not specified"}
Value Proposition: ${businessProfile?.uniqueValueProp ?? "Not specified"}
Target Audience: ${businessProfile?.targetAudience ?? "Not specified"}
Brand Voice: ${businessProfile?.brandVoice ?? "Not specified"}
${brandVoiceNotes ? `Copy Guardrails (follow these in every line of copy): ${brandVoiceNotes}\n` : ""}Competitors: ${businessProfile?.competitors?.join(", ") ?? "Not specified"}
Goals: ${businessProfile?.goals ? JSON.stringify(businessProfile.goals) : "Not specified"}

Campaign Configuration:
- Funnel Stages: ${stageList.join(", ")}
- Ideal Customer Profile: ${icp}
- Offer Type: ${offerType}
- Ad Formats: ${formatList.join(", ")}
- Target Cost Per Lead: $${targetCpl} — expectedCPL must be judged against this; flag any ad whose expected CPL exceeds it

Produce one ad per format (${formatList.join(", ")}) for each funnel stage (${stageList.join(", ")}). ${messageAdEnabled ? "Message ads are full Message Ad scripts: subject line, greeting, body under 500 characters, and a single CTA." : "Do not produce Message ads."} Build audienceTargeting from the ICP job titles, company size and industries above, and match copy precisely to the ICP and funnel stage.

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
      "exceedsTargetCPL": boolean,
      "creative_brief": string
    }
  ],
  "audienceStrategy": string,
  "bidStrategy": string,
  "simulationNote": "Connect LinkedIn Ads in Settings to push these directly to Campaign Manager. Cost targets are benchmarks for your ICP."
}`;

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
  output.simulationNote =
    "Connect LinkedIn Ads in Settings to push these directly to Campaign Manager. Cost targets are benchmarks for your ICP.";

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  return { output, costUsd };
};

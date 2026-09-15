import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { lines, resolveInputs, str } from "@/lib/agents/inputs";
import { applyRenamedInputs } from "./renamed-inputs";
import { resolveAnthropic } from "@/lib/ai/client";

export const digitalPrHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);

  const config = resolveInputs(run);
  // The handler used to draft HARO-style expert quotes from an "expertiseAreas" field the
  // form never collected; it now builds what the Run form and overview describe. A saved
  // expertiseAreas value still stands in for the vertical.
  applyRenamedInputs(run, config, { businessVertical: "expertiseAreas" });

  const businessVertical = str(config, "businessVertical");
  const storyDataSources = str(config, "storyDataSources");
  const targetOutletTiers = str(config, "targetOutletTiers", "National + Trade");
  const geographicFocus = str(config, "geographicFocus");
  const brandVoice = str(config, "brandVoice");
  const excludeOutlets = lines(config, "excludeOutlets", 50);

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business: ${businessProfile.businessName}` : "",
        businessProfile.websiteUrl ? `Website: ${businessProfile.websiteUrl}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.brandVoice ? `Brand voice / tone: ${businessProfile.brandVoice}` : "",
        businessProfile.uniqueValueProp ? `Unique expertise angle: ${businessProfile.uniqueValueProp}` : "",
        businessProfile.targetAudience ? `Audience we serve: ${businessProfile.targetAudience}` : "",
        businessProfile.goals ? `Business goals: ${JSON.stringify(businessProfile.goals)}` : "",
      ].filter(Boolean).join("\n")
    : "";

  const tierMap: Record<string, string[]> = {
    "Trade Press Only": ["trade"],
    "National + Trade": ["national", "trade"],
    "Local + Trade": ["local", "trade"],
    "All Tiers": ["national", "trade", "local"],
  };
  const tiers = tierMap[targetOutletTiers] ?? ["national", "trade"];

  const systemPrompt = [
    "You are a digital PR strategist who turns a company's own data and milestones into stories journalists want to cover.",
    "A story angle must be anchored in a specific data point or milestone the client supplied — never invent statistics, customer names, or results.",
    "Write press releases in the register and length each outlet tier expects: national outlets want the wider trend first, trade press wants industry specifics, local press wants the community angle.",
    "Avoid hollow phrases like 'industry leader', 'revolutionary' or 'In today's fast-paced world'.",
    "You have no journalist database: suggest outlets and the beats worth pitching, but never invent journalist names or contact details.",
    "Return ONLY valid JSON — no markdown fences, no preamble.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
    brandVoice ? `\nBrand voice guidelines for every release:\n${brandVoice}` : "",
  ].filter(Boolean).join("\n");

  const userPrompt = [
    "Build a digital PR package.",
    businessVertical ? `Business vertical: ${businessVertical}` : "",
    storyDataSources
      ? `Story data and metrics supplied by the client (the only facts you may build angles on):\n${storyDataSources}`
      : "No story data was supplied — propose angles as briefs of the data the client would need to gather, and mark every one needsData: true.",
    `Outlet tiers to target: ${tiers.join(", ")}`,
    geographicFocus ? `Geographic focus: ${geographicFocus}` : "",
    excludeOutlets.length > 0 ? `Never suggest these outlets or people: ${excludeOutlets.join(", ")}` : "",
    "",
    "Produce 3 to 5 story angles. For each angle write one press release variation (250–400 words) per targeted tier, and suggest outlets (publication names and the beat to pitch) that fit the tier and geography.",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      storyAngles: [
        {
          angle: "Headline-style angle",
          hook: "Why a journalist would care right now",
          supportingData: ["Data point taken from the supplied story data"],
          needsData: false,
          pressReleases: [
            {
              tier: tiers[0],
              headline: "Release headline",
              subheadline: "Release subheadline",
              body: "Full press release body in HTML",
              wordCount: 0,
            },
          ],
          outletTargets: [
            { outlet: "Publication name", tier: tiers[0], beat: "Beat or section to pitch", relevance: "Why it fits" },
          ],
        },
      ],
      simulationNote:
        "Outlet suggestions come from Claude's general knowledge, not a media database — verify each outlet and find the right journalist before pitching.",
    }),
  ].filter(Boolean).join("\n");

  const message = await client.messages.create({
    model: MODELS.standard,
    // Up to 5 angles × 3 tiers of full press releases — 4096 can't hold that JSON.
    max_tokens: 16000,
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

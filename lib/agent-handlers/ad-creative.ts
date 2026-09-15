import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { bool, num, resolveInputs, str } from "@/lib/agents/inputs";
import { applyRenamedInputs } from "./renamed-inputs";
import { resolveAnthropic } from "@/lib/ai/client";

export const adCreativeHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  // Renamed to the Run form's keys on 2026-09-14; the old names still work from a saved config.
  applyRenamedInputs(run, config, {
    offerDescription: "product",
    targetAudience: "targetAudiences",
    variantsPerPlatform: "conceptCount",
  });

  const offerDescription = str(config, "offerDescription", "Not specified");
  const targetAudience = str(config, "targetAudience", "Not specified");
  const targetPlatforms = str(config, "targetPlatforms", "Google + Meta + LinkedIn");
  const variantsPerPlatform = num(config, "variantsPerPlatform", 5, { min: 1, max: 10 });
  const toneOfVoice = str(config, "toneOfVoice", "Professional");
  const competitiveDifferentiators = str(config, "competitiveDifferentiators");
  const existingWinners = str(config, "existingWinners");
  const primaryCTA = str(config, "primaryCTA", "Get Started");
  const formats = str(config, "formats", "Both");
  const shootPriority = bool(config, "shootPriority", true);

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  // "Google + Meta + LinkedIn" → ["Google", "Meta", "LinkedIn"]; "Meta only" → ["Meta"].
  const platforms = targetPlatforms
    .replace(/\bonly\b/gi, "")
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const platformList = platforms.length > 0 ? platforms : ["Google", "Meta", "LinkedIn"];
  const conceptCount = platformList.length * variantsPerPlatform;
  const competitors = businessProfile?.competitors?.length ? businessProfile.competitors.join(", ") : "Not specified";

  const systemPrompt = `You are a performance creative director. Creative concepts are judged by one criterion: will this stop the scroll and convert? Write concepts for the creative team to execute, not just descriptions of what the ad should say.

Respond ONLY with a valid JSON object. No markdown, no explanations outside the JSON.`;

  const userPrompt = `Generate ${variantsPerPlatform} ad creative variant(s) per platform for ${platformList.join(", ")} (${conceptCount} concepts in total) for:

Business: ${businessProfile?.businessName ?? "The client"}
Industry: ${businessProfile?.industry ?? "General"}
Website: ${businessProfile?.websiteUrl ?? "Not specified"}
Brand Voice: ${businessProfile?.brandVoice ?? "Not specified"}
Unique Value Proposition: ${businessProfile?.uniqueValueProp ?? "Not specified"}
Goals: ${businessProfile?.goals ? JSON.stringify(businessProfile.goals) : "Not specified"}

Campaign Configuration:
- Offer: ${offerDescription}
- Target Audience: ${targetAudience}
- Platforms: ${platformList.join(", ")}
- Variants Per Platform: ${variantsPerPlatform}
- Tone of Voice: ${toneOfVoice}
- Primary CTA: ${primaryCTA} (anchor CTAs on this; offer an alternative only where it is strategically stronger)
- Competitive Differentiators: ${competitiveDifferentiators || "Not specified — infer from the value proposition"}
- Competing Brands to Differentiate From: ${competitors}
- Formats: ${formats}
- Include Shoot Priority: ${shootPriority}
${existingWinners ? `\nExisting top-performing ads — match their proven voice, hook style and structure rather than starting from scratch:\n${existingWinners}\n` : ""}
Each variant within a platform must take a meaningfully different strategic angle, not a cosmetic rewording. Keep every headline, primary text and description within that platform's current character limits (Google Responsive Search Ads: 30-character headlines, 90-character descriptions; Meta: 40-character headline, 125 characters of primary text before truncation; LinkedIn Sponsored Content: 70-character headline, 150 characters of intro text before truncation).

If formats is "Static", produce only static concepts. If "Video", produce only video concepts. If "Both", mix static and video across the ${conceptCount} concepts (Google search ads are always static text).
${shootPriority ? "" : "Shoot priority is off: set every shootPriority to \"low\" and return an empty shootCallSheet.\n"}
Return a JSON object with this exact structure:
{
  "concepts": [
    {
      "conceptNumber": number,
      "platform": string,
      "angle": string,
      "targetAudience": string,
      "format": "static" | "video",
      "hook": string,
      "headline": string,
      "primaryText": string,
      "description": string,
      "cta": string,
      "onImageCopy": string | null,
      "videoScript": string | null,
      "visualDescription": string,
      "colorPalette": [string],
      "shootNotes": string,
      "differentiation": string,
      "shootPriority": "must shoot" | "high" | "medium" | "low"
    }
  ],
  "angleMatrix": [
    {
      "angle": string,
      "formats": [string],
      "audiences": [string]
    }
  ],
  "abTestGroupings": [
    {
      "platform": string,
      "conceptNumbers": [number],
      "hypothesis": string
    }
  ],
  "shootCallSheet": [
    {
      "priority": number,
      "scene": string,
      "props": [string],
      "talent": string,
      "estimatedShootTime": string
    }
  ]
}`;

  const message = await client.messages.create({
    model: MODELS.standard,
    // The form defaults ask for 15 concepts (3 platforms × 5), up to 30; 8096 leaves too little room for that JSON.
    max_tokens: 16000,
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

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  return { output, costUsd };
};

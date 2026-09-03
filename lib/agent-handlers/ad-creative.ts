import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const adCreativeHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const product = (config.product as string) ?? "Not specified";
  const targetAudiences = (config.targetAudiences as string) ?? "Not specified";
  const formats = (config.formats as string) ?? "Both";
  const conceptCount = (config.conceptCount as number) ?? 6;
  const shootPriority = (config.shootPriority as boolean) ?? true;
  const competingBrands = (config.competingBrands as string) ?? "Not specified";

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const systemPrompt = `You are a performance creative director. Creative concepts are judged by one criterion: will this stop the scroll and convert? Write concepts for the creative team to execute, not just descriptions of what the ad should say.

Respond ONLY with a valid JSON object. No markdown, no explanations outside the JSON.`;

  const userPrompt = `Generate ${conceptCount} ad creative concepts for:

Business: ${businessProfile?.businessName ?? "The client"}
Industry: ${businessProfile?.industry ?? "General"}
Website: ${businessProfile?.websiteUrl ?? "Not specified"}
Brand Voice: ${businessProfile?.brandVoice ?? "Not specified"}
Unique Value Proposition: ${businessProfile?.uniqueValueProp ?? "Not specified"}
Goals: ${businessProfile?.goals ? JSON.stringify(businessProfile.goals) : "Not specified"}

Campaign Configuration:
- Product / Offer: ${product}
- Target Audiences: ${targetAudiences}
- Formats: ${formats}
- Number of Concepts: ${conceptCount}
- Include Shoot Priority: ${shootPriority}
- Competing Brands to Differentiate From: ${competingBrands}

If formats is "Static", produce only static concepts. If "Video", produce only video concepts. If "Both", mix static and video across the ${conceptCount} concepts.

Return a JSON object with this exact structure:
{
  "concepts": [
    {
      "conceptNumber": number,
      "angle": string,
      "targetAudience": string,
      "format": "static" | "video",
      "hook": string,
      "headline": string,
      "primaryText": string,
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

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return { output, costUsd };
};

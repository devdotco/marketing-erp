import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const digitalPrHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const expertiseAreas = String(config.expertiseAreas ?? "");
  const responseStyle = String(config.responseStyle ?? "Expert Quote");
  const wordLimit = Number(config.wordLimit ?? 200);
  const includedBioLines = Number(config.includedBioLines ?? 2);
  const deadline = String(config.deadline ?? "");

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

  const formatKeyMap: Record<string, "quote" | "data" | "story"> = {
    "Expert Quote": "quote",
    "Data-Led": "data",
    "Story-Led": "story",
  };
  const formatKey = formatKeyMap[responseStyle] ?? "quote";

  const systemPrompt = [
    "You are a digital PR specialist who writes expert responses for journalist enquiries (HARO, Qwoted, Terkel).",
    "Every response must demonstrate genuine domain expertise — journalists can tell when a quote is written by a PR firm vs an actual expert.",
    "Lead with the insight, not the credentials. Avoid hollow phrases like 'As an industry leader' or 'In today's fast-paced world'.",
    "Bio lines must be concise, credible, and directly relevant to the question topic.",
    "Return ONLY valid JSON — no markdown fences, no preamble.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ].filter(Boolean).join("\n");

  const userPrompt = [
    `Generate expert journalist responses based on the following expertise profile.`,
    expertiseAreas ? `Areas of expertise: ${expertiseAreas}` : "",
    `Response style: ${responseStyle}`,
    `Word limit per response: ${wordLimit} words`,
    `Bio lines to include: ${includedBioLines}`,
    deadline ? `Deadline context: ${deadline}` : "",
    "",
    "Create at least 5 realistic journalist request scenarios relevant to the expertise areas, then write complete responses to each.",
    "Each response must be within the word limit. The bio must be exactly the number of lines specified.",
    `Format every response as a '${formatKey}' type.`,
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      responses: [
        {
          requestSource: "HARO / Qwoted / Terkel",
          journalist: null,
          publication: null,
          question: "The journalist's question",
          deadline: deadline || null,
          response: "Expert response text within word limit",
          responseWordCount: 0,
          bio: `${includedBioLines}-line author bio`,
          expertise: "Relevant expertise area matched to this question",
          format: formatKey,
        },
      ],
      simulationNote:
        "Connect to HARO, Qwoted, or Terkel in Settings to surface real journalist requests matching your expertise",
    }),
  ].filter(Boolean).join("\n");

  const message = await client.messages.create({
    model: "claude-sonnet-5-20251015",
    max_tokens: 4096,
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

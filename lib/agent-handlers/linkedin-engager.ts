import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { resolveInputs } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";

export const linkedinEngagerHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  const targetProfile = (config.targetProfile as string) ?? "";
  const commentStyle = (config.commentStyle as string) ?? "Insightful";
  const connectionNoteTemplate = (config.connectionNoteTemplate as string) ?? "";
  const dailyLimit = (config.dailyLimit as number) ?? 10;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const systemPrompt = `You are a LinkedIn engagement specialist for ${
    (businessProfile as any)?.companyName ?? "a business"
  }.
Your job is to draft authentic, substantive engagement actions (comments and connection notes) that never feel automated.
Industry: ${(businessProfile as any)?.industry ?? "Business"}
Comment style preference: ${commentStyle}
Always respond with ONLY a valid JSON object — no markdown fences, no extra prose.`;

  const userPrompt = `Draft a queue of LinkedIn engagement actions for today (max ${dailyLimit} actions).

Target profile context: ${targetProfile || "Industry peers, potential clients, and thought leaders relevant to our business"}

Connection note template to personalise:
${connectionNoteTemplate || "Hi [Name], I came across your post on [topic] and it really resonated. I'd love to connect and follow your work. — [Sender]"}

Business context:
- Company: ${(businessProfile as any)?.companyName ?? "Our Business"}
- Industry: ${(businessProfile as any)?.industry ?? "Business Services"}
- Our expertise: ${(businessProfile as any)?.keyOfferings ?? "Business solutions and consulting"}
- Target audience: ${(businessProfile as any)?.targetAudience ?? "Business professionals"}

Comment style: ${commentStyle}
- Insightful: adds a new angle or data point to the original post
- Supportive: validates with a specific, non-generic affirmation
- Question: poses a genuinely curious follow-up question
- Contrarian: respectfully challenges an assumption with evidence

Return exactly this JSON shape:
{
  "engagementQueue": [
    {
      "id": "action_1",
      "actionType": "comment|connectionNote|replyToComment",
      "targetPersonName": "First Last",
      "targetPersonTitle": "VP Marketing at Acme Corp",
      "targetPostSnippet": "brief excerpt of the post being engaged with",
      "targetPostTopic": "AI in Supply Chain",
      "draftedText": "the full comment or connection note text",
      "styleApplied": "${commentStyle}",
      "wordCount": 42,
      "estimatedReplyProbability": 0.34,
      "estimatedProfileViewLikelihood": "High|Medium|Low",
      "priority": 1,
      "approved": false,
      "sendAfterApproval": false
    }
  ],
  "connectionNoteQueue": [
    {
      "id": "note_1",
      "targetPersonName": "First Last",
      "targetPersonTitle": "CEO at StartupXYZ",
      "sharedContext": "both attended SaaStr 2024",
      "personalisedNote": "full connection note text (under 300 chars)",
      "characterCount": 245,
      "approved": false
    }
  ],
  "dailySummary": {
    "totalActionsQueued": 10,
    "comments": 7,
    "connectionNotes": 3,
    "estimatedNetworkGrowth": 2,
    "estimatedProfileViews": 18
  },
  "strategyNote": "brief note on why these targets were prioritised"
}`;

  const message = await client.messages.create({
    model: MODELS.fast,
    max_tokens: 4096,
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
    "Connect LinkedIn in Settings to pull live feed posts, profile data, and enable one-click send";

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

  return { output, costUsd };
};

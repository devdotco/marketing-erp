import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

type RevenueEvent = "email_reply" | "linkedin_reply" | "interested" | "meeting_booked";

const GHL_STAGE_MAP: Record<RevenueEvent, string> = {
  email_reply: "Lead",
  linkedin_reply: "Lead",
  interested: "Qualified Lead",
  meeting_booked: "Meeting Set",
};

export const outboundRevenueHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const input = (run.input ?? {}) as Record<string, unknown>;

  const prospectId = (input.prospectId ?? config.prospectId) as string | undefined;
  const event = (input.event ?? config.event ?? "email_reply") as RevenueEvent;
  const replyText = (input.replyText ?? config.replyText ?? "") as string;

  if (!prospectId) {
    const output = { error: "No prospectId in run.input.prospectId" };
    return { output, costUsd: 0 };
  }

  const prospect = await prisma.outboundProspect.findUnique({
    where: { id: prospectId },
    include: { play: true },
  });

  if (!prospect) {
    const output = { error: `Prospect ${prospectId} not found` };
    return { output, costUsd: 0 };
  }

  const intelligence = (prospect.intelligence ?? {}) as Record<string, unknown>;
  const intel = (intelligence.intelligence ?? {}) as Record<string, unknown>;

  const systemPrompt = `You are a CRM and revenue operations specialist for Dev.co. Your job is to generate GoHighLevel (GHL) contact and opportunity data when a prospect engages.

Generate the exact field values to use when creating or updating GHL records. The data must be complete and accurate.

Always respond with valid JSON only — no markdown, no commentary.`;

  const userPrompt = `Generate GHL CRM data for this engagement event.

Event: ${event}
${replyText ? `Reply text: "${replyText}"` : ""}

Prospect:
- Name: ${prospect.firstName} ${prospect.lastName ?? ""}
- Email: ${prospect.email}
- Title: ${prospect.title ?? "Unknown"}
- Company: ${prospect.company}
- LinkedIn: ${prospect.linkedInUrl ?? "Not available"}
- Play: ${prospect.play.slug} — ${prospect.play.name}
- ICP Score: ${prospect.score}/100
- Channel: ${prospect.channel}

Intelligence:
- Pain hypothesis: ${(intel.painHypothesis as string) ?? "Not available"}
- Best offer: ${(intel.bestOffer as string) ?? "Not available"}
- Primary signal: ${(intel.primarySignal as string) ?? "Not available"}

Return exactly this JSON structure:
{
  "contact": {
    "firstName": "string",
    "lastName": "string",
    "email": "string",
    "phone": null,
    "companyName": "string",
    "jobTitle": "string",
    "website": "string or null",
    "linkedIn": "string or null",
    "tags": ["outbound", "string ICP play tag", "string signal tag"],
    "customFields": {
      "icp_score": 0,
      "icp_play": "string",
      "pain_hypothesis": "string",
      "primary_signal": "string",
      "outbound_channel": "string"
    },
    "notes": "string (1-2 sentence context note for the sales rep)"
  },
  "opportunity": {
    "name": "string (e.g. 'Dev.co — Acme Software')",
    "pipeline": "Outbound",
    "stage": "${GHL_STAGE_MAP[event] ?? "Lead"}",
    "value": 0,
    "currency": "USD",
    "source": "Outbound — ${event}",
    "assignedTo": null
  },
  "timeline_note": "string (event note for the contact timeline, 1 sentence)",
  "action": "create_contact" | "create_opportunity" | "update_opportunity"
}`;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let ghlData: Record<string, unknown>;
  try {
    ghlData = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch {
    ghlData = {};
  }

  // Simulate GHL API calls
  const simulatedContactId = prospect.ghlContactId ?? `ghl_contact_${prospect.id.slice(-8)}`;
  const simulatedOpportunityId =
    event === "interested" || event === "meeting_booked"
      ? `ghl_opp_${prospect.id.slice(-8)}_${Date.now()}`
      : prospect.ghlOpportunityId ?? null;

  // Update prospect record
  const updateData: {
    ghlContactId: string;
    ghlOpportunityId?: string | null;
    emailRepliedAt?: Date;
    linkedInRepliedAt?: Date;
    interestedAt?: Date;
    meetingBookedAt?: Date;
    status?: "REPLIED" | "INTERESTED" | "MEETING_BOOKED";
  } = { ghlContactId: simulatedContactId };

  if (simulatedOpportunityId) updateData.ghlOpportunityId = simulatedOpportunityId;
  if (event === "email_reply") updateData.emailRepliedAt = new Date();
  if (event === "linkedin_reply") updateData.linkedInRepliedAt = new Date();
  if (event === "interested") {
    updateData.interestedAt = new Date();
    updateData.status = "INTERESTED";
  }
  if (event === "meeting_booked") {
    updateData.meetingBookedAt = new Date();
    updateData.status = "MEETING_BOOKED";
  }
  if (event === "email_reply" || event === "linkedin_reply") updateData.status = "REPLIED";

  await prisma.outboundProspect.update({ where: { id: prospectId }, data: updateData });

  const output: Record<string, unknown> = {
    prospectId,
    event,
    ghlContactId: simulatedContactId,
    ghlOpportunityId: simulatedOpportunityId,
    stage: GHL_STAGE_MAP[event],
    contact: ghlData.contact,
    opportunity: ghlData.opportunity,
    timelineNote: ghlData.timeline_note,
    action: ghlData.action,
    simulationNote: "Connect GoHighLevel integration in Settings to create real CRM records via GHL API",
    generatedAt: new Date().toISOString(),
    workspaceId: run.agentConfig.workspaceId,
  };

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  return { output, costUsd };
};

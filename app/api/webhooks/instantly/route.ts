import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueAgentRun } from "@/lib/queue";

export const dynamic = "force-dynamic";

// Webhook payload shapes from Instantly
type InstantlyReplyEvent = {
  event: "reply_received" | "interested" | "not_interested" | "meeting_booked" | "campaign_completed_no_reply";
  leadId: string;
  email: string;
  replyText?: string;
  campaignId?: string;
  timestamp?: string;
};

export async function POST(req: NextRequest) {
  let body: InstantlyReplyEvent;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { event, leadId, email, replyText } = body;

  if (!event || !email) {
    return NextResponse.json({ error: "Missing event or email" }, { status: 400 });
  }

  // Look up the prospect by Instantly lead ID or email
  const prospect = await prisma.outboundProspect.findFirst({
    where: {
      OR: [
        { instantlyLeadId: leadId },
        { email: email.toLowerCase() },
      ],
    },
    include: { workspace: { include: { agentConfigs: true } } },
  });

  if (!prospect) {
    return NextResponse.json({ received: true, matched: false });
  }

  // Pause Aimfox if they replied via email (cross-channel suppression)
  if (event === "reply_received" || event === "interested" || event === "meeting_booked") {
    if (prospect.aimfoxLeadId) {
      // In production: call Aimfox API to pause the lead's sequence
      await prisma.outboundProspect.update({
        where: { id: prospect.id },
        data: { status: "REPLIED" },
      });
    }
  }

  if (event === "not_interested") {
    await prisma.outboundProspect.update({
      where: { id: prospect.id },
      data: {
        status: "NOT_INTERESTED",
        excludedAt: new Date(),
        excludeUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        exclusionReason: "Email: replied not interested",
      },
    });
    return NextResponse.json({ received: true, action: "suppressed" });
  }

  // For reply / interested / meeting — trigger Revenue agent
  if (event === "reply_received" || event === "interested" || event === "meeting_booked") {
    const revenueConfig = prospect.workspace.agentConfigs.find(
      (c) => c.agentSlug === "outbound-revenue"
    );

    if (revenueConfig) {
      const eventMap: Record<string, string> = {
        reply_received: "email_reply",
        interested: "interested",
        meeting_booked: "meeting_booked",
      };

      const run = await prisma.agentRun.create({
        data: {
          workspaceId: prospect.workspaceId,
          agentConfigId: revenueConfig.id,
          status: "PENDING",
          triggeredBy: "webhook:instantly",
          input: {
            prospectId: prospect.id,
            event: eventMap[event] ?? "email_reply",
            replyText: replyText ?? "",
            source: "instantly",
            sourceLeadId: leadId,
          },
        },
      });

      await enqueueAgentRun(run.id);
    }
  }

  return NextResponse.json({ received: true, prospectId: prospect.id, event });
}

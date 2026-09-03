import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueAgentRun } from "@/lib/queue";

export const dynamic = "force-dynamic";

// Webhook payload shapes from Aimfox
type AimfoxEvent = {
  event: "new_reply" | "connection_accepted" | "connection_declined" | "new_connection";
  leadId: string;
  linkedInUrl?: string;
  replyText?: string;
  campaignId?: string;
  timestamp?: string;
};

export async function POST(req: NextRequest) {
  let body: AimfoxEvent;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { event, leadId, linkedInUrl, replyText } = body;

  if (!event || !leadId) {
    return NextResponse.json({ error: "Missing event or leadId" }, { status: 400 });
  }

  // Look up the prospect by Aimfox lead ID or LinkedIn URL
  const prospect = await prisma.outboundProspect.findFirst({
    where: {
      OR: [
        { aimfoxLeadId: leadId },
        ...(linkedInUrl ? [{ linkedInUrl }] : []),
      ],
    },
    include: { workspace: { include: { agentConfigs: true } } },
  });

  if (!prospect) {
    return NextResponse.json({ received: true, matched: false });
  }

  if (event === "connection_declined") {
    // Don't retry LinkedIn for 90 days — email sequence continues unaffected
    await prisma.outboundProspect.update({
      where: { id: prospect.id },
      data: {
        excludeUntil: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      },
    });
    return NextResponse.json({ received: true, action: "linkedin_retry_paused_90d" });
  }

  if (event === "connection_accepted") {
    await prisma.outboundProspect.update({
      where: { id: prospect.id },
      data: { status: "IN_SEQUENCE" },
    });
    return NextResponse.json({ received: true, action: "sequence_continues" });
  }

  // new_reply: pause Instantly email sequence + trigger Revenue agent
  if (event === "new_reply") {
    await prisma.outboundProspect.update({
      where: { id: prospect.id },
      data: { linkedInRepliedAt: new Date(), status: "REPLIED" },
    });

    // In production: call Instantly API to pause this lead's email sequence
    // await pauseInstantlyLead(prospect.instantlyLeadId)

    const revenueConfig = prospect.workspace.agentConfigs.find(
      (c) => c.agentSlug === "outbound-revenue"
    );

    if (revenueConfig) {
      const run = await prisma.agentRun.create({
        data: {
          workspaceId: prospect.workspaceId,
          agentConfigId: revenueConfig.id,
          status: "PENDING",
          triggeredBy: "webhook:aimfox",
          input: {
            prospectId: prospect.id,
            event: "linkedin_reply",
            replyText: replyText ?? "",
            source: "aimfox",
            sourceLeadId: leadId,
          },
        },
      });

      await enqueueAgentRun(run.id);
    }
  }

  return NextResponse.json({ received: true, prospectId: prospect.id, event });
}

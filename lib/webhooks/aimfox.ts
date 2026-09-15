import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueAgentRun } from "@/lib/queue";
import { authenticateWebhook } from "@/lib/integrations/webhook-auth";

// Webhook payload shapes from Aimfox
type AimfoxEvent = {
  event: "new_reply" | "connection_accepted" | "connection_declined" | "new_connection";
  leadId: string;
  linkedInUrl?: string;
  replyText?: string;
  campaignId?: string;
  timestamp?: string;
};

/**
 * Shared by /api/webhooks/aimfox (header token, or unsigned during the grace
 * window) and /api/webhooks/aimfox/<token>.
 *
 * Prospects are matched ONLY inside the workspace the token authenticated, and
 * the response never carries an internal id.
 */
export async function handleAimfoxWebhook(req: NextRequest, token: string | null): Promise<NextResponse> {
  const authed = await authenticateWebhook("AIMFOX", token);
  if ("reject" in authed) return NextResponse.json({ error: "Unauthorized" }, { status: authed.reject });

  let body: AimfoxEvent;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { event, leadId, linkedInUrl, replyText } = body ?? ({} as AimfoxEvent);

  if (!event || typeof leadId !== "string" || !leadId) {
    return NextResponse.json({ error: "Missing event or leadId" }, { status: 400 });
  }

  // Look up the prospect by Aimfox lead ID or LinkedIn URL, inside the authenticated workspace.
  const candidates = await prisma.outboundProspect.findMany({
    where: {
      OR: [{ aimfoxLeadId: leadId }, ...(typeof linkedInUrl === "string" && linkedInUrl ? [{ linkedInUrl }] : [])],
      ...(authed.workspaceId ? { workspaceId: authed.workspaceId } : {}),
    },
    include: { workspace: { include: { agentConfigs: true } } },
    take: 2,
  });
  // Unsigned (grace window) deliveries have no workspace; act only on an unambiguous match.
  const prospect = authed.workspaceId || candidates.length === 1 ? candidates[0] : undefined;

  if (!prospect) {
    return NextResponse.json({ received: true });
  }

  if (event === "connection_declined") {
    // Don't retry LinkedIn for 90 days — email sequence continues unaffected
    await prisma.outboundProspect.updateMany({
      where: { id: prospect.id, workspaceId: prospect.workspaceId },
      data: {
        excludeUntil: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      },
    });
    return NextResponse.json({ received: true });
  }

  if (event === "connection_accepted") {
    await prisma.outboundProspect.updateMany({
      where: { id: prospect.id, workspaceId: prospect.workspaceId },
      data: { status: "IN_SEQUENCE" },
    });
    return NextResponse.json({ received: true });
  }

  // new_reply: pause Instantly email sequence + trigger Revenue agent
  if (event === "new_reply") {
    await prisma.outboundProspect.updateMany({
      where: { id: prospect.id, workspaceId: prospect.workspaceId },
      data: { linkedInRepliedAt: new Date(), status: "REPLIED" },
    });

    // In production: call Instantly API to pause this lead's email sequence
    // await pauseInstantlyLead(prospect.instantlyLeadId)

    const revenueConfig = prospect.workspace.agentConfigs.find((c) => c.agentSlug === "outbound-revenue");

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

  return NextResponse.json({ received: true });
}

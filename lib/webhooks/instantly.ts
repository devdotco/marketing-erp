import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueAgentRun } from "@/lib/queue";
import { authenticateWebhook } from "@/lib/integrations/webhook-auth";

// Webhook payload shapes from Instantly
type InstantlyReplyEvent = {
  event: "reply_received" | "interested" | "not_interested" | "meeting_booked" | "campaign_completed_no_reply";
  leadId?: string;
  email: string;
  replyText?: string;
  campaignId?: string;
  timestamp?: string;
};

/**
 * Shared by /api/webhooks/instantly (header token, or unsigned during the grace
 * window) and /api/webhooks/instantly/<token>.
 *
 * Prospects are matched ONLY inside the workspace the token authenticated. The
 * response never carries an internal id: whoever holds a webhook URL learns
 * nothing about the database from it.
 */
export async function handleInstantlyWebhook(req: NextRequest, token: string | null): Promise<NextResponse> {
  const authed = await authenticateWebhook("INSTANTLY", token);
  if ("reject" in authed) return NextResponse.json({ error: "Unauthorized" }, { status: authed.reject });

  let body: InstantlyReplyEvent;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { event, leadId, email, replyText } = body ?? ({} as InstantlyReplyEvent);

  if (!event || typeof email !== "string" || !email) {
    return NextResponse.json({ error: "Missing event or email" }, { status: 400 });
  }

  // Only real values become match clauses: `{ instantlyLeadId: undefined }` is
  // no filter at all in Prisma, so a payload without a leadId used to match an
  // arbitrary prospect.
  const or = [
    ...(typeof leadId === "string" && leadId ? [{ instantlyLeadId: leadId }] : []),
    { email: email.toLowerCase() },
  ];
  const candidates = await prisma.outboundProspect.findMany({
    where: { OR: or, ...(authed.workspaceId ? { workspaceId: authed.workspaceId } : {}) },
    include: { workspace: { include: { agentConfigs: true } } },
    take: 2,
  });
  // Unsigned (grace window) deliveries have no workspace; act only on an unambiguous match.
  const prospect = authed.workspaceId || candidates.length === 1 ? candidates[0] : undefined;

  if (!prospect) {
    return NextResponse.json({ received: true });
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
    return NextResponse.json({ received: true });
  }

  // For reply / interested / meeting — trigger Revenue agent
  if (event === "reply_received" || event === "interested" || event === "meeting_booked") {
    const revenueConfig = prospect.workspace.agentConfigs.find((c) => c.agentSlug === "outbound-revenue");

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
            sourceLeadId: leadId ?? null,
          },
        },
      });

      await enqueueAgentRun(run.id);
    }
  }

  return NextResponse.json({ received: true });
}

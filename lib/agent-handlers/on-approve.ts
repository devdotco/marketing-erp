/**
 * What happens when a human approves an AWAITING_APPROVAL run.
 *
 * Before this existed, approving a run (app/api/runs/[runId]/approve/route.ts) only flipped its
 * status to APPROVED — nothing downstream ever read that status, so "approve" was a label with no
 * effect. Email Marketing's Instantly/Apollo/erp.io CRM channels are the first thing that needs
 * approval to DO something (move leads into a campaign and launch it; enrol contacts in a
 * sequence and start sending) — see lib/agent-handlers/email-marketing-channels.ts for why the
 * run only stages an inert draft/sequence up to this point.
 *
 * Generic by design rather than special-cased in the route: any agent slug can register a hook
 * here, and the route just calls whichever one matches (if any) before flipping the status. A
 * hook returns the run's new `output` (or nothing, to leave `output` as it was) and MUST be safe
 * to call twice — the approve route only ever calls it once per successful approval (a run can't
 * be approved a second time; the route's own AWAITING_APPROVAL check prevents that), but each
 * hook also re-checks for itself, so calling it out of that path (a retry, a future admin action)
 * can never enrol or send twice either.
 */

import type { AgentRun, AgentConfig, IntegrationProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { AgentInputError } from "@/lib/ai/errors";
import {
  activateInstantlyChannel,
  activateApolloSequence,
  activateCrmSequence,
  type InstantlyChannelOutput,
  type ApolloChannelOutput,
  type CrmChannelOutput,
} from "./email-marketing-channels";
import { activateProspectorInstantlyChannel, type ProspectorInstantlyChannel } from "./prospector-outreach";
import { activateOutboundEmailDelivery, type OutboundEmailDelivery } from "./outbound-email-delivery";
import { activateOutboundLinkedinDelivery, type OutboundLinkedinDelivery } from "./outbound-linkedin-delivery";
import { activateOutboundRevenueDelivery, type OutboundRevenueDelivery } from "./outbound-revenue-delivery";

export type OnApproveHandler = (
  run: AgentRun & { agentConfig: AgentConfig },
) => Promise<Record<string, unknown> | undefined>;

async function emailMarketingOnApprove(
  run: AgentRun & { agentConfig: AgentConfig },
): Promise<Record<string, unknown> | undefined> {
  const output = (run.output ?? {}) as Record<string, unknown>;
  const channelDelivery = output.channelDelivery as Record<string, unknown> | undefined;

  // Nothing staged (Mailchimp/Klaviyo, or staging itself failed), or already activated by an
  // earlier call — either way there is nothing for approval to do.
  if (!channelDelivery || channelDelivery.status !== "staged") return;

  const platform = channelDelivery.platform as IntegrationProvider;
  const integration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: platform } },
  });
  if (!integration) {
    throw new AgentInputError(
      `The ${platform} integration was disconnected after this campaign was staged.`,
      "Reconnect it under Settings → Integrations, then approve this run again.",
      "channel_disconnected",
    );
  }

  if (platform === "INSTANTLY") {
    const creds = await decryptCredentials<{ apiKey: string }>(integration.encryptedCredentials);
    channelDelivery.instantly = await activateInstantlyChannel(creds.apiKey, channelDelivery.instantly as InstantlyChannelOutput);
  } else if (platform === "APOLLO") {
    const creds = await decryptCredentials<{ apiKey: string }>(integration.encryptedCredentials);
    channelDelivery.apollo = await activateApolloSequence(creds.apiKey, channelDelivery.apollo as ApolloChannelOutput);
  } else if (platform === "CRM_ERP_IO") {
    const creds = await decryptCredentials<{ apiKey: string; crmUrl?: string }>(integration.encryptedCredentials);
    channelDelivery.crm = await activateCrmSequence(creds.apiKey, channelDelivery.crm as CrmChannelOutput);
  } else {
    return;
  }

  channelDelivery.status = "activated";
  return { ...output, channelDelivery };
}

/**
 * Prospector's Instantly staging is a single channel, not a pick-one-of-three like Email
 * Marketing's — so this hook is simpler: no platform switch, just "was an Instantly campaign
 * staged, and is it still staged (not already activated, and not left in an error state)".
 */
async function prospectorOnApprove(
  run: AgentRun & { agentConfig: AgentConfig },
): Promise<Record<string, unknown> | undefined> {
  const output = (run.output ?? {}) as Record<string, unknown>;
  const channelDelivery = output.channelDelivery as Record<string, unknown> | undefined;

  if (!channelDelivery || channelDelivery.status !== "staged" || !channelDelivery.instantly) return;

  const integration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "INSTANTLY" } },
  });
  if (!integration) {
    throw new AgentInputError(
      "The Instantly integration was disconnected after this campaign was staged.",
      "Reconnect it under Settings → Integrations, then approve this run again.",
      "channel_disconnected",
    );
  }

  const creds = await decryptCredentials<{ apiKey: string }>(integration.encryptedCredentials);
  const activated = await activateProspectorInstantlyChannel(creds.apiKey, channelDelivery.instantly as ProspectorInstantlyChannel);
  channelDelivery.instantly = activated;
  channelDelivery.status = "activated";
  return { ...output, channelDelivery };
}

/**
 * Outbound Email / LinkedIn / Revenue — the Outbound Engine's three agents that write to a live
 * Instantly, Aimfox, or GoHighLevel account. Owner decision: these always stage and only ever
 * execute on a workspace admin's approval, with no `requireApproval` escape hatch (unlike, say,
 * Outbound Scout) — see lib/agent-handlers/outbound-email.ts, outbound-linkedin.ts, and
 * outbound-revenue.ts for why each one's mutating API call can't happen any earlier than this.
 * Revenue in particular is normally triggered by an Instantly/Aimfox webhook, not a person
 * clicking "run" — gating happens here, in the one place every trigger path (manual run, webhook)
 * funnels through, rather than in the webhook routes themselves.
 */
async function outboundEmailOnApprove(
  run: AgentRun & { agentConfig: AgentConfig },
): Promise<Record<string, unknown> | undefined> {
  const output = (run.output ?? {}) as Record<string, unknown>;
  const delivery = output.delivery as OutboundEmailDelivery | undefined;
  if (!delivery || delivery.status !== "staged") return;

  let apiKey: string | undefined;
  if (delivery.connected) {
    const integration = await prisma.integration.findUnique({
      where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "INSTANTLY" } },
    });
    if (!integration) {
      throw new AgentInputError(
        "The Instantly integration was disconnected after this lead was staged.",
        "Reconnect it under Settings → Integrations, then approve this run again.",
        "channel_disconnected",
      );
    }
    const creds = await decryptCredentials<{ apiKey: string }>(integration.encryptedCredentials);
    apiKey = creds.apiKey;
  }

  const activated = await activateOutboundEmailDelivery(delivery, { apiKey });

  // Best-effort pipeline bookkeeping — the lead add already happened (or was simulated); a
  // failure writing it back to the prospect record must not undo that or block the approval
  // from completing. The approve route's own retry loop is what durably persists `activated`
  // onto run.output (see app/api/runs/[runId]/approve/route.ts).
  await prisma.outboundProspect
    .update({ where: { id: delivery.prospectId }, data: { instantlyLeadId: activated.instantlyLeadId, status: "IN_SEQUENCE" } })
    .catch((err) => console.error(`[on-approve] outbound-email: could not update prospect ${delivery.prospectId}:`, err));

  return { ...output, delivery: activated };
}

async function outboundLinkedinOnApprove(
  run: AgentRun & { agentConfig: AgentConfig },
): Promise<Record<string, unknown> | undefined> {
  const output = (run.output ?? {}) as Record<string, unknown>;
  const delivery = output.delivery as OutboundLinkedinDelivery | undefined;
  if (!delivery || delivery.status !== "staged") return;

  let apiKey: string | undefined;
  if (delivery.connected) {
    const integration = await prisma.integration.findUnique({
      where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "AIMFOX" } },
    });
    if (!integration) {
      throw new AgentInputError(
        "The Aimfox integration was disconnected after this profile was staged.",
        "Reconnect it under Settings → Integrations, then approve this run again.",
        "channel_disconnected",
      );
    }
    const creds = await decryptCredentials<{ apiKey: string }>(integration.encryptedCredentials);
    apiKey = creds.apiKey;
  }

  const activated = await activateOutboundLinkedinDelivery(delivery, { apiKey });

  await prisma.outboundProspect
    .update({ where: { id: delivery.prospectId }, data: { aimfoxLeadId: activated.aimfoxLeadId } })
    .catch((err) => console.error(`[on-approve] outbound-linkedin: could not update prospect ${delivery.prospectId}:`, err));

  return { ...output, delivery: activated };
}

async function outboundRevenueOnApprove(
  run: AgentRun & { agentConfig: AgentConfig },
): Promise<Record<string, unknown> | undefined> {
  const output = (run.output ?? {}) as Record<string, unknown>;
  const delivery = output.delivery as OutboundRevenueDelivery | undefined;
  if (!delivery || delivery.status !== "staged") return;

  let apiKey: string | undefined;
  let locationId: string | undefined;
  if (delivery.connected) {
    const integration = await prisma.integration.findUnique({
      where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "GO_HIGH_LEVEL" } },
    });
    if (!integration) {
      throw new AgentInputError(
        "The GoHighLevel integration was disconnected after this event was staged.",
        "Reconnect it under Settings → Integrations, then approve this run again.",
        "channel_disconnected",
      );
    }
    const creds = await decryptCredentials<{ apiKey: string; locationId: string }>(integration.encryptedCredentials);
    apiKey = creds.apiKey;
    locationId = creds.locationId;
  }

  // Read fresh, not from this run's own staged output — an opportunity may have been created
  // for this prospect by a different run (a second reply event) since this one was staged.
  // Opportunity creation is not idempotent on GHL's side, so this is what stops a duplicate.
  const prospect = await prisma.outboundProspect.findUnique({
    where: { id: delivery.prospectId },
    select: { ghlOpportunityId: true },
  });

  const activated = await activateOutboundRevenueDelivery(delivery, prospect?.ghlOpportunityId ?? null, { apiKey, locationId });

  const updateData: { ghlContactId?: string; ghlOpportunityId?: string | null } = {};
  if (activated.ghlContactId) updateData.ghlContactId = activated.ghlContactId;
  if (activated.ghlOpportunityId) updateData.ghlOpportunityId = activated.ghlOpportunityId;
  await prisma.outboundProspect
    .update({ where: { id: delivery.prospectId }, data: updateData })
    .catch((err) => console.error(`[on-approve] outbound-revenue: could not update prospect ${delivery.prospectId}:`, err));

  return { ...output, delivery: activated };
}

const ON_APPROVE: Partial<Record<string, OnApproveHandler>> = {
  "email-marketing": emailMarketingOnApprove,
  "prospector": prospectorOnApprove,
  "outbound-email": outboundEmailOnApprove,
  "outbound-linkedin": outboundLinkedinOnApprove,
  "outbound-revenue": outboundRevenueOnApprove,
};

export function getOnApprove(agentSlug: string): OnApproveHandler | undefined {
  return ON_APPROVE[agentSlug];
}

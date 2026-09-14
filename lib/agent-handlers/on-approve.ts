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
import { executeLinkedinEngagerBatch, summarizeBatch, type LinkedinEngagerDelivery } from "./linkedin-engager-delivery";
import {
  validateSocialAccount,
  postsStillToCreate,
  type PendingSocialPost,
  type SocialPlatformKey,
} from "./social-poster-shared";
import { publishMetaBatch, isMetaBatchSettled, type MetaStagedPost } from "./meta-poster-delivery";
import type { MetaCredentials } from "@/lib/integrations/meta";

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
/**
 * Batched since the Outbound Engine rebuild: one Email Outbound run now stages many prospects
 * (`output.deliveries`), not just one. `output.delivery` (singular) is still read as a fallback —
 * an AWAITING_APPROVAL run staged before batching shipped has only that shape, and this hook must
 * still approve it correctly.
 *
 * Per-prospect idempotency: activateOutboundEmailDelivery() no-ops on a delivery already
 * `activated` (same check as before batching), so re-processing the array on a retry never
 * double-sends anyone already done. Abort-vs-continue rule for a failure mid-batch: if NOTHING in
 * this call has sent yet, a failure throws and the whole run reverts to AWAITING_APPROVAL for a
 * clean retry (identical to the pre-batch behaviour for a single delivery). Once at least one real
 * send has happened this call, a later failure can't safely revert — Instantly was already told to
 * send to someone — so it's recorded as `error` on that one delivery and the rest of the batch
 * keeps going, rather than losing already-sent confirmations behind a thrown exception.
 */
async function outboundEmailOnApprove(
  run: AgentRun & { agentConfig: AgentConfig },
): Promise<Record<string, unknown> | undefined> {
  const output = (run.output ?? {}) as Record<string, unknown>;
  const deliveries: OutboundEmailDelivery[] = Array.isArray(output.deliveries)
    ? (output.deliveries as OutboundEmailDelivery[])
    : output.delivery
      ? [output.delivery as OutboundEmailDelivery]
      : [];
  if (deliveries.length === 0 || !deliveries.some((d) => d.status === "staged")) return;

  let apiKey: string | undefined;
  if (deliveries.some((d) => d.connected)) {
    const integration = await prisma.integration.findUnique({
      where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "INSTANTLY" } },
    });
    if (!integration) {
      throw new AgentInputError(
        "The Instantly integration was disconnected after these leads were staged.",
        "Reconnect it under Settings → Integrations, then approve this run again.",
        "channel_disconnected",
      );
    }
    const creds = await decryptCredentials<{ apiKey: string }>(integration.encryptedCredentials);
    apiKey = creds.apiKey;
  }

  const results: OutboundEmailDelivery[] = [];
  let anyActivatedThisCall = false;

  for (const delivery of deliveries) {
    if (delivery.status === "activated") {
      results.push(delivery);
      continue;
    }
    try {
      const activated = await activateOutboundEmailDelivery(delivery, { apiKey: delivery.connected ? apiKey : undefined });
      results.push(activated);
      anyActivatedThisCall = true;

      // Best-effort pipeline bookkeeping — the lead add already happened (or was simulated); a
      // failure writing it back to the prospect record must not undo that or block the approval
      // from completing. The approve route's own retry loop is what durably persists `activated`
      // onto run.output (see app/api/runs/[runId]/approve/route.ts).
      await prisma.outboundProspect
        .update({ where: { id: activated.prospectId }, data: { instantlyLeadId: activated.instantlyLeadId, status: "IN_SEQUENCE" } })
        .catch((err) => console.error(`[on-approve] outbound-email: could not update prospect ${activated.prospectId}:`, err));
    } catch (err) {
      if (!anyActivatedThisCall) throw err; // nothing sent yet — safe to abort and let the admin retry.
      results.push({ ...delivery, error: err instanceof Error ? err.message : String(err) });
      console.error(`[on-approve] outbound-email: prospect ${delivery.prospectId} failed after other deliveries in this batch already sent:`, err);
    }
  }

  return { ...output, deliveries: results, delivery: results[0] };
}

/** Batched the same way and for the same reason as outboundEmailOnApprove above — see its doc
 * comment for the abort-vs-continue rule. */
async function outboundLinkedinOnApprove(
  run: AgentRun & { agentConfig: AgentConfig },
): Promise<Record<string, unknown> | undefined> {
  const output = (run.output ?? {}) as Record<string, unknown>;
  const deliveries: OutboundLinkedinDelivery[] = Array.isArray(output.deliveries)
    ? (output.deliveries as OutboundLinkedinDelivery[])
    : output.delivery
      ? [output.delivery as OutboundLinkedinDelivery]
      : [];
  if (deliveries.length === 0 || !deliveries.some((d) => d.status === "staged")) return;

  let apiKey: string | undefined;
  if (deliveries.some((d) => d.connected)) {
    const integration = await prisma.integration.findUnique({
      where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "AIMFOX" } },
    });
    if (!integration) {
      throw new AgentInputError(
        "The Aimfox integration was disconnected after these profiles were staged.",
        "Reconnect it under Settings → Integrations, then approve this run again.",
        "channel_disconnected",
      );
    }
    const creds = await decryptCredentials<{ apiKey: string }>(integration.encryptedCredentials);
    apiKey = creds.apiKey;
  }

  const results: OutboundLinkedinDelivery[] = [];
  let anyActivatedThisCall = false;

  for (const delivery of deliveries) {
    if (delivery.status === "activated") {
      results.push(delivery);
      continue;
    }
    try {
      const activated = await activateOutboundLinkedinDelivery(delivery, { apiKey: delivery.connected ? apiKey : undefined });
      results.push(activated);
      anyActivatedThisCall = true;

      await prisma.outboundProspect
        .update({ where: { id: activated.prospectId }, data: { aimfoxLeadId: activated.aimfoxLeadId } })
        .catch((err) => console.error(`[on-approve] outbound-linkedin: could not update prospect ${activated.prospectId}:`, err));
    } catch (err) {
      if (!anyActivatedThisCall) throw err;
      results.push({ ...delivery, error: err instanceof Error ? err.message : String(err) });
      console.error(`[on-approve] outbound-linkedin: prospect ${delivery.prospectId} failed after other deliveries in this batch already sent:`, err);
    }
  }

  return { ...output, deliveries: results, delivery: results[0] };
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

/**
 * LinkedIn Engager stages a BATCH of actions (up to a day's worth), not one delivery like
 * Outbound LinkedIn — see lib/agent-handlers/linkedin-engager-delivery.ts's module docstring for
 * why executeLinkedinEngagerBatch() never throws once it starts. This hook only ever throws
 * before that point, when nothing has executed yet and reverting the run to AWAITING_APPROVAL
 * (this route's own catch, below) loses nothing.
 */
async function linkedinEngagerOnApprove(
  run: AgentRun & { agentConfig: AgentConfig },
): Promise<Record<string, unknown> | undefined> {
  const output = (run.output ?? {}) as Record<string, unknown>;
  const delivery = output.delivery as LinkedinEngagerDelivery | undefined;
  if (!delivery) return;

  let apiKey: string | undefined;
  if (delivery.connected) {
    const integration = await prisma.integration.findUnique({
      where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "AIMFOX" } },
    });
    if (!integration) {
      throw new AgentInputError(
        "The Aimfox integration was disconnected after this queue was staged.",
        "Reconnect it under Settings → Integrations, then approve this run again.",
        "channel_disconnected",
      );
    }
    const creds = await decryptCredentials<{ apiKey: string }>(integration.encryptedCredentials);
    apiKey = creds.apiKey;
  }

  const activated = await executeLinkedinEngagerBatch(delivery, { apiKey });
  return { ...output, delivery: activated, deliverySummary: summarizeBatch(activated) };
}

/**
 * LinkedIn Poster and X Poster share this hook: both stage a batch into `output.pendingPosts`
 * against a chosen `SocialAccount` (see lib/agent-handlers/social-poster-shared.ts for why neither
 * agent uses a `prisma.integration` row) and end AWAITING_APPROVAL with nothing sent. Approving
 * creates one SocialPost per pending post, scheduled at the time staged into it — from there,
 * app/api/cron/social-publish is what actually calls the LinkedIn/X API, reusing that cron's
 * existing token refresh and company-page handling instead of this hook duplicating it.
 *
 * Idempotent the same way outboundEmailOnApprove is: `output.createdSocialPostIds` maps each
 * pending post's stable id to the SocialPost id already created for it, so a retried call only
 * creates rows for whatever's left in postsStillToCreate() — never a second row for a post already
 * scheduled. The account is re-validated here (not just trusted from staging time) because it may
 * have been disconnected or expired in the time between staging and approval.
 */
async function socialPosterOnApprove(
  run: AgentRun & { agentConfig: AgentConfig },
): Promise<Record<string, unknown> | undefined> {
  const output = (run.output ?? {}) as Record<string, unknown>;
  const pendingPosts = Array.isArray(output.pendingPosts) ? (output.pendingPosts as PendingSocialPost[]) : [];
  const platform = output.platform as SocialPlatformKey | undefined;
  const socialAccountId = output.socialAccountId as string | undefined;
  if (pendingPosts.length === 0 || !platform || !socialAccountId) return;

  const alreadyCreated = (output.createdSocialPostIds ?? {}) as Record<string, string>;
  const toCreate = postsStillToCreate(pendingPosts, alreadyCreated);
  if (toCreate.length === 0) return; // every pending post already has a SocialPost — nothing to do.

  const account = await prisma.socialAccount.findUnique({ where: { id: socialAccountId } });
  const validation = validateSocialAccount(account, { workspaceId: run.agentConfig.workspaceId, platform });
  if (!validation.ok) {
    throw new AgentInputError(
      validation.message,
      validation.hint,
      `social_account_${validation.code}`,
    );
  }

  const createdSocialPostIds = { ...alreadyCreated };
  for (const post of toCreate) {
    const created = await prisma.socialPost.create({
      data: {
        workspaceId: run.agentConfig.workspaceId,
        socialAccountId: account!.id,
        content: post.content,
        status: "SCHEDULED",
        scheduledAt: new Date(post.scheduledAt),
      },
    });
    createdSocialPostIds[post.id] = created.id;
  }

  return { ...output, createdSocialPostIds, scheduledCount: Object.keys(createdSocialPostIds).length };
}

/**
 * Meta Poster stages `output.pendingPosts` against the workspace's connected META `Integration`
 * (Meta has no SocialPlatform enum value, so unlike LinkedIn/X Poster it never creates a
 * SocialPost — see lib/agent-handlers/meta-poster-delivery.ts's module docstring). Approving
 * publishes every not-yet-settled post immediately via publishMetaBatch, which records a
 * published/failed/manual outcome on each post individually rather than throwing on the first
 * failure — so a bad post doesn't block the rest of the batch. Idempotent: isMetaBatchSettled()
 * short-circuits once every post has left "pending", and publishMetaBatch itself skips any post
 * already "published" or "manual" — a retried call never re-publishes.
 */
async function metaPosterOnApprove(
  run: AgentRun & { agentConfig: AgentConfig },
): Promise<Record<string, unknown> | undefined> {
  const output = (run.output ?? {}) as Record<string, unknown>;
  const pendingPosts = Array.isArray(output.pendingPosts) ? (output.pendingPosts as MetaStagedPost[]) : [];
  if (pendingPosts.length === 0 || isMetaBatchSettled(pendingPosts)) return;

  const targetPlatforms = (output.targetPlatforms as "Facebook" | "Instagram" | "Both") ?? "Both";

  const integration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "META" } },
  });
  if (!integration) {
    throw new AgentInputError(
      "The Meta integration was disconnected after this batch was staged.",
      "Reconnect it under Settings → Integrations, then approve this run again.",
      "channel_disconnected",
    );
  }
  const creds = await decryptCredentials<MetaCredentials>(integration.encryptedCredentials);

  const { posts, publishedCount } = await publishMetaBatch(pendingPosts, creds, targetPlatforms);
  return { ...output, pendingPosts: posts, publishedCount };
}

const ON_APPROVE: Partial<Record<string, OnApproveHandler>> = {
  "email-marketing": emailMarketingOnApprove,
  "prospector": prospectorOnApprove,
  "outbound-email": outboundEmailOnApprove,
  "outbound-linkedin": outboundLinkedinOnApprove,
  "outbound-revenue": outboundRevenueOnApprove,
  "linkedin-engager": linkedinEngagerOnApprove,
  "linkedin-poster": socialPosterOnApprove,
  "x-poster": socialPosterOnApprove,
  "meta-poster": metaPosterOnApprove,
};

export function getOnApprove(agentSlug: string): OnApproveHandler | undefined {
  return ON_APPROVE[agentSlug];
}

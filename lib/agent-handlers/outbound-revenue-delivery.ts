/**
 * Outbound Revenue's stage/activate split — pulled out of outbound-revenue.ts (which touches
 * Prisma and Anthropic) so this pure/network-injectable half can be imported into
 * test/content.test.ts without dragging a database client into the test bundle. Same reason
 * email-marketing-channels.ts and prospector-outreach.ts are their own files.
 *
 * Writes to the erp.io CRM (app.erp.io/crm). This agent used to write GoHighLevel contacts and
 * opportunities; GoHighLevel is retired estate-wide, and the CRM is where the team works deals now.
 */
import { AgentInputError } from "@/lib/ai/errors";
import {
  crmRecordOutboundEngagement,
  type CrmOutboundEngagement,
  type CrmOutboundEngagementResult,
  type CrmOutboundEvent,
  type CrmTarget,
} from "@/lib/integrations/crm-erp-io";
import { isChannelActivated } from "./email-marketing-channels";

export type RevenueEvent = CrmOutboundEvent;

/**
 * ---------------------------------------------------------------------------
 * Stage now, write to the CRM on approval
 * ---------------------------------------------------------------------------
 *
 * The Revenue agent is triggered automatically by Instantly/Aimfox reply webhooks
 * (app/api/webhooks/instantly, app/api/webhooks/aimfox) — so unlike Email/LinkedIn Outbound,
 * nobody clicked "run" here. That makes gating this one more important, not less: a webhook
 * firing must never itself write a live CRM record. outbound-revenue.ts checks the CRM link and the
 * play's pipeline (read-only) and writes the exact engagement the CRM will record — timeline note,
 * deal name, suggested reply — but the CRM write only happens from the approval hook
 * (lib/agent-handlers/on-approve.ts), after a workspace admin approves the run.
 */
export interface OutboundRevenueDelivery {
  status: "staged" | "activated";
  activatedAt?: string;
  prospectId: string;
  event: RevenueEvent;
  /** Exactly what POST /api/marketing-erp/outbound/engagements receives. Staged in full so the
   * approver sees what will be written, and so approval writes that and nothing else. */
  engagement: CrmOutboundEngagement;
  /** Display only — the pipeline the deal will land in, as known at staging time. */
  pipelineName?: string;
  crmPersonId?: string;
  crmDealId?: string | null;
  crmTaskId?: string | null;
  stageName?: string | null;
  /** The CRM's own account of anything it could not do (no stage for this event, plan limits, …). */
  warnings?: string[];
  /** True when the CRM had already recorded this exact engagement — a retried approval. */
  duplicate?: boolean;
  source?: "crm_live";
}

export interface EngagementProspect {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string;
  title: string | null;
  company: string;
  companyDomain: string | null;
  linkedInUrl: string | null;
  score: number;
  channel: string;
  play: { slug: string; name: string };
  intelligence: { painHypothesis?: string; primarySignal?: string; bestOffer?: string };
}

export interface EngagementWriting {
  note?: string;
  dealName?: string;
  tags?: string[];
  replyDraft?: string;
}

export interface EngagementPlaySettings {
  crmPipelineId?: string;
  crmStageKeys?: Partial<Record<RevenueEvent, string>>;
  crmDealOn: "interested" | "reply";
}

/** Pure: whether this event opens a CRM deal under the play's setting. An existing deal for the
 * prospect is moved by any later event regardless — that is decided on the CRM side. */
export function wantsDeal(event: RevenueEvent, dealOn: EngagementPlaySettings["crmDealOn"]): boolean {
  if (event === "interested" || event === "meeting_booked") return true;
  return dealOn === "reply";
}

const nonEmpty = (v: string | null | undefined) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Pure — the exact engagement body approval sends. `eventKey` is the run id: one run is one
 * engagement, so re-approving it is a duplicate on the CRM side, while a second reply (a second
 * run) is a second timeline row. */
export function buildCrmEngagement(input: {
  prospect: EngagementProspect;
  event: RevenueEvent;
  runId: string;
  occurredAt: Date;
  replyText?: string;
  writing: EngagementWriting;
  play: EngagementPlaySettings;
}): CrmOutboundEngagement {
  const { prospect, event, writing, play } = input;
  const intelligence = {
    painHypothesis: nonEmpty(prospect.intelligence.painHypothesis)?.slice(0, 2000),
    primarySignal: nonEmpty(prospect.intelligence.primarySignal)?.slice(0, 500),
    bestOffer: nonEmpty(prospect.intelligence.bestOffer)?.slice(0, 1000),
  };
  const hasIntel = Object.values(intelligence).some(Boolean);
  const tags = [...new Set((writing.tags ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t && t.length <= 60))].slice(0, 10);
  return {
    prospectId: prospect.id,
    event,
    eventKey: input.runId,
    occurredAt: input.occurredAt.toISOString(),
    contact: {
      email: prospect.email,
      firstName: nonEmpty(prospect.firstName),
      lastName: nonEmpty(prospect.lastName),
      title: nonEmpty(prospect.title),
      company: nonEmpty(prospect.company),
      companyDomain: nonEmpty(prospect.companyDomain),
      linkedinUrl: nonEmpty(prospect.linkedInUrl),
      ...(tags.length > 0 ? { tags } : {}),
    },
    play: prospect.play,
    score: prospect.score,
    channel: prospect.channel,
    ...(hasIntel ? { intelligence } : {}),
    note: nonEmpty(writing.note)?.slice(0, 1000),
    replyText: nonEmpty(input.replyText)?.slice(0, 8000),
    replyDraft: nonEmpty(writing.replyDraft)?.slice(0, 8000),
    deal: {
      create: wantsDeal(event, play.crmDealOn),
      name: nonEmpty(writing.dealName)?.slice(0, 200),
      pipelineId: nonEmpty(play.crmPipelineId),
      ...(play.crmStageKeys && Object.values(play.crmStageKeys).some(Boolean) ? { stageKeys: play.crmStageKeys } : {}),
    },
  };
}

/** Pure: what a CRM refusal means for the person approving the run. */
export function crmRefusalHint(status: number, code: string | undefined, via: "service" | "key"): string {
  if (status === 401) {
    return via === "service"
      ? "The CRM didn't accept this server's signature — MARKETING_SERVICE_PUBLIC_KEY on the CRM must match this server's key. Approve again once it does."
      : "The CRM rejected this workspace's stored API key; it may have been revoked.";
  }
  if (status === 404 && code === "no_linked_crm_workspace") {
    return "This organization's CRM workspace hasn't been created yet. It is created automatically — approve again in a few minutes.";
  }
  if (status === 404 && code === "pipeline_not_found") {
    return "Pick another CRM pipeline on this play (Outbound Engine → Plays), or clear it to use the CRM's Outbound pipeline, then approve again.";
  }
  if (status === 404) {
    return "The CRM doesn't have the Outbound Engine endpoint yet — deploy the CRM, then approve again.";
  }
  if (status >= 500) return "The CRM had a problem on its side. Approve the run again in a moment.";
  return "Check the prospect's details on the Outbound page, then approve again.";
}

/**
 * Sends the staged engagement to the CRM. Idempotent twice over: an already-activated delivery
 * returns untouched without a call, and the CRM itself answers a repeated (prospect, event, run)
 * with `duplicate: true` and writes nothing. `record` is injectable so this is testable without a
 * network.
 */
export async function activateOutboundRevenueDelivery(
  delivery: OutboundRevenueDelivery,
  deps: { target: CrmTarget; via: "service" | "key"; record?: typeof crmRecordOutboundEngagement },
): Promise<OutboundRevenueDelivery> {
  if (isChannelActivated(delivery)) return delivery;

  const record = deps.record ?? crmRecordOutboundEngagement;
  let res: Response;
  try {
    res = await record(deps.target, delivery.engagement);
  } catch (err) {
    throw new AgentInputError(
      `Couldn't reach the CRM to record this engagement (${err instanceof Error ? err.message : String(err)}).`,
      "This is usually a transient network problem — approve the run again.",
      "crm_unreachable",
    );
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new AgentInputError(
      `The CRM refused to record ${delivery.engagement.contact.email}'s engagement (HTTP ${res.status}${body.error ? `: ${body.error}` : ""}).`,
      crmRefusalHint(res.status, body.code, deps.via),
      res.status === 401 ? "crm_unauthorized" : "crm_engagement_failed",
    );
  }

  const result = (await res.json()) as CrmOutboundEngagementResult;
  return {
    ...delivery,
    status: "activated",
    activatedAt: new Date().toISOString(),
    crmPersonId: result.personId,
    crmDealId: result.dealId,
    crmTaskId: result.taskId,
    pipelineName: result.pipeline?.name ?? delivery.pipelineName,
    stageName: result.stage?.name ?? null,
    warnings: result.warnings ?? [],
    duplicate: result.duplicate,
    source: "crm_live",
  };
}

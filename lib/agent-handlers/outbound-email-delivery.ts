/**
 * Outbound Email's stage/activate split — pulled out of outbound-email.ts (which touches Prisma
 * and Anthropic) so this pure/network-injectable half can be imported into test/content.test.ts
 * without dragging a database client into the test bundle. Same reason email-marketing-channels.ts
 * and prospector-outreach.ts are their own files.
 */
import { AgentInputError } from "@/lib/ai/errors";
import { addInstantlyLead } from "@/lib/integrations/instantly";
import { isChannelActivated } from "./email-marketing-channels";

/**
 * ---------------------------------------------------------------------------
 * Stage now, add the lead on approval
 * ---------------------------------------------------------------------------
 *
 * Adding a lead to a live Instantly campaign starts sending to them on Instantly's own
 * schedule — there is no "add but don't send" mode for an already-active campaign the way
 * Email Marketing's channels get one by creating a fresh Draft campaign. So outbound-email.ts
 * resolves the target campaign (a read-only lookup) and computes the exact lead payload while
 * running, but never calls the Instantly lead-add API itself — that only happens from the
 * approval hook (lib/agent-handlers/on-approve.ts), after a workspace admin approves the run.
 */
export interface OutboundEmailDelivery {
  status: "staged" | "activated";
  activatedAt?: string;
  prospectId: string;
  firstName: string;
  company: string;
  email: string;
  campaignName: string;
  /** The resolved live campaign id — present once known. Equal to campaignName when no
   * Instantly integration is connected (nothing to resolve against). */
  campaignId: string;
  connected: boolean;
  personalization: Record<string, string>;
  instantlyLeadId?: string;
  source?: "instantly_live" | "simulation";
  /** Set only on a delivery that failed to activate within a batch that had at least one other
   * delivery succeed this same approval call — see on-approve.ts's outboundEmailOnApprove for why
   * a batch doesn't abort on the first failure once real sends have already happened. Absent on
   * every successfully staged/activated delivery. */
  error?: string;
}

/** Pure — the exact body POST /leads gets. `skip_if_in_campaign` is Instantly's own dedupe
 * flag (see developer.instantly.ai): if this prospect was already added to this campaign by an
 * earlier approved run, or the customer added them directly in Instantly, Instantly itself
 * no-ops instead of creating a second lead — a second, independent guard on top of this
 * handler's own `isChannelActivated` check. */
export function buildOutboundEmailLeadBody(delivery: OutboundEmailDelivery): Record<string, unknown> {
  return {
    campaign: delivery.campaignId,
    email: delivery.email,
    first_name: delivery.firstName,
    last_name: "",
    company_name: delivery.company,
    personalization: delivery.personalization.pain_signal ?? "",
    custom_variables: delivery.personalization,
    skip_if_in_campaign: true,
  };
}

function instantlyErrorHint(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith("unreachable:")) {
    return "This is usually a transient network problem — approve the run again. If it keeps happening, check Instantly's status page.";
  }
  const status = Number(message.match(/^http_(\d+)/)?.[1] ?? 0);
  if (status === 401 || status === 403) {
    return "The Instantly API key in Settings → Integrations → Instantly is invalid, revoked, or not a v2 key — reconnect it there.";
  }
  return `Check the campaign and lead in Instantly. Detail: ${message.slice(0, 300)}`;
}

/**
 * Adds the staged lead to its Instantly campaign. Idempotent: no-ops if `delivery` was already
 * activated (checked via the same `activatedAt` convention Email Marketing's channels use), so
 * a retried or duplicated approval call — or a second approval attempt after an earlier one
 * partially failed downstream (e.g. the DB write after a successful add) — never re-adds the
 * lead. `addLead` is injectable so this can be unit tested without a live key (see
 * test/content.test.ts).
 */
export async function activateOutboundEmailDelivery(
  delivery: OutboundEmailDelivery,
  deps: { apiKey?: string; addLead?: typeof addInstantlyLead } = {},
): Promise<OutboundEmailDelivery> {
  if (isChannelActivated(delivery)) return delivery;

  if (!delivery.connected || !deps.apiKey) {
    // No Instantly integration connected — simulate so the pipeline still produces a
    // consistent, approvable record instead of blocking on a missing integration.
    return {
      ...delivery,
      status: "activated",
      activatedAt: new Date().toISOString(),
      instantlyLeadId: `instantly_${delivery.prospectId.slice(-8)}_${Date.now()}`,
      source: "simulation",
    };
  }

  const addLead = deps.addLead ?? addInstantlyLead;
  let data: { id: string };
  try {
    data = await addLead(deps.apiKey, buildOutboundEmailLeadBody(delivery));
  } catch (err) {
    throw new AgentInputError(
      `Instantly rejected adding ${delivery.email} to campaign "${delivery.campaignName}".`,
      instantlyErrorHint(err),
      "instantly_add_lead_failed",
    );
  }

  return {
    ...delivery,
    status: "activated",
    activatedAt: new Date().toISOString(),
    instantlyLeadId: data.id,
    source: "instantly_live",
  };
}

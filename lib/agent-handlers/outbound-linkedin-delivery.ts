/**
 * Outbound LinkedIn's stage/activate split — pulled out of outbound-linkedin.ts (which touches
 * Prisma and Anthropic) so this pure/network-injectable half can be imported into
 * test/content.test.ts without dragging a database client into the test bundle. Same reason
 * email-marketing-channels.ts and prospector-outreach.ts are their own files.
 */
import { AgentInputError } from "@/lib/ai/errors";
import { isChannelActivated } from "./email-marketing-channels";

const AIMFOX_TIMEOUT_MS = 15_000;

/**
 * ---------------------------------------------------------------------------
 * Stage now, add the profile on approval
 * ---------------------------------------------------------------------------
 *
 * Adding a profile to a live Aimfox campaign starts sending connection requests and follow-ups
 * from the customer's own connected LinkedIn seat — there's no inert "staged" state in Aimfox
 * itself. So outbound-linkedin.ts resolves the target campaign (read-only) and writes the
 * connection note / follow-ups while running, but never calls Aimfox's add-to-audience endpoint
 * itself — that only happens from the approval hook (lib/agent-handlers/on-approve.ts), after a
 * workspace admin approves the run.
 */
export interface OutboundLinkedinDelivery {
  status: "staged" | "activated";
  activatedAt?: string;
  prospectId: string;
  firstName: string;
  company: string;
  linkedInUrl: string;
  campaignName: string;
  /** The resolved live campaign id — present once known. Equal to campaignName when no Aimfox
   * integration is connected (nothing to resolve against). */
  campaignId: string;
  connected: boolean;
  connectionNote: string;
  message1: string;
  message2: string;
  aimfoxLeadId?: string;
  source?: "aimfox_live" | "simulation";
  /** Set only on a delivery that failed to activate within a batch that had at least one other
   * delivery succeed this same approval call — see on-approve.ts's outboundLinkedinOnApprove.
   * Absent on every successfully staged/activated delivery. */
  error?: string;
}

/** Pure — the exact body POST /campaigns/{id}/audience gets. */
export function buildAimfoxAudienceBody(delivery: OutboundLinkedinDelivery): Record<string, unknown> {
  return {
    campaign_id: delivery.campaignId,
    profile_url: delivery.linkedInUrl,
    custom_variables: {
      connection_note: delivery.connectionNote,
      message_1: delivery.message1,
      message_2: delivery.message2,
    },
  };
}

/** POST /campaigns/{id}/audience — the real add. Only ever call this from the approval hook. */
export async function addProfileToAimfoxCampaign(
  apiKey: string,
  campaignId: string,
  body: Record<string, unknown>,
): Promise<{ id?: string }> {
  const res = await fetch(`https://api.aimfox.com/api/v2/campaigns/${encodeURIComponent(campaignId)}/audience`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AIMFOX_TIMEOUT_MS),
  });
  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`http_${res.status}: ${errorText.slice(0, 300)}`);
  }
  return (await res.json().catch(() => ({}))) as { id?: string };
}

/**
 * Adds the staged profile to its Aimfox campaign. Idempotent: no-ops if `delivery` was already
 * activated (the same `activatedAt` convention Email Marketing's channels use), so a retried or
 * duplicated approval call never re-adds the profile. Aimfox does not document whether
 * re-adding an existing audience member is itself a no-op (unlike Instantly's documented
 * `skip_if_in_campaign`), so this handler's own check is the only guard — see the task report
 * for this caveat. `addProfile` is injectable so this can be unit tested without a live key.
 */
export async function activateOutboundLinkedinDelivery(
  delivery: OutboundLinkedinDelivery,
  deps: { apiKey?: string; addProfile?: typeof addProfileToAimfoxCampaign } = {},
): Promise<OutboundLinkedinDelivery> {
  if (isChannelActivated(delivery)) return delivery;

  if (!delivery.connected || !deps.apiKey) {
    return {
      ...delivery,
      status: "activated",
      activatedAt: new Date().toISOString(),
      aimfoxLeadId: `aimfox_${delivery.prospectId.slice(-8)}_${Date.now()}`,
      source: "simulation",
    };
  }

  const addProfile = deps.addProfile ?? addProfileToAimfoxCampaign;
  let result: { id?: string };
  try {
    result = await addProfile(deps.apiKey, delivery.campaignId, buildAimfoxAudienceBody(delivery));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(message.match(/^http_(\d+)/)?.[1] ?? 0);
    throw new AgentInputError(
      `Aimfox rejected adding ${delivery.firstName} to campaign "${delivery.campaignName}".`,
      status === 401 || status === 403
        ? "The Aimfox API key in Settings → Integrations → Aimfox is invalid, revoked, or Read-only — reconnect it with an \"All\" permission key."
        : `Check the campaign and LinkedIn account limits in Aimfox. Detail: ${message.slice(0, 300)}`,
      "aimfox_add_lead_failed",
    );
  }

  return {
    ...delivery,
    status: "activated",
    activatedAt: new Date().toISOString(),
    aimfoxLeadId: result.id ?? `aimfox_${delivery.prospectId.slice(-8)}`,
    source: "aimfox_live",
  };
}

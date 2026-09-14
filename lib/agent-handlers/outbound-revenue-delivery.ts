/**
 * Outbound Revenue's stage/activate split — pulled out of outbound-revenue.ts (which touches
 * Prisma and Anthropic) so this pure/network-injectable half can be imported into
 * test/content.test.ts without dragging a database client into the test bundle. Same reason
 * email-marketing-channels.ts and prospector-outreach.ts are their own files.
 */
import { AgentInputError } from "@/lib/ai/errors";
import { isChannelActivated } from "./email-marketing-channels";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_TIMEOUT_MS = 15_000;

type RevenueEvent = "email_reply" | "linkedin_reply" | "interested" | "meeting_booked";

/**
 * ---------------------------------------------------------------------------
 * Stage now, write to GHL on approval
 * ---------------------------------------------------------------------------
 *
 * The Revenue agent is triggered automatically by Instantly/Aimfox reply webhooks
 * (app/api/webhooks/instantly, app/api/webhooks/aimfox) — so unlike Email/LinkedIn Outbound,
 * nobody clicked "run" here. That makes gating this one more important, not less: a webhook
 * firing must never itself write a live CRM record. outbound-revenue.ts resolves the
 * pipeline/stage (read-only) and generates the exact contact/opportunity field values while
 * running, but the GHL writes — contact upsert and opportunity create — only happen from the
 * approval hook (lib/agent-handlers/on-approve.ts), after a workspace admin approves the run.
 */
export interface OutboundRevenueDelivery {
  status: "staged" | "activated";
  activatedAt?: string;
  prospectId: string;
  event: RevenueEvent;
  connected: boolean;
  locationId?: string;
  contact: Record<string, unknown>;
  wantsOpportunity: boolean;
  opportunity?: Record<string, unknown>;
  pipelineName?: string;
  stageName?: string;
  pipelineId?: string;
  pipelineStageId?: string;
  ghlContactId?: string;
  /** Set once an opportunity exists for this prospect — from this run's activation, or
   * (checked at activation time) an earlier run's. Creation is NOT idempotent on GHL's side,
   * so this is the guard against creating a second opportunity for the same prospect. */
  ghlOpportunityId?: string | null;
  source?: "ghl_live" | "simulation";
}

/** Pure — the exact body POST /contacts/upsert gets. GHL's upsert is idempotent by
 * (locationId, email), so this is safe to call every activation, even a retried one. */
export function buildGhlContactBody(delivery: OutboundRevenueDelivery): Record<string, unknown> {
  const contact = delivery.contact as Record<string, unknown>;
  return {
    locationId: delivery.locationId,
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email,
    companyName: contact.companyName,
    website: (contact.website as string | null | undefined) ?? undefined,
    tags: contact.tags,
  };
}

/** Pure — the exact body POST /opportunities/ gets. Only ever built when no opportunity yet
 * exists for this prospect (see activateOutboundRevenueDelivery). */
export function buildGhlOpportunityBody(delivery: OutboundRevenueDelivery, contactId: string): Record<string, unknown> {
  const opportunity = delivery.opportunity as Record<string, unknown> | undefined;
  return {
    pipelineId: delivery.pipelineId,
    locationId: delivery.locationId,
    name: (opportunity?.name as string | undefined) ?? `Dev.co — ${delivery.contact.companyName as string}`,
    pipelineStageId: delivery.pipelineStageId,
    status: "open",
    contactId,
    source: opportunity?.source,
  };
}

export async function ghlUpsertContact(authHeaders: Record<string, string>, body: Record<string, unknown>): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${GHL_BASE}/contacts/upsert`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GHL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`http_${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const json = (await res.json()) as { contact: { id: string } };
  return json.contact.id;
}

export async function ghlCreateOpportunity(authHeaders: Record<string, string>, body: Record<string, unknown>): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${GHL_BASE}/opportunities/`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GHL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`http_${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const json = (await res.json()) as { opportunity: { id: string } };
  return json.opportunity.id;
}

function ghlErrorHint(err: unknown, authFailureHint: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith("unreachable:")) {
    return "This is usually a transient network problem — approve the run again. If it keeps happening, check GoHighLevel's status page.";
  }
  const status = Number(message.match(/^http_(\d+)/)?.[1] ?? 0);
  if (status === 401 || status === 403) return authFailureHint;
  return `Check the fields and GoHighLevel account status. Detail: ${message.slice(0, 300)}`;
}

// GHL's v2 API is gated by a date-versioned header, not a version in the URL.
const GHL_VERSION = "2021-07-28";

/**
 * Upserts the GHL contact, then creates an opportunity ONLY if this event wants one and no
 * opportunity id is already recorded for this prospect — GHL's contact upsert is idempotent,
 * but opportunity creation is not, so a second approval attempt (or a webhook firing twice)
 * must never create a second opportunity. `existingOpportunityId` should be read fresh from the
 * OutboundProspect record at hook time — not from this run's own staged output — so it also
 * catches an opportunity created by a *different* run for the same prospect. `deps` are
 * injectable so this can be unit tested without a live token.
 */
export async function activateOutboundRevenueDelivery(
  delivery: OutboundRevenueDelivery,
  existingOpportunityId: string | null,
  deps: {
    apiKey?: string;
    locationId?: string;
    upsertContact?: typeof ghlUpsertContact;
    createOpportunity?: typeof ghlCreateOpportunity;
  } = {},
): Promise<OutboundRevenueDelivery> {
  if (isChannelActivated(delivery)) return delivery;

  if (!delivery.connected || !deps.apiKey || !deps.locationId) {
    return {
      ...delivery,
      status: "activated",
      activatedAt: new Date().toISOString(),
      ghlContactId: `ghl_contact_${delivery.prospectId.slice(-8)}`,
      ghlOpportunityId: delivery.wantsOpportunity ? existingOpportunityId ?? `ghl_opp_${delivery.prospectId.slice(-8)}_${Date.now()}` : existingOpportunityId,
      source: "simulation",
    };
  }

  const authHeaders = { Authorization: `Bearer ${deps.apiKey}`, Version: GHL_VERSION, "Content-Type": "application/json" };
  const upsertContact = deps.upsertContact ?? ghlUpsertContact;
  const createOpportunity = deps.createOpportunity ?? ghlCreateOpportunity;

  let contactId: string;
  try {
    contactId = await upsertContact(authHeaders, buildGhlContactBody({ ...delivery, locationId: deps.locationId }));
  } catch (err) {
    throw new AgentInputError(
      `GoHighLevel rejected creating a contact for ${delivery.contact.email as string}.`,
      ghlErrorHint(
        err,
        "The GoHighLevel private integration token or location ID in Settings → Integrations → GoHighLevel is wrong, revoked, or not authorised for this location — reconnect it there.",
      ),
      "ghl_upsert_contact_failed",
    );
  }

  let opportunityId = existingOpportunityId;
  if (delivery.wantsOpportunity && !opportunityId) {
    try {
      opportunityId = await createOpportunity(authHeaders, buildGhlOpportunityBody({ ...delivery, locationId: deps.locationId }, contactId));
    } catch (err) {
      throw new AgentInputError(
        `GoHighLevel rejected creating an opportunity for ${delivery.contact.companyName as string}.`,
        ghlErrorHint(err, "The GoHighLevel private integration token or location ID in Settings → Integrations → GoHighLevel is wrong or revoked — reconnect it there."),
        "ghl_create_opportunity_failed",
      );
    }
  }

  return {
    ...delivery,
    status: "activated",
    activatedAt: new Date().toISOString(),
    ghlContactId: contactId,
    ghlOpportunityId: opportunityId,
    source: "ghl_live",
  };
}

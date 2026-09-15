/**
 * Email Marketing's three newer delivery channels — Instantly, Apollo, and the erp.io CRM — on
 * top of the existing Mailchimp/Klaviyo draft creation in esp-providers.ts.
 *
 * ---------------------------------------------------------------------------
 * Stage now, activate on approval — the same shape for all three
 * ---------------------------------------------------------------------------
 *
 * The email-marketing handler calls `stage*()` while the run is producing output (before
 * `AWAITING_APPROVAL`). Each one creates something real but inert in the target system — a
 * Draft-status Instantly campaign with no leads, an Apollo sequence created with `active: false`
 * and no contacts, a DRAFT CRM Sequence with no enrollments — and never anything that can send
 * mail on its own. What each created is written onto the run's `output`.
 *
 * `activate*()` is called exactly once, from the generic on-approve registry
 * (lib/agent-handlers/on-approve.ts), after a human approves the run. It reads the ids `stage*()`
 * recorded on `output`, adds the audience, and flips the campaign/sequence live. Every
 * `activate*()` is idempotent: it checks `isChannelActivated()` first and no-ops if this output
 * was already activated, so a retried or duplicated approval call never enrolls or sends twice.
 */

import { AgentInputError } from "@/lib/ai/errors";
import {
  createInstantlyCampaign,
  activateInstantlyCampaign as activateInstantlyCampaignApi,
  moveInstantlyLeadsToCampaign,
  type InstantlySequenceStep,
  type CreateInstantlyCampaignInput,
} from "@/lib/integrations/instantly";
import {
  apolloCreateSequence,
  apolloContactsSearch,
  apolloAddContactsToSequence,
  type ApolloEmailStep,
} from "@/lib/integrations/apollo";
import { crmCreateSequence, crmActivateSequence, DEFAULT_CRM_URL, type CrmSequenceStep, type CrmTarget } from "@/lib/integrations/crm-erp-io";

// ---------------------------------------------------------------------------
// Pure helpers — no network, no DB. Unit tested in test/content.test.ts.
// ---------------------------------------------------------------------------

/** Turns the campaign generator's `emailSequence` into the {subject, body, delayDays} shape every
 * channel's step-creation call needs. Emails with no usable body are dropped rather than staged
 * empty — an empty step is a defect the customer would only find in the target platform's editor. */
export function emailSequenceToSteps(
  emailSequence: unknown,
): Array<{ subject: string; body: string; delayDays: number }> {
  if (!Array.isArray(emailSequence)) return [];
  return emailSequence
    .map((raw, i) => {
      const e = (raw ?? {}) as Record<string, unknown>;
      const subjectLine = typeof e.subjectLine === "string" ? e.subjectLine.trim() : "";
      const bodyHtml = typeof e.bodyHtml === "string" ? e.bodyHtml.trim() : "";
      return {
        subject: subjectLine || `Email ${i + 1}`,
        body: bodyHtml,
        delayDays: parseSendDelay(e.sendDelay, i),
      };
    })
    .filter((step) => step.body.length > 0);
}

/** "Immediately" / "Day 3" / "Day 7" (the generator's own vocabulary, see email-marketing.ts's
 * prompt) → a day count. Unrecognised text falls back to 0 for the first step and 1 for every
 * step after it — same floor sequence-admin.ts enforces on the CRM side, so a channel that shares
 * that rule never gets a step rejected at activation for arriving with too short a gap. */
function parseSendDelay(sendDelay: unknown, index: number): number {
  const floor = index === 0 ? 0 : 1;
  if (typeof sendDelay !== "string") return floor;
  if (/immediat/i.test(sendDelay)) return index === 0 ? 0 : floor;
  const match = sendDelay.match(/(\d+)/);
  if (!match) return floor;
  return Math.max(floor, parseInt(match[1], 10));
}

/** A run's staged channel output is "activated" once `activatedAt` is set — the one thing every
 * `activate*()` below checks before doing anything that could enroll or send. */
export function isChannelActivated(channelOutput: unknown): boolean {
  return Boolean(
    channelOutput &&
      typeof channelOutput === "object" &&
      typeof (channelOutput as Record<string, unknown>).activatedAt === "string",
  );
}

/** Splits a newline/comma-separated list of addresses (the Apollo audience field) into deduped,
 * validated emails. Apollo has no "list id" concept comparable to Mailchimp/Klaviyo/Instantly —
 * only saved Contacts and Sequences — so the audience for this channel is the literal set of
 * addresses to enroll, each resolved to a Contact id at activation time. */
export function parseAudienceEmails(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\n,]+/)) {
    const email = part.trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) seen.add(email);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Instantly
// ---------------------------------------------------------------------------

export interface InstantlyChannelOutput {
  campaignId: string;
  /** The Lead List id (existing in the customer's Instantly account) whose leads move into the
   * campaign at activation — Instantly has no "campaign contains a saved list" concept, so the
   * leads are moved in, not referenced. */
  listId: string;
  status: "staged" | "activated";
  activatedAt?: string;
}

export async function stageInstantlyCampaign(
  apiKey: string,
  input: {
    campaignName: string;
    steps: InstantlySequenceStep[];
    listId: string;
    sendDayOfWeek?: CreateInstantlyCampaignInput["sendDayOfWeek"];
  },
): Promise<InstantlyChannelOutput> {
  if (!input.listId) {
    throw new AgentInputError(
      "Instantly is selected as the Email Platform, but no Audience or List ID was given.",
      "Set Audience or List ID to an existing Instantly Lead List — find it under Leads → Lists in Instantly. That list's leads move into the new campaign once this run is approved.",
      "instantly_no_list",
    );
  }
  if (input.steps.length === 0) {
    throw new AgentInputError(
      "The generated campaign had no usable email steps to stage in Instantly.",
      "Try running Email Marketing again — this is usually a one-off generation issue.",
      "instantly_no_steps",
    );
  }

  let campaignId: string;
  try {
    campaignId = await createInstantlyCampaign(apiKey, {
      name: input.campaignName,
      steps: input.steps,
      sendDayOfWeek: input.sendDayOfWeek,
    });
  } catch (err) {
    throw new AgentInputError(
      `Instantly rejected creating the campaign "${input.campaignName}".`,
      instantlyErrorHint(err),
      "instantly_create_campaign_failed",
    );
  }

  return { campaignId, listId: input.listId, status: "staged" };
}

function instantlyErrorHint(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith("unreachable:")) {
    return "This is usually a transient network problem — try running Email Marketing again. If it keeps happening, check Instantly's status page.";
  }
  if (message.startsWith("http_401") || message.startsWith("http_403")) {
    return "The Instantly API key in Settings → Integrations → Instantly is invalid, revoked, or not a v2 key — reconnect it there.";
  }
  return `Check the Instantly account status in Settings → Integrations. Detail: ${message.slice(0, 300)}`;
}

/** Moves the configured list's leads into the staged campaign, then activates it. Only ever
 * called from the approval hook. */
export async function activateInstantlyChannel(
  apiKey: string,
  channel: InstantlyChannelOutput,
): Promise<InstantlyChannelOutput> {
  if (isChannelActivated(channel)) return channel;

  try {
    await moveInstantlyLeadsToCampaign(apiKey, channel.listId, channel.campaignId);
    await activateInstantlyCampaignApi(apiKey, channel.campaignId);
  } catch (err) {
    throw new AgentInputError(
      `Instantly rejected activating campaign ${channel.campaignId}.`,
      instantlyErrorHint(err),
      "instantly_activate_failed",
    );
  }

  return { ...channel, status: "activated", activatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Apollo
// ---------------------------------------------------------------------------

export interface ApolloChannelOutput {
  sequenceId: string;
  audienceEmails: string[];
  senderAccountId: string;
  status: "staged" | "activated";
  activatedAt?: string;
  enrolled?: string[];
  skipped?: string[];
}

export async function stageApolloSequence(
  apiKey: string,
  input: { sequenceName: string; steps: ApolloEmailStep[]; audienceEmails: string[]; senderAccountId: string },
): Promise<ApolloChannelOutput> {
  if (input.steps.length === 0) {
    throw new AgentInputError(
      "The generated campaign had no usable email steps to stage in Apollo.",
      "Try running Email Marketing again — this is usually a one-off generation issue.",
      "apollo_no_steps",
    );
  }
  if (input.audienceEmails.length === 0) {
    throw new AgentInputError(
      "Apollo is selected as the Email Platform, but no audience emails were given.",
      "Set Audience or List ID to one or more email addresses already saved as Contacts in Apollo, one per line.",
      "apollo_no_audience",
    );
  }
  if (!input.senderAccountId) {
    throw new AgentInputError(
      "Apollo is selected as the Email Platform, but no sender account was given.",
      "Set the Sender Account ID field to the Apollo-connected mailbox this sequence should send from — find it under Settings → Mailboxes in Apollo.",
      "apollo_no_sender",
    );
  }

  let res: Response;
  try {
    res = await apolloCreateSequence(apiKey, input.sequenceName, input.steps);
  } catch (err) {
    throw new AgentInputError(
      `Couldn't reach Apollo.io to create the sequence "${input.sequenceName}".`,
      "This is usually a transient network problem — try running Email Marketing again. If it keeps happening, check Apollo's status page.",
      "apollo_unreachable",
    );
  }
  if (!res.ok) {
    throw new AgentInputError(
      `Apollo.io rejected creating the sequence "${input.sequenceName}" (HTTP ${res.status}).`,
      apolloErrorHint(res.status),
      "apollo_create_sequence_failed",
    );
  }

  const body = (await res.json()) as { id?: string };
  if (!body.id) {
    throw new AgentInputError(
      "Apollo.io accepted the sequence create call but did not return a sequence id.",
      "Check the sequence in Apollo directly — it may have been created without steps.",
      "apollo_create_sequence_no_id",
    );
  }

  return {
    sequenceId: body.id,
    audienceEmails: input.audienceEmails,
    senderAccountId: input.senderAccountId,
    status: "staged",
  };
}

function apolloErrorHint(status: number): string {
  if (status === 401 || status === 403) {
    return "The Apollo API key in Settings → Integrations → Apollo.io is invalid, revoked, or lacks the Master API Key permission this call requires — reconnect it with a master key from Apollo's own API settings.";
  }
  return "Check the Apollo.io account (plan, rate limits) in Settings → Integrations, then try again.";
}

/**
 * Resolves each configured email to an Apollo Contact id, then adds every one it found to the
 * sequence with the configured sender — the call that actually starts sending. Emails Apollo has
 * no saved Contact for are recorded under `skipped`, not silently dropped. Only ever called from
 * the approval hook.
 */
export async function activateApolloSequence(
  apiKey: string,
  channel: ApolloChannelOutput,
): Promise<ApolloChannelOutput> {
  if (isChannelActivated(channel)) return channel;

  const contactIds: string[] = [];
  const skipped: string[] = [];
  for (const email of channel.audienceEmails) {
    let res: Response;
    try {
      res = await apolloContactsSearch(apiKey, email);
    } catch {
      skipped.push(email);
      continue;
    }
    if (!res.ok) {
      skipped.push(email);
      continue;
    }
    const body = (await res.json()) as { contacts?: Array<{ id?: string }> };
    const id = body.contacts?.[0]?.id;
    if (id) contactIds.push(id);
    else skipped.push(email);
  }

  if (contactIds.length === 0) {
    throw new AgentInputError(
      `None of the ${channel.audienceEmails.length} configured email(s) matched a saved Contact in Apollo.`,
      "Every address in Audience or List ID must already exist as a Contact in Apollo (Apollo → Contacts) before this agent can enroll them — add them there first, then approve again.",
      "apollo_no_matching_contacts",
    );
  }

  let res: Response;
  try {
    res = await apolloAddContactsToSequence(apiKey, channel.sequenceId, {
      contactIds,
      sendEmailFromEmailAccountId: channel.senderAccountId,
    });
  } catch (err) {
    throw new AgentInputError(
      `Couldn't reach Apollo.io to enroll contacts in sequence ${channel.sequenceId}.`,
      "This is usually a transient network problem — approve the run again. If it keeps happening, check Apollo's status page.",
      "apollo_unreachable",
    );
  }
  if (!res.ok) {
    throw new AgentInputError(
      `Apollo.io rejected enrolling contacts in sequence ${channel.sequenceId} (HTTP ${res.status}).`,
      res.status === 401 || res.status === 403
        ? "Adding contacts to a sequence requires a Master API Key (or the api/v1/emailer_campaigns/add_contact_ids scope) — the connected Apollo key doesn't have it. Reconnect Apollo with a master key in Settings → Integrations."
        : apolloErrorHint(res.status),
      "apollo_add_contacts_failed",
    );
  }

  return {
    ...channel,
    status: "activated",
    activatedAt: new Date().toISOString(),
    enrolled: contactIds,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// erp.io CRM
// ---------------------------------------------------------------------------

export interface CrmChannelOutput {
  crmUrl: string;
  /** How it was staged: a signed org assertion (normal) or a legacy API key. Absent on older runs = key. */
  auth?: "service" | "key";
  sequenceId: string;
  segmentId: string;
  status: "staged" | "activated";
  activatedAt?: string;
  activationResult?: { enrolled: number; segmentSize: number; skipped: Array<{ personId: string; reason: string }> };
}

export async function stageCrmSequence(
  target: CrmTarget,
  input: { name: string; fromAddress?: string; fromName?: string; steps: CrmSequenceStep[]; segmentId: string },
): Promise<CrmChannelOutput> {
  if (!input.segmentId) {
    throw new AgentInputError(
      "erp.io CRM is selected as the Email Platform, but no Segment ID was given.",
      "Set Audience or List ID to a Contact Segment ID from the CRM (Contacts → Segments in app.erp.io/crm).",
      "crm_no_segment",
    );
  }
  if (input.steps.length === 0) {
    throw new AgentInputError(
      "The generated campaign had no usable email steps to stage in the CRM.",
      "Try running Email Marketing again — this is usually a one-off generation issue.",
      "crm_no_steps",
    );
  }

  let res: Response;
  try {
    res = await crmCreateSequence(target, {
      name: input.name,
      fromAddress: input.fromAddress,
      fromName: input.fromName,
      steps: input.steps,
    });
  } catch (err) {
    throw new AgentInputError(
      `Couldn't reach the erp.io CRM at ${target.baseUrl} to stage the sequence.`,
      "This is usually a transient network problem — try running Email Marketing again.",
      "crm_unreachable",
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new AgentInputError(
      `The erp.io CRM rejected staging the sequence (HTTP ${res.status}).`,
      res.status === 401
        ? target.auth.kind === "service"
          ? "The CRM didn't accept this server's signature — MARKETING_SERVICE_PUBLIC_KEY on the CRM must match. Settings → Integrations → erp.io CRM shows the link status."
          : "The CRM API key in Settings → Integrations → erp.io CRM is invalid or has been revoked — reconnect it there."
        : res.status === 404
          ? `This organization has no CRM workspace yet, or the CRM URL is wrong. Detail: ${detail.slice(0, 300)}`
          : `Check the CRM connection in Settings → Integrations, then try again. Detail: ${detail.slice(0, 300)}`,
      "crm_stage_failed",
    );
  }

  const body = (await res.json()) as { sequenceId?: string };
  if (!body.sequenceId) {
    throw new AgentInputError(
      "The erp.io CRM accepted the sequence create call but did not return a sequence id.",
      "Check the sequence in the CRM directly.",
      "crm_stage_no_id",
    );
  }

  return { crmUrl: target.baseUrl, auth: target.auth.kind, sequenceId: body.sequenceId, segmentId: input.segmentId, status: "staged" };
}

/** Flips the sequence DRAFT → ACTIVE and enrolls the configured segment. The CRM route this
 * calls is itself idempotent (see crm-erp-io's activate route), but `isChannelActivated` is
 * checked first anyway so a second approval attempt doesn't even make the call. */
export async function activateCrmSequence(target: CrmTarget, channel: CrmChannelOutput): Promise<CrmChannelOutput> {
  if (isChannelActivated(channel)) return channel;

  let res: Response;
  try {
    // The target is resolved at approval time, not replayed from the staged output: a signed
    // assertion goes only to this server's configured CRM. The CRM re-checks that the sequence and
    // segment belong to the tenant the credential resolves to, so a workspace re-linked since
    // staging gets a clean 404 rather than someone else's sequence.
    res = await crmActivateSequence(target, channel.sequenceId, channel.segmentId);
  } catch (err) {
    throw new AgentInputError(
      `Couldn't reach the erp.io CRM at ${target.baseUrl} to activate sequence ${channel.sequenceId}.`,
      "This is usually a transient network problem — approve the run again.",
      "crm_unreachable",
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new AgentInputError(
      `The erp.io CRM rejected activating sequence ${channel.sequenceId} (HTTP ${res.status}).`,
      res.status === 422
        ? `The CRM refused activation: ${detail.slice(0, 300)}`
        : `Check the CRM connection in Settings → Integrations, then try again. Detail: ${detail.slice(0, 300)}`,
      "crm_activate_failed",
    );
  }

  const body = (await res.json()) as { enrolled?: number; segmentSize?: number; skipped?: Array<{ personId: string; reason: string }> };
  return {
    ...channel,
    status: "activated",
    activatedAt: new Date().toISOString(),
    activationResult: {
      enrolled: body.enrolled ?? 0,
      segmentSize: body.segmentSize ?? 0,
      skipped: body.skipped ?? [],
    },
  };
}

export { DEFAULT_CRM_URL };

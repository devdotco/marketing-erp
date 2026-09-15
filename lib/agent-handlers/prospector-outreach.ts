/**
 * Prospector's optional Instantly outreach step.
 *
 * Same stage-then-activate shape as Email Marketing's channels
 * (lib/agent-handlers/email-marketing-channels.ts), but simpler: Prospector already produces its
 * own prospect list with contact info, so there is no separate "Lead List" to move in at
 * activation — every eligible prospect is added directly to the campaign while it is still in
 * Instantly's Draft status (status 0), which Instantly never sends from. Approval only flips
 * Draft → Active (lib/integrations/instantly.ts's activateInstantlyCampaign, the same
 * POST /campaigns/{id}/activate call Email Marketing's Instantly channel uses).
 *
 * Verified against developer.instantly.ai (2026-09-14):
 *  - POST /api/v2/campaigns: "Newly created campaigns default to Draft status (status: 0) ... No
 *    separate activation call is documented [here]; campaigns must transition from Draft through
 *    your platform's UI or an update endpoint before sending begins" — the update endpoint is
 *    POST /api/v2/campaigns/{id}/activate ("Activate (start), or resume a campaign").
 *  - POST /api/v2/leads: adding a lead to a campaign "does not trigger campaign delivery" — it
 *    only adds the lead; nothing sends until the campaign itself is activated.
 *  - Personalization variables use {{variableName}} syntax; {{firstName}} is a core variable and
 *    anything else (e.g. {{targetPage}}, {{reason}}) is a custom variable carried per-lead in
 *    `custom_variables`.
 *  - GET /api/v2/accounts lists the workspace's connected sending mailboxes and supports a
 *    `search` filter — used here to confirm a configured Sending Account actually exists before
 *    staging, rather than finding out only when activation fails.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { AgentInputError } from "@/lib/ai/errors";
import { createMessage } from "@/lib/ai/messages";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { strictSchema } from "@/lib/content/article";
import type { EditorialProfile } from "@/lib/content/editorial";
import {
  createInstantlyCampaign,
  activateInstantlyCampaign as activateInstantlyCampaignApi,
  addInstantlyLead,
  listInstantlyAccounts,
  type InstantlySequenceStep,
  type CreateInstantlyCampaignInput,
} from "@/lib/integrations/instantly";
import { isChannelActivated } from "./email-marketing-channels";

// ---------------------------------------------------------------------------
// Lead filtering — pure, no network. Unit tested in test/content.test.ts.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Local parts that mean "this inbox isn't a person" — a link-building pitch to info@ or
 * noreply@ reads as spam and burns sender reputation for nothing. Prospector's own schema
 * (lib/agent-handlers/prospector.ts) has no field marking a generic address as "the right
 * contact anyway", so — documented decision — every one of these is always skipped, never sent. */
const ROLE_LOCAL_PARTS = new Set([
  "info", "noreply", "no-reply", "donotreply", "do-not-reply", "support", "admin", "administrator",
  "hello", "contact", "sales", "team", "webmaster", "help", "office", "enquiries", "inquiries",
  "press", "media", "abuse", "postmaster", "marketing", "billing",
]);

export function isRoleEmail(email: string): boolean {
  const local = email.split("@")[0]?.toLowerCase().trim() ?? "";
  return ROLE_LOCAL_PARTS.has(local);
}

export interface ProspectRecord {
  domain?: unknown;
  pageUrl?: unknown;
  contactEmail?: unknown;
  contactName?: unknown;
  outreachAngle?: unknown;
  linkPlacementOpportunity?: unknown;
}

export interface OutreachLead {
  email: string;
  firstName: string;
  companyName: string;
  domain: string;
  /** Instantly custom_variables — the personalization tokens the generated sequence references
   * as {{targetPage}} and {{reason}}, filled in per-lead. */
  customVariables: { targetPage: string; reason: string; companyName: string };
}

export interface SkippedProspect {
  domain: string;
  email?: string;
  reason: string;
}

/**
 * Filters Prospector's own `prospects` output down to leads worth staging in Instantly: a real,
 * well-formed, non-role email, deduped, capped at `cap` per run. Every prospect that doesn't make
 * the cut is recorded with a reason rather than silently dropped, so the run's output shows the
 * whole decision, not just the survivors.
 */
export function filterProspectsForOutreach(
  prospects: unknown,
  cap = 100,
): { leads: OutreachLead[]; skipped: SkippedProspect[] } {
  const leads: OutreachLead[] = [];
  const skipped: SkippedProspect[] = [];
  if (!Array.isArray(prospects)) return { leads, skipped };

  const seen = new Set<string>();
  for (const raw of prospects) {
    const p = (raw ?? {}) as ProspectRecord;
    const domain = typeof p.domain === "string" && p.domain.trim() ? p.domain.trim() : "unknown domain";
    const emailRaw = typeof p.contactEmail === "string" ? p.contactEmail.trim().toLowerCase() : "";

    if (!emailRaw) {
      skipped.push({ domain, reason: "no contact email on this prospect" });
      continue;
    }
    if (!EMAIL_RE.test(emailRaw)) {
      skipped.push({ domain, email: emailRaw, reason: "malformed email address" });
      continue;
    }
    if (seen.has(emailRaw)) {
      skipped.push({ domain, email: emailRaw, reason: "duplicate email — already staged from another prospect" });
      continue;
    }
    if (isRoleEmail(emailRaw)) {
      skipped.push({
        domain,
        email: emailRaw,
        reason: "role/generic address (info@, noreply@, etc.) — skipped by default; Prospector has no signal marking it as the right contact",
      });
      continue;
    }
    if (leads.length >= cap) {
      skipped.push({ domain, email: emailRaw, reason: `over the ${cap}-lead cap for this run` });
      continue;
    }

    seen.add(emailRaw);
    const contactName = typeof p.contactName === "string" ? p.contactName.trim() : "";
    const firstName = contactName.split(/\s+/)[0] || "there";
    const targetPage = typeof p.pageUrl === "string" && p.pageUrl.trim() ? p.pageUrl.trim() : `https://${domain}`;
    const reason =
      (typeof p.linkPlacementOpportunity === "string" && p.linkPlacementOpportunity.trim()) ||
      (typeof p.outreachAngle === "string" && p.outreachAngle.trim()) ||
      "a relevant page on your site";

    leads.push({
      email: emailRaw,
      firstName,
      companyName: domain,
      domain,
      customVariables: { targetPage, reason, companyName: domain },
    });
  }

  return { leads, skipped };
}

// ---------------------------------------------------------------------------
// Sequence copy generation — one strict tool call.
// ---------------------------------------------------------------------------

export const SUBMIT_OUTREACH_SEQUENCE_TOOL_NAME = "submit_outreach_sequence";

export const SUBMIT_OUTREACH_SEQUENCE_TOOL = {
  name: SUBMIT_OUTREACH_SEQUENCE_TOOL_NAME,
  strict: true,
  description:
    "Submit the finished cold-outreach email sequence. Each step is one email in the sequence, sent in order.",
  input_schema: strictSchema({
    type: "object",
    required: ["steps"],
    properties: {
      steps: {
        type: "array",
        description: "The sequence, in send order. Never empty.",
        minItems: 1,
        items: {
          type: "object",
          required: ["subject", "body"],
          properties: {
            subject: { type: "string", description: "Plain, specific subject line — no clickbait, no spam-trigger punctuation." },
            body: {
              type: "string",
              description:
                'Plain-text-friendly email body. Use "{{firstName}}", "{{companyName}}", "{{targetPage}}", and "{{reason}}" as Instantly personalization tokens wherever the copy needs them — never invent other token names. Use blank lines between paragraphs (no HTML tags). End with a one-line opt-out ("Let me know if you\'d rather not hear from me again" or similar).',
            },
          },
        },
      },
    },
  }),
} as Anthropic.Tool;

export interface SequenceStep {
  subject: string;
  body: string;
}

/** Runs the writer to a complete submit_outreach_sequence call. Forces the tool (no web search,
 * no free text) so a run always gets a usable sequence or a clear thrown error — never a partial
 * one silently treated as complete. */
export async function generateOutreachSequence(
  client: Anthropic,
  input: {
    steps: number;
    outreachAngle: string;
    offer: string;
    senderName: string;
    senderSignature: string;
    profile: EditorialProfile;
  },
): Promise<{ steps: SequenceStep[]; costUsd: number }> {
  const p = input.profile;
  const system = [
    "You write short, specific cold-outreach emails for link building — never generic outsourcing or link-begging language.",
    "Never fabricate a claim, a relationship, or a fact about the recipient's site you were not given.",
    `Voice: ${p.voiceSummary}`,
    p.useContractions ? "Use contractions." : "Do not use contractions.",
    p.bannedWords.length > 0 ? `Never use these words: ${p.bannedWords.join(", ")}.` : "",
    p.bannedPhrases.length > 0 ? `Never use these phrases: ${p.bannedPhrases.join(", ")}.` : "",
    "Every step must end with a one-line opt-out (e.g. \"Reply and let me know if you'd rather not hear from me again\").",
    "Return ONLY the submit_outreach_sequence tool call — no other text.",
  ].filter(Boolean).join("\n");

  const userPrompt = [
    `Write a ${input.steps}-step cold outreach sequence for link building.`,
    input.outreachAngle ? `Overall angle: ${input.outreachAngle}` : "",
    input.offer ? `What we're offering: ${input.offer}` : "",
    `Sender: ${input.senderName || "the outreach sender"}`,
    input.senderSignature ? `Sign every email off with:\n${input.senderSignature}` : "",
    "",
    "Use {{firstName}}, {{companyName}}, {{targetPage}}, and {{reason}} as personalization tokens — {{targetPage}} is the page on the prospect's site we're asking about, {{reason}} is the specific placement opportunity or angle for that prospect. These are filled in per-recipient; write the copy so it reads naturally with any values in those slots.",
    "Each step after the first should reference that this is a follow-up, vary its angle from the previous step, and stay short.",
  ].filter(Boolean).join("\n");

  const message = await createMessage(client, {
    model: MODELS.standard,
    max_tokens: 4096,
    system,
    tools: [SUBMIT_OUTREACH_SEQUENCE_TOOL],
    tool_choice: { type: "tool", name: SUBMIT_OUTREACH_SEQUENCE_TOOL_NAME },
    messages: [{ role: "user", content: userPrompt }],
  });

  const costUsd = estimateCostUsd(MODELS.standard, message.usage);
  const block = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === SUBMIT_OUTREACH_SEQUENCE_TOOL_NAME,
  );
  if (!block) throw new Error("The outreach sequence writer did not submit a sequence.");

  const submitted = block.input as { steps?: Array<{ subject?: string; body?: string }> };
  const steps = sequenceStepsFromSubmission(submitted.steps);
  if (steps.length === 0) throw new Error("The outreach sequence writer returned no usable steps.");

  return { steps, costUsd };
}

/** Pure normalisation of the tool call's raw input — split out so the schema-shape half of
 * generateOutreachSequence is unit-testable without a live model call. */
export function sequenceStepsFromSubmission(raw: Array<{ subject?: string; body?: string }> | undefined): SequenceStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => ({ subject: (s?.subject ?? "").trim(), body: (s?.body ?? "").trim() }))
    .filter((s) => s.subject.length > 0 && s.body.length > 0);
}

// ---------------------------------------------------------------------------
// Send-day / send-window inputs → Instantly's campaign_schedule shape.
// ---------------------------------------------------------------------------

const SEND_DAYS: readonly NonNullable<CreateInstantlyCampaignInput["sendDayOfWeek"]>[] = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

export function coerceSendDay(value: unknown): CreateInstantlyCampaignInput["sendDayOfWeek"] {
  return SEND_DAYS.find((day) => day === value);
}

const SEND_WINDOWS: Record<string, { from: string; to: string }> = {
  "9am–5pm (default)": { from: "09:00", to: "17:00" },
  "8am–6pm": { from: "08:00", to: "18:00" },
  "7am–7pm": { from: "07:00", to: "19:00" },
  "10am–3pm": { from: "10:00", to: "15:00" },
};

export function resolveSendWindow(label: unknown): { from: string; to: string } {
  if (typeof label === "string" && SEND_WINDOWS[label]) return SEND_WINDOWS[label];
  return SEND_WINDOWS["9am–5pm (default)"];
}

// ---------------------------------------------------------------------------
// Staging (run time — nothing sends) and activation (approval only).
// ---------------------------------------------------------------------------

export interface ProspectorInstantlyChannel {
  campaignId: string;
  status: "staged" | "activated";
  leadCount: number;
  addedLeads: Array<{ email: string; domain: string; leadId: string }>;
  skipped: SkippedProspect[];
  sendingAccounts: string[];
  invalidSendingAccounts?: string[];
  sequence: Array<{ subject: string; body: string; delayDays: number }>;
  leadErrors?: string[];
  activatedAt?: string;
}

function instantlyErrorHint(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith("unreachable:")) {
    return "This is usually a transient network problem — try running Prospector again. If it keeps happening, check Instantly's status page.";
  }
  if (message.startsWith("http_401") || message.startsWith("http_403")) {
    return "The Instantly API key in Settings → Integrations → Instantly is invalid, revoked, or not a v2 key — reconnect it there.";
  }
  return `Check the Instantly account status in Settings → Integrations. Detail: ${message.slice(0, 300)}`;
}

/**
 * Creates the campaign in Draft, then adds every eligible lead directly to it while it is still
 * unactivated — see the module docstring for why this never sends. Per-lead failures are
 * collected into `leadErrors` rather than aborting the whole stage: a campaign with 94 of 100
 * leads added is still worth reviewing, not worth discarding because 6 addresses bounced the
 * call.
 */
export async function stageProspectorInstantlyCampaign(
  apiKey: string,
  input: {
    campaignName: string;
    steps: SequenceStep[];
    stepDelayDays: number;
    leads: OutreachLead[];
    skipped: SkippedProspect[];
    sendingAccounts: string[];
    sendDayOfWeek?: CreateInstantlyCampaignInput["sendDayOfWeek"];
    timing?: { from: string; to: string };
    timezone?: string;
  },
): Promise<ProspectorInstantlyChannel> {
  if (input.steps.length === 0) {
    throw new AgentInputError(
      "The generated sequence had no usable email steps to stage in Instantly.",
      "Try running Prospector again — this is usually a one-off generation issue.",
      "instantly_no_steps",
    );
  }
  if (input.leads.length === 0) {
    throw new AgentInputError(
      "None of this run's prospects had a real, well-formed, non-generic email address to stage in Instantly.",
      "Check the skipped list in this run's output — widen Topical Keywords or lower Minimum Domain Authority to surface prospects with named contacts, or add outreach targets by hand in Instantly.",
      "instantly_no_leads",
    );
  }

  let sendingAccounts = input.sendingAccounts;
  let invalidSendingAccounts: string[] | undefined;
  if (input.sendingAccounts.length > 0) {
    try {
      const known = new Set((await listInstantlyAccounts(apiKey)).map((a) => a.email.toLowerCase()));
      const valid = input.sendingAccounts.filter((e) => known.has(e.toLowerCase()));
      const invalid = input.sendingAccounts.filter((e) => !known.has(e.toLowerCase()));
      if (invalid.length > 0) invalidSendingAccounts = invalid;
      if (valid.length === 0) {
        throw new AgentInputError(
          `None of the configured Sending Accounts (${input.sendingAccounts.join(", ")}) are connected mailboxes in this workspace's Instantly account.`,
          "Check Sending Accounts against the connected mailboxes under Instantly → Settings → Email Accounts, or connect the mailbox in Instantly first.",
          "instantly_no_valid_sending_accounts",
        );
      }
      sendingAccounts = valid;
    } catch (err) {
      if (err instanceof AgentInputError) throw err;
      // The list call itself failed (transient, or a scoped key) — validation is a nice-to-have,
      // not a hard gate; Instantly's own activation step still enforces this for real.
    }
  }

  const instantlySteps: Array<{ subject: string; body: string; delayDays: number }> = input.steps.map((s, i) => ({
    subject: s.subject,
    body: s.body,
    delayDays: i === 0 ? 0 : input.stepDelayDays,
  }));

  let campaignId: string;
  try {
    campaignId = await createInstantlyCampaign(apiKey, {
      name: input.campaignName,
      steps: instantlySteps,
      emailList: sendingAccounts,
      sendDayOfWeek: input.sendDayOfWeek,
      timing: input.timing,
      timezone: input.timezone,
    });
  } catch (err) {
    throw new AgentInputError(
      `Instantly rejected creating the campaign "${input.campaignName}".`,
      instantlyErrorHint(err),
      "instantly_create_campaign_failed",
    );
  }

  const addedLeads: ProspectorInstantlyChannel["addedLeads"] = [];
  const leadErrors: string[] = [];
  for (const lead of input.leads) {
    try {
      const res = await addInstantlyLead(apiKey, {
        campaign: campaignId,
        email: lead.email,
        first_name: lead.firstName,
        company_name: lead.companyName,
        personalization: lead.customVariables.reason,
        custom_variables: lead.customVariables,
      });
      addedLeads.push({ email: lead.email, domain: lead.domain, leadId: res.id });
    } catch (err) {
      leadErrors.push(`${lead.email}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    campaignId,
    status: "staged",
    leadCount: addedLeads.length,
    addedLeads,
    skipped: input.skipped,
    sendingAccounts,
    invalidSendingAccounts,
    sequence: instantlySteps,
    leadErrors: leadErrors.length > 0 ? leadErrors : undefined,
  };
}

/** Flips Draft → Active. Only ever called from the approval hook (lib/agent-handlers/on-approve.ts).
 * Idempotent via isChannelActivated (email-marketing-channels.ts): a retried or duplicated
 * approval call never activates twice. Rejecting a run never calls this at all — see
 * app/api/runs/[runId]/reject/route.ts, which makes no Instantly call — so a rejected Prospector
 * run's campaign is left exactly as staged, in Draft, in Instantly. That's the deliberately safer
 * of the two options the run could take on reject: nothing is deleted out from under a person who
 * might still want to launch it by hand from inside Instantly. */
export async function activateProspectorInstantlyChannel(
  apiKey: string,
  channel: ProspectorInstantlyChannel,
): Promise<ProspectorInstantlyChannel> {
  if (isChannelActivated(channel)) return channel;

  try {
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

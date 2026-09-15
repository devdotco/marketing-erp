/**
 * Instantly and Aimfox webhook deliveries — the pure half: parse a vendor payload, map it onto the
 * Outbound Engine's own events, pick the prospect it is about, and decide what to write. No Prisma,
 * no Next: test/content.test.ts imports this directly, and lib/webhooks/receive.ts wires it to the
 * database.
 *
 * Why this exists (2026-09-15): the handlers read `event` / `leadId` / `email`, which no real
 * delivery carries. Both vendors send `event_type`, with different names and nesting:
 *
 * Instantly (https://developer.instantly.ai/guides/webhook-events): a flat object —
 *   { timestamp, event_type, workspace, campaign_id, campaign_name, lead_email?, email_account?,
 *     unibox_url?, step?, variant?, is_first?, email_id?, email_subject?, email_text?, email_html?,
 *     reply_text_snippet?, reply_subject?, reply_text?, reply_html?, ...lead fields }
 *   There is no event id and no lead id in the documented payload. `email_account` is OUR sending
 *   mailbox, never the lead. Custom lead labels arrive as their raw label text in `event_type`.
 *   Deliveries are retried (the WebhookEvent API reports retry_count / will_retry).
 *
 * Aimfox (https://docs.aimfox.com/webhooks, event catalogue served from
 * https://api.webhooks-external.linkedape.com/api/v1/webhooks/events): an envelope —
 *   { id, event_type, workspace: { id, name, created_at }, event: { timestamp, ... } }
 *   The lead is `event.target` on campaign-flow events (accepted, reply, inmail_reply) and
 *   `event.sender` on message events (new_reply, campaign_reply). Retried up to 6 times.
 *
 * The legacy shape the old handlers read ({ event, leadId, email | linkedInUrl, replyText,
 * timestamp }) is still accepted, so nothing configured against it breaks.
 */
import { createHash } from "node:crypto";

export type WebhookVendor = "INSTANTLY" | "AIMFOX";

/** The Outbound Engine's own vocabulary. Only these do anything; every other vendor event is ignored. */
export type OutboundEvent =
  | "email_reply"
  | "linkedin_reply"
  | "interested"
  | "not_interested"
  | "meeting_booked"
  | "bounced"
  | "unsubscribed"
  | "connection_accepted"
  | "connection_declined";

/** What lib/agent-handlers/outbound-revenue.ts accepts as `input.event`. */
export type RevenueEvent = "email_reply" | "linkedin_reply" | "interested" | "meeting_booked";

export type OutboundStatus =
  | "PENDING"
  | "IN_SEQUENCE"
  | "REPLIED"
  | "INTERESTED"
  | "NOT_INTERESTED"
  | "MEETING_BOOKED"
  | "CONVERTED"
  | "SUPPRESSED";

/** Everything a payload says about who the lead is. Any one match is enough. */
export type LeadIdentity = {
  /** Vendor lead ids, compared with instantlyLeadId / aimfoxLeadId. */
  leadIds: string[];
  /** Lower-cased. */
  emails: string[];
  /** Lower-cased linkedin.com/in/<slug> handles. */
  linkedInSlugs: string[];
};

export type ParsedWebhook =
  | {
      kind: "event";
      vendor: WebhookVendor;
      /** The vendor's own event name, lower-cased — kept for logs and the dedupe key. */
      vendorEventType: string;
      event: OutboundEvent;
      identity: LeadIdentity;
      /** The vendor's unique id for this delivery or the message it is about, when it sends one. */
      eventId: string | null;
      occurredAt: string | null;
      replyText: string;
      sourceLeadId: string | null;
      /** A stable fingerprint of the raw body — the dedupe key of last resort. */
      bodyHash: string;
    }
  | { kind: "ignored"; vendor: WebhookVendor; vendorEventType: string | null; reason: string }
  | { kind: "invalid"; vendor: WebhookVendor; reason: string };

// ─── Vendor event maps ──────────────────────────────────────────────────────

/**
 * Instantly `event_type` → ours. Current names from the v2 webhook-events guide, plus the names the
 * old handler used (which is what any hand-built or legacy integration would send).
 */
export const INSTANTLY_EVENT_MAP: Readonly<Record<string, OutboundEvent>> = {
  reply_received: "email_reply",
  lead_interested: "interested",
  lead_not_interested: "not_interested",
  lead_meeting_booked: "meeting_booked",
  email_bounced: "bounced",
  lead_unsubscribed: "unsubscribed",
  // legacy
  interested: "interested",
  not_interested: "not_interested",
  meeting_booked: "meeting_booked",
};

/**
 * Aimfox `event_type` → ours. `reply` (first reply only), `inmail_reply`, `campaign_reply` (every
 * reply to a campaign message) and `new_reply` (any reply on the seat) are all a LinkedIn reply;
 * `accepted` is a campaign connection request accepted. Aimfox has no "declined" event — that one
 * is legacy only.
 */
export const AIMFOX_EVENT_MAP: Readonly<Record<string, OutboundEvent>> = {
  campaign_reply: "linkedin_reply",
  reply: "linkedin_reply",
  inmail_reply: "linkedin_reply",
  new_reply: "linkedin_reply",
  accepted: "connection_accepted",
  // legacy
  connection_accepted: "connection_accepted",
  connection_declined: "connection_declined",
};

export const REVENUE_EVENT: Readonly<Partial<Record<OutboundEvent, RevenueEvent>>> = {
  email_reply: "email_reply",
  linkedin_reply: "linkedin_reply",
  interested: "interested",
  meeting_booked: "meeting_booked",
};

// ─── Parsing ────────────────────────────────────────────────────────────────

const MAX_REPLY_CHARS = 20_000;

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() ? v.trim() : null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function eventName(v: unknown): string | null {
  const s = str(v);
  return s ? s.toLowerCase() : null;
}

/** Loose, but enough to keep a non-address out of an email match. */
export function normaliseEmail(v: unknown): string | null {
  const s = str(v);
  if (!s || s.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s.toLowerCase();
}

/** `https://www.linkedin.com/in/Jane-Doe-123/?x=1` → `jane-doe-123`. Null for anything else. */
export function linkedInSlug(url: unknown): string | null {
  const s = str(url);
  if (!s) return null;
  const match = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(s);
  if (!match) return null;
  let slug = match[1]!;
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // keep the raw segment
  }
  return slug.toLowerCase();
}

function uniq(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0))];
}

/** Key order independent, so a retry that re-serialises the same body hashes the same. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = obj(v);
  if (o) {
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function emptyIdentity(identity: LeadIdentity): boolean {
  return identity.leadIds.length === 0 && identity.emails.length === 0 && identity.linkedInSlugs.length === 0;
}

export function parseInstantlyPayload(body: unknown): ParsedWebhook {
  const vendor = "INSTANTLY" as const;
  const b = obj(body);
  if (!b) return { kind: "invalid", vendor, reason: "body is not a JSON object" };

  const vendorEventType = eventName(b.event_type) ?? eventName(b.event);
  if (!vendorEventType) return { kind: "ignored", vendor, vendorEventType: null, reason: "no event_type" };
  const event = INSTANTLY_EVENT_MAP[vendorEventType];
  if (!event) return { kind: "ignored", vendor, vendorEventType, reason: "event not handled" };

  // `lead_email` is the documented field; `email` is the legacy one (and also how Instantly merges the
  // lead's own record into the payload). `email_account` is the sender mailbox and is never used.
  const identity: LeadIdentity = {
    leadIds: uniq([str(b.lead_id), str(b.leadId)]),
    emails: uniq([normaliseEmail(b.lead_email), normaliseEmail(b.email)]),
    linkedInSlugs: [],
  };
  if (emptyIdentity(identity)) return { kind: "ignored", vendor, vendorEventType, reason: "no lead in payload" };

  const reply = str(b.reply_text) ?? str(b.reply_text_snippet) ?? str(b.replyText) ?? "";
  return {
    kind: "event",
    vendor,
    vendorEventType,
    event,
    identity,
    eventId: str(b.event_id),
    occurredAt: str(b.timestamp),
    replyText: reply.slice(0, MAX_REPLY_CHARS),
    sourceLeadId: identity.leadIds[0] ?? null,
    bodyHash: sha256(stableStringify(b)),
  };
}

function aimfoxProfileIdentity(profile: Record<string, unknown> | null): LeadIdentity {
  if (!profile) return { leadIds: [], emails: [], linkedInSlugs: [] };
  return {
    leadIds: uniq([str(profile.id), str(profile.urn), str(profile.public_identifier)]),
    emails: uniq([normaliseEmail(profile.email)]),
    linkedInSlugs: uniq([str(profile.public_identifier)?.toLowerCase(), linkedInSlug(profile.profile_url)]),
  };
}

export function parseAimfoxPayload(body: unknown): ParsedWebhook {
  const vendor = "AIMFOX" as const;
  const b = obj(body);
  if (!b) return { kind: "invalid", vendor, reason: "body is not a JSON object" };

  const vendorEventType = eventName(b.event_type) ?? (typeof b.event === "string" ? eventName(b.event) : null);
  if (!vendorEventType) return { kind: "ignored", vendor, vendorEventType: null, reason: "no event_type" };
  const event = AIMFOX_EVENT_MAP[vendorEventType];
  if (!event) return { kind: "ignored", vendor, vendorEventType, reason: "event not handled" };

  const detail = obj(b.event);
  let identity: LeadIdentity;
  let replyText = "";
  let eventId: string | null = null;
  let occurredAt: string | null;

  if (detail) {
    // Message events name the lead as the sender of the reply; campaign-flow events as the target.
    const lead =
      vendorEventType === "new_reply" || vendorEventType === "campaign_reply"
        ? (obj(detail.sender) ?? obj(detail.target))
        : (obj(detail.target) ?? obj(detail.lead));
    identity = aimfoxProfileIdentity(lead);
    if (str(detail.target_urn)) identity.leadIds = uniq([...identity.leadIds, str(detail.target_urn)]);
    // `body` is the reply on message events. On `reply` / `inmail_reply`, `message` is OUR outbound
    // template, not what the lead wrote, so it is deliberately not used as reply text.
    replyText = str(detail.body) ?? str(obj(detail.message)?.body) ?? "";
    // One LinkedIn message can arrive as both new_reply and campaign_reply with different envelope
    // ids; its message_urn is the same in both, so it is the better dedupe id when present.
    eventId = str(detail.message_urn) ? `message:${str(detail.message_urn)}` : str(b.id);
    occurredAt = str(detail.timestamp);
  } else {
    identity = {
      leadIds: uniq([str(b.leadId), str(b.lead_id)]),
      emails: uniq([normaliseEmail(b.email)]),
      linkedInSlugs: uniq([linkedInSlug(b.linkedInUrl)]),
    };
    replyText = str(b.replyText) ?? "";
    eventId = str(b.id);
    occurredAt = str(b.timestamp);
  }

  if (emptyIdentity(identity)) return { kind: "ignored", vendor, vendorEventType, reason: "no lead in payload" };

  return {
    kind: "event",
    vendor,
    vendorEventType,
    event,
    identity,
    eventId,
    occurredAt,
    replyText: replyText.slice(0, MAX_REPLY_CHARS),
    sourceLeadId: identity.leadIds[0] ?? null,
    bodyHash: sha256(stableStringify(b)),
  };
}

export function parseWebhookPayload(vendor: WebhookVendor, body: unknown): ParsedWebhook {
  return vendor === "INSTANTLY" ? parseInstantlyPayload(body) : parseAimfoxPayload(body);
}

// ─── Matching ───────────────────────────────────────────────────────────────

export type ProspectCandidate = {
  id: string;
  workspaceId: string;
  email: string;
  linkedInUrl: string | null;
  instantlyLeadId: string | null;
  aimfoxLeadId: string | null;
  status: OutboundStatus;
};

/**
 * The prospect a delivery is about, from candidates the caller already limited to the authenticated
 * workspace. Strongest evidence wins: the vendor lead id we stored, then the email (case-insensitive),
 * then the LinkedIn handle. A tie at the winning level with more than one prospect is ambiguous and
 * matches nothing — except inside a verified workspace, where an email tie can only be two rows that
 * differ by case and the exact-case one is taken.
 *
 * `scoped` is false only for an unsigned grace-window delivery, where the candidates span workspaces.
 */
export function pickProspect<T extends ProspectCandidate>(
  vendor: WebhookVendor,
  identity: LeadIdentity,
  candidates: T[],
  scoped: boolean,
): T | null {
  const leadIds = new Set(identity.leadIds);
  const emails = new Set(identity.emails);
  const slugs = new Set(identity.linkedInSlugs);

  const byLeadId = candidates.filter((c) => {
    const stored = vendor === "INSTANTLY" ? c.instantlyLeadId : c.aimfoxLeadId;
    return stored != null && leadIds.has(stored);
  });
  const byEmail = candidates.filter((c) => emails.has(c.email.toLowerCase()));
  const bySlug = candidates.filter((c) => {
    const slug = linkedInSlug(c.linkedInUrl);
    return slug != null && slugs.has(slug);
  });

  for (const tier of [byLeadId, byEmail, bySlug]) {
    const distinct = [...new Map(tier.map((c) => [c.id, c])).values()];
    if (distinct.length === 0) continue;
    if (distinct.length === 1) return distinct[0]!;
    if (!scoped) return null;
    if (tier === byEmail) {
      const exact = distinct.filter((c) => identity.emails.includes(c.email));
      return exact.length === 1 ? exact[0]! : null;
    }
    return null;
  }
  return null;
}

// ─── What to write ──────────────────────────────────────────────────────────

/**
 * One guarded write. Every guard makes a re-delivery a no-op on its own: timestamps are set once,
 * statuses only move forward from the listed ones (a late "reply" never drags a MEETING_BOOKED
 * prospect back to REPLIED, and a connection accepted never resets a prospect already replying).
 */
export type ProspectUpdate = {
  onlyIfStatusIn?: OutboundStatus[];
  onlyIfNull?: "emailRepliedAt" | "linkedInRepliedAt" | "interestedAt" | "meetingBookedAt" | "excludeUntil";
  data: {
    status?: OutboundStatus;
    emailRepliedAt?: Date;
    linkedInRepliedAt?: Date;
    interestedAt?: Date;
    meetingBookedAt?: Date;
    excludedAt?: Date;
    excludeUntil?: Date | null;
    exclusionReason?: string;
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function prospectUpdatesFor(event: OutboundEvent, now: Date): ProspectUpdate[] {
  switch (event) {
    case "email_reply":
      return [
        { onlyIfNull: "emailRepliedAt", data: { emailRepliedAt: now } },
        { onlyIfStatusIn: ["PENDING", "IN_SEQUENCE"], data: { status: "REPLIED" } },
      ];
    case "linkedin_reply":
      return [
        { onlyIfNull: "linkedInRepliedAt", data: { linkedInRepliedAt: now } },
        { onlyIfStatusIn: ["PENDING", "IN_SEQUENCE"], data: { status: "REPLIED" } },
      ];
    case "interested":
      return [
        { onlyIfNull: "interestedAt", data: { interestedAt: now } },
        { onlyIfStatusIn: ["PENDING", "IN_SEQUENCE", "REPLIED", "NOT_INTERESTED"], data: { status: "INTERESTED" } },
      ];
    case "meeting_booked":
      return [
        { onlyIfNull: "meetingBookedAt", data: { meetingBookedAt: now } },
        {
          onlyIfStatusIn: ["PENDING", "IN_SEQUENCE", "REPLIED", "INTERESTED", "NOT_INTERESTED"],
          data: { status: "MEETING_BOOKED" },
        },
      ];
    case "not_interested":
      return [
        {
          onlyIfStatusIn: ["PENDING", "IN_SEQUENCE", "REPLIED", "INTERESTED"],
          data: {
            status: "NOT_INTERESTED",
            excludedAt: now,
            excludeUntil: new Date(now.getTime() + 365 * DAY_MS),
            exclusionReason: "Email: replied not interested",
          },
        },
      ];
    case "bounced":
      return [
        {
          onlyIfStatusIn: ["PENDING", "IN_SEQUENCE"],
          data: { status: "SUPPRESSED", excludedAt: now, excludeUntil: null, exclusionReason: "Email: bounced" },
        },
      ];
    case "unsubscribed":
      return [
        {
          onlyIfStatusIn: ["PENDING", "IN_SEQUENCE", "REPLIED", "INTERESTED", "NOT_INTERESTED"],
          data: { status: "SUPPRESSED", excludedAt: now, excludeUntil: null, exclusionReason: "Email: unsubscribed" },
        },
      ];
    case "connection_accepted":
      return [{ onlyIfStatusIn: ["PENDING"], data: { status: "IN_SEQUENCE" } }];
    case "connection_declined":
      // Don't retry LinkedIn for 90 days — the email sequence continues unaffected.
      return [{ onlyIfNull: "excludeUntil", data: { excludeUntil: new Date(now.getTime() + 90 * DAY_MS) } }];
  }
}

/**
 * The idempotency key for one delivery about one prospect, hashed so it is bounded and carries no
 * address. The vendor's own id when it sends one (Aimfox), else the prospect + event + the vendor's
 * event timestamp (Instantly sends no id, but a retry carries the same timestamp), else the body.
 */
export function dedupeKey(parsed: Extract<ParsedWebhook, { kind: "event" }>, prospectId: string): string {
  const basis = parsed.eventId
    ? `id|${parsed.eventId}`
    : parsed.occurredAt
      ? `ts|${prospectId}|${parsed.event}|${parsed.occurredAt}`
      : `body|${prospectId}|${parsed.bodyHash}`;
  return sha256(`${parsed.vendor}|${basis}`);
}

// ─── Orchestration ──────────────────────────────────────────────────────────

export type WebhookDeps<P extends ProspectCandidate = ProspectCandidate> = {
  /** Candidates for `identity`, limited to `workspaceId` when it is non-null. */
  findCandidates(vendor: WebhookVendor, identity: LeadIdentity, workspaceId: string | null): Promise<P[]>;
  /** Records the delivery. False when this key was already recorded — a duplicate. */
  claim(workspaceId: string, vendor: WebhookVendor, key: string, vendorEventType: string): Promise<boolean>;
  /** Forgets a claim, so the vendor's retry of a delivery that failed part-way is processed. */
  release(workspaceId: string, vendor: WebhookVendor, key: string): Promise<void>;
  applyUpdate(prospect: P, update: ProspectUpdate): Promise<void>;
  /** The workspace's Outbound Revenue agent, if it exists and is enabled. */
  revenueAgentId(workspaceId: string): Promise<string | null>;
  createRevenueRun(args: {
    workspaceId: string;
    agentConfigId: string;
    vendor: WebhookVendor;
    input: Record<string, unknown>;
  }): Promise<string>;
  enqueue(runId: string): Promise<void>;
  now(): Date;
  log(message: string): void;
};

export type WebhookOutcome =
  | "ignored"
  | "invalid"
  | "no_prospect"
  | "duplicate"
  | "updated"
  | "run_created"
  | "error";

/**
 * Runs one parsed delivery. Never throws: resolves to the HTTP status to answer with. The body is always
 * `{ received: true }` (see receive.ts) so a URL holder learns nothing about the database from it.
 * Ignored, unmatched and duplicate deliveries are 200: a 4xx/5xx makes the vendor retry and
 * eventually disable the webhook. Only a database failure is a 500, and a claim made before it is
 * released first so the vendor's retry does the work.
 */
export async function processWebhook<P extends ProspectCandidate>(
  parsed: ParsedWebhook,
  workspaceId: string | null,
  deps: WebhookDeps<P>,
): Promise<{ status: number; outcome: WebhookOutcome }> {
  if (parsed.kind === "invalid") return { status: 400, outcome: "invalid" };
  if (parsed.kind === "ignored") return { status: 200, outcome: "ignored" };

  let located: { prospect: P; key: string; claimed: boolean } | null;
  try {
    const candidates = await deps.findCandidates(parsed.vendor, parsed.identity, workspaceId);
    const prospect = pickProspect(parsed.vendor, parsed.identity, candidates, workspaceId !== null);
    if (!prospect || (workspaceId !== null && prospect.workspaceId !== workspaceId)) {
      located = null;
    } else {
      const key = dedupeKey(parsed, prospect.id);
      located = { prospect, key, claimed: await deps.claim(prospect.workspaceId, parsed.vendor, key, parsed.vendorEventType) };
    }
  } catch (err) {
    deps.log(`[webhooks] ${parsed.vendor}: ${parsed.vendorEventType} lookup failed: ${(err as Error).message}`);
    return { status: 500, outcome: "error" };
  }
  if (!located) return { status: 200, outcome: "no_prospect" };
  if (!located.claimed) return { status: 200, outcome: "duplicate" };
  const { prospect, key } = located;

  let runId: string | null = null;
  try {
    for (const update of prospectUpdatesFor(parsed.event, deps.now())) await deps.applyUpdate(prospect, update);

    const revenueEvent = REVENUE_EVENT[parsed.event];
    if (revenueEvent) {
      const agentConfigId = await deps.revenueAgentId(prospect.workspaceId);
      if (agentConfigId) {
        runId = await deps.createRevenueRun({
          workspaceId: prospect.workspaceId,
          agentConfigId,
          vendor: parsed.vendor,
          input: {
            prospectId: prospect.id,
            event: revenueEvent,
            replyText: parsed.replyText,
            source: parsed.vendor.toLowerCase(),
            sourceLeadId: parsed.sourceLeadId,
            sourceEvent: parsed.vendorEventType,
            dedupeKey: key,
          },
        });
      }
    }
  } catch (err) {
    deps.log(`[webhooks] ${parsed.vendor}: ${parsed.vendorEventType} failed, claim released for the retry: ${(err as Error).message}`);
    await deps.release(prospect.workspaceId, parsed.vendor, key).catch(() => undefined);
    return { status: 500, outcome: "error" };
  }

  if (runId) {
    // The run exists and the claim stands, so a retry won't create a second one. enqueue uses the
    // run id as the job id, so enqueuing again later is safe too.
    try {
      await deps.enqueue(runId);
    } catch (err) {
      deps.log(`[webhooks] ${parsed.vendor}: run created but enqueue failed: ${(err as Error).message}`);
    }
    return { status: 200, outcome: "run_created" };
  }
  return { status: 200, outcome: "updated" };
}

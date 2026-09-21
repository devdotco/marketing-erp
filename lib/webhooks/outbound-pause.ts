/**
 * Cross-channel "stop on positive signal" for the Outbound Engine — the piece that was missing:
 * Email Outbound is advertised as "Stops sequences on positive signal and hands off to Revenue"
 * and LinkedIn Outbound as "On reply, pauses email" (lib/agents.ts), but until now a reply /
 * interested / meeting webhook only updated OutboundProspect in the database — see
 * lib/webhooks/outbound-events.ts's prospectUpdatesFor. No vendor was ever told to stop.
 *
 * Split the same way outbound-events.ts is: `planChannelPause` below is pure (which vendor call,
 * if any, a given event implies for a given prospect) so it can be unit tested without a live key
 * or a database, same as prospectUpdatesFor; `runChannelPause` is the network/DB-injectable half
 * that lib/webhooks/receive.ts's WebhookDeps.applyChannelPause wires to real credentials, the real
 * Instantly call, and Prisma. Called from lib/webhooks/outbound-events.ts's processWebhook,
 * immediately after the guarded status writes for the same delivery — see that file.
 *
 * ── Which events pause anything, and why exactly these three ──────────────────────────────────
 * Only "interested", "meeting_booked", and "linkedin_reply" plan a pause. Deliberately NOT
 * "email_reply":
 *   - "interested" and "meeting_booked" are unambiguous positive signals — Instantly only emits
 *     them from `lead_interested` / `lead_meeting_booked` (INSTANTLY_EVENT_MAP in
 *     outbound-events.ts; AIMFOX_EVENT_MAP has no equivalent), so acting on them is never a guess
 *     about sentiment.
 *   - "linkedin_reply" is LinkedIn Outbound's own advertised trigger ("on reply, pauses email") —
 *     Aimfox has no sentiment-classified reply event the way Instantly does (its whole event
 *     vocabulary is `reply` / `campaign_reply` / `inmail_reply` / `new_reply`, all "a message came
 *     back", see outbound-events.ts), so treating any LinkedIn reply as the trigger matches what's
 *     actually observable, not a narrower thing we can't detect.
 *   - Instantly's own `email_reply` (`reply_received`) is excluded on purpose: Instantly already
 *     has the full reply text and its own AI interest-classification (see
 *     `disable_auto_interest` in the interest-status endpoint's own docs) — a bare reply here
 *     could be "please stop emailing me" just as easily as genuine interest, and Instantly is
 *     better positioned than this codebase to tell the difference. Forcing an INTERESTED status on
 *     every reply would risk misrepresenting a negative one and fighting Instantly's own
 *     classification once it catches up. A reply that Instantly later classifies as
 *     `lead_interested` / `lead_meeting_booked` still reaches this module through those events.
 *     (Instantly's `auto_reply_received` / `lead_out_of_office` events are separate from
 *     `reply_received` in INSTANTLY_EVENT_MAP entirely — see that map — so an out-of-office
 *     auto-reply was already never going to reach here, on either event, before this file existed.)
 *
 * ── Same-channel vs. cross-channel ──────────────────────────────────────────────────────────────
 * "interested" / "meeting_booked" plan a same-channel Instantly call: reinforcement, not
 * discovery — Instantly already knows about its own lead, but this makes the stop happen
 * regardless of whether the customer's campaign has Instantly's own "stop sending on reply/positive
 * reply" setting turned on (see the final report / task notes: worth telling the customer to check
 * that setting too, since it's the belt to this module's suspenders, not the other way round).
 * "linkedin_reply" plans a cross-channel Instantly call, because Instantly has no way to find out
 * about a LinkedIn reply on its own.
 *
 * The reverse direction — pausing Aimfox, whether because of its own reply or because of an
 * Instantly-side positive signal — has no confirmed endpoint. See lib/integrations/aimfox.ts's
 * header for what was checked. planChannelPause still reports this as a step (action:
 * "unsupported") rather than silently doing nothing, so runChannelPause can record the limitation
 * against the prospect instead of the caller having to know to look for it.
 */
import type { OutboundEvent } from "./outbound-events";

// ─── Pure planning ──────────────────────────────────────────────────────────

/** Only these plan any pause step at all — see the file header for why. */
export const PAUSE_TRIGGER_EVENTS: ReadonlySet<OutboundEvent> = new Set(["interested", "meeting_booked", "linkedin_reply"]);

/** Instantly's `lt_interest_status` value each direct (same-channel) trigger event maps to — see
 * lib/integrations/instantly.ts's INSTANTLY_INTEREST_STATUS for the full enum. */
const DIRECT_INTEREST_VALUE: Partial<Record<OutboundEvent, number>> = {
  interested: 1, // INSTANTLY_INTEREST_STATUS.INTERESTED
  meeting_booked: 2, // INSTANTLY_INTEREST_STATUS.MEETING_BOOKED
};

/** The value used for a LinkedIn-reply cross-pause of Instantly, where no sentiment is known —
 * see the file header's "same-channel vs. cross-channel" section for why 1 (Interested) is the
 * least-wrong available value rather than a claim about the reply's content. */
const CROSS_CHANNEL_REPLY_INTEREST_VALUE = 1; // INSTANTLY_INTEREST_STATUS.INTERESTED

export type PausePlanStep =
  | { vendor: "INSTANTLY"; action: "set_interest_status"; interestValue: number; reason: string }
  | { vendor: "AIMFOX"; action: "unsupported"; reason: string };

/** The prospect fields a pause decision needs — a subset of outbound-events.ts's
 * ProspectCandidate, so callers don't have to construct a full one. */
export interface PauseCandidate {
  instantlyLeadId: string | null;
  aimfoxLeadId: string | null;
}

/**
 * Pure: which vendor call(s), if any, `event` implies for a prospect with these vendor lead ids on
 * record. No network, no DB, no randomness — safe to call from a webhook handler or a unit test
 * alike. Returns [] for every event outside PAUSE_TRIGGER_EVENTS, and for a prospect with neither
 * vendor lead id set (nothing to act on either way — "only act for prospects that actually have
 * instantlyLeadId/aimfoxLeadId ... on record").
 */
export function planChannelPause(event: OutboundEvent, prospect: PauseCandidate): PausePlanStep[] {
  if (!PAUSE_TRIGGER_EVENTS.has(event)) return [];
  const steps: PausePlanStep[] = [];

  if (prospect.instantlyLeadId) {
    const directValue = DIRECT_INTEREST_VALUE[event];
    if (directValue !== undefined) {
      steps.push({
        vendor: "INSTANTLY",
        action: "set_interest_status",
        interestValue: directValue,
        reason: `${event}: same-channel reinforcement (Instantly's own signal)`,
      });
    } else if (event === "linkedin_reply") {
      steps.push({
        vendor: "INSTANTLY",
        action: "set_interest_status",
        interestValue: CROSS_CHANNEL_REPLY_INTEREST_VALUE,
        reason: "linkedin_reply: cross-channel pause — LinkedIn Outbound's 'on reply, pauses email'",
      });
    }
  }

  if (prospect.aimfoxLeadId) {
    steps.push({
      vendor: "AIMFOX",
      action: "unsupported",
      reason: `${event}: no confirmed Aimfox endpoint to remove/pause a lead in a campaign — see lib/integrations/aimfox.ts`,
    });
  }

  return steps;
}

// ─── Recorded state ─────────────────────────────────────────────────────────

/**
 * Merged into OutboundProspect.intelligence as a `channelPause` sub-key, alongside the Strategist's
 * own `scoring` / `intelligence` keys (see lib/agent-handlers/outbound-strategist.ts) — reusing the
 * one JSON column this record already has rather than adding a migration. Notification is the
 * other model the task allowed for "somewhere visible", but it has zero reads or writes anywhere
 * else in this codebase today (checked before choosing) — nothing renders it, so writing there
 * would be no more "visible" than a log line. A genuine Instantly API failure still gets a
 * Notification row (see ChannelPauseDeps.notifyFailure) in addition to this, since that really is
 * new, actionable information; the Aimfox "unsupported" case is a standing, known limitation, not
 * a failure, so it's recorded here only — a Notification on every qualifying webhook would just be
 * noise once the workspace has read it the first time.
 */
export type ChannelPauseState = {
  instantly?: { status: "paused" | "not_connected" | "failed"; interestValue?: number; reason: string; at: string; error?: string };
  aimfox?: { status: "unsupported"; reason: string; at: string };
};

export interface ChannelPauseDeps {
  /** Decrypted Instantly API key for the workspace, or null when not connected — same lookup
   * outbound-email.ts does before staging a delivery. */
  instantlyApiKey(workspaceId: string): Promise<string | null>;
  setInterestStatus(apiKey: string, email: string, interestValue: number): Promise<void>;
  /** Merges `state` into the prospect's existing intelligence.channelPause (never overwrites the
   * Strategist's own scoring/intelligence keys — see ChannelPauseState's doc comment). */
  recordState(prospectId: string, workspaceId: string, state: ChannelPauseState): Promise<void>;
  /** Best-effort; a failure here must never propagate (see runChannelPause). */
  notifyFailure(workspaceId: string, prospectId: string, message: string): Promise<void>;
  log(message: string): void;
}

/**
 * Executes `planChannelPause`'s steps against real vendors and records the outcome. Never throws —
 * every failure (no integration connected, network error, 4xx/5xx from Instantly, a broken
 * recordState/notifyFailure call) is caught and logged, because a webhook retry storm must never
 * be triggered by a downstream pause call failing (see lib/webhooks/outbound-events.ts's
 * processWebhook, which only 500s on a database failure). Idempotent by construction: the same
 * event always plans the same interestValue, so a duplicate call (should the dedupe in
 * outbound-events.ts ever be bypassed) just sets Instantly to the same status twice.
 */
export async function runChannelPause(event: OutboundEvent, prospect: { id: string; workspaceId: string; email: string } & PauseCandidate, deps: ChannelPauseDeps): Promise<void> {
  const steps = planChannelPause(event, prospect);
  if (steps.length === 0) return;

  const state: ChannelPauseState = {};
  let apiKey: string | null | undefined; // undefined = not looked up yet, so a real lookup happens at most once per call

  for (const step of steps) {
    const at = new Date().toISOString();

    if (step.action === "unsupported") {
      state.aimfox = { status: "unsupported", reason: step.reason, at };
      continue;
    }

    try {
      if (apiKey === undefined) apiKey = await deps.instantlyApiKey(prospect.workspaceId);
      if (!apiKey) {
        state.instantly = { status: "not_connected", interestValue: step.interestValue, reason: step.reason, at };
        continue;
      }
      await deps.setInterestStatus(apiKey, prospect.email, step.interestValue);
      state.instantly = { status: "paused", interestValue: step.interestValue, reason: step.reason, at };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.instantly = { status: "failed", interestValue: step.interestValue, reason: step.reason, at, error: message.slice(0, 300) };
      deps.log(`[outbound-pause] Instantly interest-status update failed for prospect ${prospect.id} (${event}): ${message}`);
      await deps
        .notifyFailure(prospect.workspaceId, prospect.id, `Couldn't pause ${prospect.email}'s Instantly sequence after a "${event}" event: ${message.slice(0, 200)}`)
        .catch((notifyErr) => deps.log(`[outbound-pause] notifyFailure itself failed for ${prospect.id}: ${(notifyErr as Error).message}`));
    }
  }

  try {
    await deps.recordState(prospect.id, prospect.workspaceId, state);
  } catch (err) {
    deps.log(`[outbound-pause] could not persist channel-pause state for ${prospect.id}: ${(err as Error).message}`);
  }
}

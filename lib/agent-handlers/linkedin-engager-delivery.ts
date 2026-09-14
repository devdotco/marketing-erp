/**
 * LinkedIn Engager's stage/execute split — pulled out of linkedin-engager.ts (which touches Prisma
 * and Anthropic) so this pure/network-injectable half can be imported into test/content.test.ts
 * without dragging a database client into the test bundle. Same reason
 * outbound-linkedin-delivery.ts and email-marketing-channels.ts are their own files.
 *
 * What Aimfox's API actually supports (see lib/integrations/aimfox.ts for the endpoint inventory
 * and its sourcing): a connection request with a note, sent by adding a profile to a Campaign's
 * audience — never a direct "send this one request" call; and a direct message into a new or
 * existing conversation — no campaign required. Nothing in Aimfox's API reads, likes, or comments
 * on a LinkedIn post. So this file only ever executes `connectionNote` and `message` actions
 * against Aimfox; `comment` actions are staged for one-click MANUAL posting (copy text, link to
 * the post) and this executor never touches them — see executeLinkedinEngagerBatch below.
 *
 * ---------------------------------------------------------------------------
 * Why this is a batch, not a single delivery like Outbound LinkedIn's
 * ---------------------------------------------------------------------------
 * Outbound LinkedIn stages one profile per run, so its approval hook makes exactly one Aimfox call
 * and either it worked or the whole run's approval failed — nothing to reconcile. LinkedIn Engager
 * stages up to a day's worth of actions in one run, and Aimfox rate-limits at 60 requests/minute
 * (see lib/integrations/aimfox.ts). executeLinkedinEngagerBatch() is written to survive a batch
 * that stops partway:
 *  - each action carries its own status ("pending" | "executed" | "failed" | "manual"), so a
 *    second pass over the same delivery skips everything already executed or manual instead of
 *    resending it (the same per-item idempotency isChannelActivated gives a single delivery).
 *  - a per-item failure (Aimfox rejects one profile as invalid) is recorded on THAT action and the
 *    loop continues — one bad target must not block the rest of the day's queue.
 *  - a 429 (rate limited) stops the loop immediately, leaving every remaining action "pending" and
 *    recording when it happened — see the `rateLimitedAt` field.
 *  - this function NEVER throws. lib/agent-handlers/on-approve.ts's approve route
 *    (app/api/runs/[runId]/approve/route.ts) writes back whatever a hook returns in one shot, but
 *    on a thrown error it reverts `output` to the run's PRE-approval snapshot (plus the error) —
 *    which would silently erase the record of every action this function already executed before
 *    hitting the failure. Returning the accumulated state instead (executed items included) is
 *    what makes that reversion never happen; see the LinkedIn Engager task report for the full
 *    reasoning. The one case this file's caller (linkedinEngagerOnApprove in on-approve.ts) DOES
 *    still throw is "the Aimfox integration was disconnected after staging, before anything ran" —
 *    safe to revert because nothing has executed yet to lose.
 */

import {
  AimfoxApiError,
  addAimfoxCampaignAudience,
  startAimfoxConversation,
  sendAimfoxMessage,
} from "@/lib/integrations/aimfox";

export type EngagementActionType = "connectionNote" | "message" | "comment";
export type EngagementActionStatus = "pending" | "executed" | "failed" | "manual";

export interface EngagementAction {
  id: string;
  type: EngagementActionType;
  targetName: string;
  /** connectionNote / message only — who Aimfox sends to. */
  targetProfileUrl?: string;
  /** message only, when replying into a thread Aimfox already has. Absent → starts a new one. */
  conversationUrn?: string;
  /** comment only — the post being engaged with. Never sent anywhere by this file. */
  targetPostUrl?: string;
  /** The drafted text: the connection note, the message, or the comment to paste in manually. */
  text: string;
  status: EngagementActionStatus;
  /** Set once executed (live or simulated). */
  aimfoxId?: string;
  source?: "aimfox_live" | "simulation";
  executedAt?: string;
  /** Set once failed — a legible, specific reason (never Aimfox's raw error body). */
  error?: string;
}

export interface LinkedinEngagerDelivery {
  connected: boolean;
  /** The Aimfox account (LinkedIn seat) sending — validated against GET /accounts at staging. */
  accountId: string;
  /** Only used by connectionNote actions — Aimfox has no ad-hoc "send one request" call. */
  campaignName: string;
  campaignId?: string;
  actions: EngagementAction[];
  dailyCap: number;
  rateLimitedAt?: string;
}

/** An action this executor will ever touch. `comment` is drafted for a human to paste manually —
 * it stays "manual" from the moment it's staged and is never counted here. */
function isAutomatable(action: EngagementAction): action is EngagementAction & { type: "connectionNote" | "message" } {
  return action.type === "connectionNote" || action.type === "message";
}

/** Idempotency check for one action — mirrors email-marketing-channels.ts's `isChannelActivated`,
 * scoped to a single queue item instead of a whole delivery. A "failed" action is also left alone
 * on a later pass: retrying the identical input against the identical error (an invalid profile
 * URL, say) would only fail again — re-running the agent to redraft is what actually fixes it. */
export function isActionExecuted(action: EngagementAction): boolean {
  return action.status === "executed" || action.status === "manual" || action.status === "failed";
}

/**
 * Caps the AUTOMATABLE queue (connectionNote + message, combined) at `cap`, in the order Claude
 * drafted them — dropping the overflow rather than converting it to a manual action, since a daily
 * send cap is about not exceeding LinkedIn/Aimfox's own limits, not about giving the person more
 * manual busywork. `comment` actions are untouched: they were never going to be sent automatically
 * and don't compete for the same rate-limited send budget.
 */
export function enforceDailyCap(actions: EngagementAction[], cap: number): EngagementAction[] {
  const safeCap = Math.max(0, Math.floor(cap));
  let automatableSeen = 0;
  const kept: EngagementAction[] = [];
  for (const action of actions) {
    if (!isAutomatable(action)) {
      kept.push(action);
      continue;
    }
    if (automatableSeen < safeCap) {
      kept.push(action);
      automatableSeen += 1;
    }
    // else: dropped — over the cap.
  }
  return kept;
}

/** Pure — the exact body POST /campaigns/{id}/audience gets for a connectionNote action. Same
 * shape lib/agent-handlers/outbound-linkedin-delivery.ts's buildAimfoxAudienceBody sends for the
 * same endpoint; kept as a separate function here (rather than imported) because that file is
 * mid-edit by a concurrent task and this one is a distinct action shape (no message1/message2). */
export function buildConnectionNoteBody(action: EngagementAction, campaignId: string): Record<string, unknown> {
  return {
    campaign_id: campaignId,
    profile_url: action.targetProfileUrl,
    custom_variables: { connection_note: action.text },
  };
}

/** Pure — best-effort body for the two conversation endpoints. UNVERIFIED: see the header comment
 * in lib/integrations/aimfox.ts for why the real request schema couldn't be confirmed against
 * Aimfox's docs. Mirrors the one field name (`profile_url`) this codebase HAS confirmed. */
export function buildMessageBody(action: EngagementAction): Record<string, unknown> {
  return action.conversationUrn
    ? { message: action.text }
    : { profile_url: action.targetProfileUrl, message: action.text };
}

export interface ExecuteBatchDeps {
  apiKey?: string;
  addAudience?: typeof addAimfoxCampaignAudience;
  startConversation?: typeof startAimfoxConversation;
  sendMessage?: typeof sendAimfoxMessage;
}

/**
 * Runs every not-yet-executed automatable action in `delivery.actions` against Aimfox, in order,
 * stopping at the first rate limit. Never throws — see the file header for why. Safe to call
 * repeatedly on the same delivery (a re-approval, a retry): already-settled actions are skipped
 * without a network call.
 */
export async function executeLinkedinEngagerBatch(
  delivery: LinkedinEngagerDelivery,
  deps: ExecuteBatchDeps = {},
): Promise<LinkedinEngagerDelivery> {
  const addAudience = deps.addAudience ?? addAimfoxCampaignAudience;
  const startConversation = deps.startConversation ?? startAimfoxConversation;
  const sendMessage = deps.sendMessage ?? sendAimfoxMessage;

  const actions = [...delivery.actions];
  let rateLimitedAt: string | undefined = delivery.rateLimitedAt;

  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i]!;
    if (!isAutomatable(action) || isActionExecuted(action)) continue;

    // Not connected → simulate every remaining automatable action; matches the convention
    // established by activateOutboundLinkedinDelivery / activateOutboundEmailDelivery.
    if (!delivery.connected || !deps.apiKey) {
      actions[i] = {
        ...action,
        status: "executed",
        source: "simulation",
        aimfoxId: `aimfox_${action.id}_sim`,
        executedAt: new Date().toISOString(),
      };
      continue;
    }

    try {
      let result: { id?: string };
      if (action.type === "connectionNote") {
        result = await addAudience(deps.apiKey, delivery.campaignId ?? "", buildConnectionNoteBody(action, delivery.campaignId ?? ""));
      } else if (action.conversationUrn) {
        result = await sendMessage(deps.apiKey, delivery.accountId, action.conversationUrn, buildMessageBody(action));
      } else {
        result = await startConversation(deps.apiKey, delivery.accountId, buildMessageBody(action));
      }
      actions[i] = {
        ...action,
        status: "executed",
        source: "aimfox_live",
        aimfoxId: result.id ?? `aimfox_${action.id}`,
        executedAt: new Date().toISOString(),
      };
    } catch (err) {
      const rateLimited = err instanceof AimfoxApiError && err.rateLimited;
      if (rateLimited) {
        rateLimitedAt = new Date().toISOString();
        break; // stop entirely — this and every remaining action stay "pending".
      }

      const status = err instanceof AimfoxApiError ? err.status : 0;
      const message = err instanceof Error ? err.message : String(err);
      actions[i] = {
        ...action,
        status: "failed",
        error:
          status === 401 || status === 403
            ? "The Aimfox API key is invalid, revoked, or Read-only."
            : status === 422 || status === 400
              ? `Aimfox rejected ${action.targetName || "this target"} — the profile URL is likely wrong or no longer reachable.`
              : `Aimfox error: ${message.slice(0, 200)}`,
      };
      // Non-fatal — one bad target doesn't block the rest of the queue.
    }
  }

  return { ...delivery, actions, rateLimitedAt };
}

/** A short, human-readable line for the run output — what happened, and what's left. */
export function summarizeBatch(delivery: LinkedinEngagerDelivery): string {
  const automatable = delivery.actions.filter(isAutomatable);
  const executed = automatable.filter((a) => a.status === "executed").length;
  const failed = automatable.filter((a) => a.status === "failed").length;
  const pending = automatable.filter((a) => a.status === "pending").length;
  const manual = delivery.actions.filter((a) => a.type === "comment").length;

  const parts = [`${executed} sent`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (pending > 0) {
    parts.push(
      delivery.rateLimitedAt
        ? `${pending} still pending — Aimfox rate-limited this workspace mid-batch. This run is already ` +
          `approved, so re-clicking Approve won't retry them; run LinkedIn Engager again for a fresh batch, ` +
          `or contact an admin to resume these specific actions by hand.`
        : `${pending} still pending`,
    );
  }
  if (manual > 0) parts.push(`${manual} draft${manual === 1 ? "" : "s"} waiting for manual posting`);
  return parts.join(", ");
}

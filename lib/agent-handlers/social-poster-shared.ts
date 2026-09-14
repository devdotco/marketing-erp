/**
 * Shared staging/scheduling/validation logic for the Social suite's two Social-module-backed
 * Poster agents (linkedin-poster, x-poster) — pulled into its own pure file (no Prisma, no
 * Anthropic) so test/content.test.ts can exercise the scheduling math and account validation
 * without a live database, the same reason lib/agent-handlers/linkedin-engager-delivery.ts is its
 * own file.
 *
 * Before this task both handlers looked up a `prisma.integration` row with provider LINKEDIN /
 * TWITTER_X — a provider lib/integrations/catalog.ts's CONNECT_METHODS has no entry for, so
 * Settings > Integrations never offered a way to create one and the lookup could never succeed.
 * The real connected accounts live in the Social module's `SocialAccount` model (OAuth at
 * app/api/linkedin/callback and app/api/x/callback, UI at /social/accounts). Both handlers now
 * select a SocialAccount, stage a batch, and end AWAITING_APPROVAL; nothing posts during the run.
 * On approval (lib/agent-handlers/on-approve.ts) the staged batch becomes `SocialPost` rows tied
 * to that account, so app/api/cron/social-publish does the actual publishing — reusing the Social
 * module's own token refresh, company-page handling, and failure recording instead of each agent
 * calling LinkedIn/X's API itself.
 */

export type PostingFrequency = "Daily" | "3x week" | "Weekly";

/** Average days between consecutive posts for a cadence. "3x week" spaces them ~2.33 days apart —
 * a 7-post batch then spans ~16 days, matching the "2.5 weeks" horizon the drafting prompt names. */
function daySpacing(frequency: PostingFrequency): number {
  switch (frequency) {
    case "Daily":
      return 1;
    case "Weekly":
      return 7;
    case "3x week":
    default:
      return 7 / 3;
  }
}

/** Hour-of-day (24h, local server time) for each posting-window label. Unknown/"Auto" labels fall
 * back to a fixed mid-morning slot rather than trying to derive a real "peak audience" time — no
 * audience-analytics source exists anywhere in this codebase to compute one from. */
const WINDOW_HOURS: Record<string, number> = {
  "Morning (7-9 AM)": 8,
  "Midday (11 AM-1 PM)": 12,
  "Afternoon (3-5 PM)": 16,
  "Evening (6-8 PM)": 19,
};

/**
 * Deterministic given `startAt` — nothing here reads the system clock, so a test can pin it.
 * Produces one ascending timestamp per post, spaced by the cadence and landing on the chosen
 * hour, with a few minutes of stagger per post so a batch never lands on the exact same
 * hour:00 for every entry.
 */
export function computeScheduledTimes(opts: {
  batchSize: number;
  frequency: PostingFrequency;
  window?: string;
  startAt: Date;
}): Date[] {
  const { batchSize, frequency, window, startAt } = opts;
  const spacingDays = daySpacing(frequency);
  const hour = (window ? WINDOW_HOURS[window] : undefined) ?? 9;
  const count = Math.max(0, Math.floor(batchSize));

  const times: Date[] = [];
  for (let i = 0; i < count; i++) {
    const offsetMs = Math.round((i + 1) * spacingDays * 24 * 60 * 60 * 1000);
    const d = new Date(startAt.getTime() + offsetMs);
    d.setHours(hour, (i * 7) % 60, 0, 0);
    times.push(d);
  }
  return times;
}

export type SocialPlatformKey = "LINKEDIN" | "TWITTER_X";

/** The bits of a SocialAccount row this module needs — kept as a plain shape rather than importing
 * the Prisma type so this file stays dependency-free and testable without a client. */
export type SocialAccountLike = {
  id: string;
  workspaceId: string;
  platform: SocialPlatformKey;
  expiresAt: Date;
};

export type AccountValidation =
  | { ok: true }
  | {
      ok: false;
      code: "not_selected" | "not_found" | "wrong_workspace" | "wrong_platform" | "expired";
      message: string;
      hint: string;
    };

/**
 * Pure validation of an already-fetched account row against what the run asked for. Fetching the
 * row (or getting `null` back) stays in the handler — this only decides what the result means, so
 * it's testable without Prisma. Used both before drafting starts (so an expired token is caught
 * before any tokens are spent on Claude) and again at approval time (the account may have been
 * disconnected or expired in between).
 */
export function validateSocialAccount(
  account: SocialAccountLike | null,
  opts: { workspaceId: string; platform: SocialPlatformKey; now?: Date },
): AccountValidation {
  if (!account) {
    return {
      ok: false,
      code: "not_found",
      message: "The selected account is not connected to this workspace.",
      hint: "Pick a connected account, or connect one at /social/accounts.",
    };
  }
  if (account.workspaceId !== opts.workspaceId) {
    return {
      ok: false,
      code: "wrong_workspace",
      message: "That account does not belong to this workspace.",
      hint: "Pick an account from this workspace's connected list at /social/accounts.",
    };
  }
  if (account.platform !== opts.platform) {
    return {
      ok: false,
      code: "wrong_platform",
      message: `That account is a ${account.platform} account, not ${opts.platform}.`,
      hint: "Pick an account of the right platform from the dropdown.",
    };
  }
  const now = opts.now ?? new Date();
  if (account.expiresAt.getTime() <= now.getTime()) {
    return {
      ok: false,
      code: "expired",
      message: "This account's connection has expired.",
      hint: "Reconnect it at /social/accounts, then run (or approve) this agent again.",
    };
  }
  return { ok: true };
}

export interface PendingSocialPost {
  /** Stable within one run's output — used to match a pending post back to the SocialPost created
   * for it on approval, so re-approval (or a retried approval call) never creates a duplicate. */
  id: string;
  content: string;
  /** ISO 8601 — computeScheduledTimes' output, serialised for storage in run.output. */
  scheduledAt: string;
}

/** Which pending posts still need a SocialPost row created for them — everything in `pending`
 * whose id isn't already a key in `alreadyCreated`. Pure so the idempotency rule itself (not just
 * the Prisma call around it) is unit-testable. */
export function postsStillToCreate(
  pending: PendingSocialPost[],
  alreadyCreated: Record<string, string>,
): PendingSocialPost[] {
  return pending.filter((p) => !(p.id in alreadyCreated));
}

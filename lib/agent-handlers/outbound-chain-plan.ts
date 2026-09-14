/**
 * Pure planning half of Outbound Engine pipeline chaining — pulled out of chaining.ts (which
 * imports Prisma and the BullMQ queue) so this half can be imported into test/content.test.ts
 * without dragging a database client or job queue into the test bundle. Same reason
 * outbound-email-delivery.ts and outbound-linkedin-delivery.ts are their own files, split from
 * outbound-email.ts/outbound-linkedin.ts.
 *
 * "Given this run's output and its play's config, what should be enqueued next" — no network, no
 * DB, no side effects. See chaining.ts for the half that actually creates and enqueues the child
 * AgentRun, and enforces the cross-call idempotency guarantee (a unique-constraint violation on
 * AgentRun's (parentRunId, agentConfigId) index) that only a real database can prove.
 */
import type { OutboundPlayConfig } from "./outbound-play-config";

export interface ChainTarget {
  agentSlug: string;
  input: Record<string, unknown>;
}

/**
 * Scout → Strategist: no DB, no queue — just "given this run's output and its play's config,
 * should a Strategist run be enqueued, and with what input".
 */
export function planScoutChaining(output: Record<string, unknown>, playConfig: OutboundPlayConfig): ChainTarget | null {
  const prospectIds = Array.isArray(output.prospectIds)
    ? (output.prospectIds as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const playSlug = typeof output.playSlug === "string" ? output.playSlug : undefined;
  if (prospectIds.length === 0 || !playSlug || !playConfig.autoAdvance) return null;
  return { agentSlug: "outbound-strategist", input: { playSlug, prospectIds } };
}

/** Same as planScoutChaining, for Strategist → Email Outbound / LinkedIn Outbound. Never returns
 * more than one target per agent slug — that's what "one child per agent" is enforced against
 * structurally here, on top of the DB-level unique constraint chaining.ts relies on for the
 * across-calls guarantee. */
export function planStrategistChaining(output: Record<string, unknown>, playConfig: OutboundPlayConfig): ChainTarget[] {
  const rawResults = Array.isArray(output.results)
    ? (output.results as Array<Record<string, unknown>>)
    : output.prospectId
      ? [output]
      : [];
  const playSlug = typeof output.playSlug === "string" ? output.playSlug : undefined;
  if (rawResults.length === 0 || !playSlug || !playConfig.autoAdvance) return [];

  const emailIds = rawResults
    .filter((r) => r.routing === "EMAIL_ONLY" || r.routing === "EMAIL_AND_LINKEDIN")
    .map((r) => r.prospectId)
    .filter((v): v is string => typeof v === "string");
  const linkedinIds = rawResults
    .filter((r) => r.routing === "EMAIL_AND_LINKEDIN")
    .map((r) => r.prospectId)
    .filter((v): v is string => typeof v === "string");

  const targets: ChainTarget[] = [];
  if (emailIds.length > 0) targets.push({ agentSlug: "outbound-email", input: { playSlug, prospectIds: emailIds } });
  if (linkedinIds.length > 0) targets.push({ agentSlug: "outbound-linkedin", input: { playSlug, prospectIds: linkedinIds } });
  return targets;
}

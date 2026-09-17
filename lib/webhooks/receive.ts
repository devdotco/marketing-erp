/**
 * The database half of the Instantly / Aimfox webhooks: authenticate, parse, and hand
 * lib/webhooks/outbound-events.ts the Prisma calls it needs. Shared by both vendors' bare and
 * tokenised routes (via lib/webhooks/instantly.ts and aimfox.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enqueueAgentRun } from "@/lib/queue";
import { decryptCredentials } from "@/lib/crypto";
import { updateInstantlyLeadInterestStatus } from "@/lib/integrations/instantly";
import { authenticateWebhook } from "@/lib/integrations/webhook-auth";
import { runChannelPause, type ChannelPauseDeps, type ChannelPauseState } from "./outbound-pause";
import {
  parseWebhookPayload,
  processWebhook,
  type LeadIdentity,
  type ProspectCandidate,
  type WebhookDeps,
  type WebhookVendor,
} from "./outbound-events";

const CANDIDATE_LIMIT = 10;

const prospectSelect = {
  id: true,
  workspaceId: true,
  email: true,
  linkedInUrl: true,
  instantlyLeadId: true,
  aimfoxLeadId: true,
  status: true,
} as const;

function candidateWhere(vendor: WebhookVendor, identity: LeadIdentity): Prisma.OutboundProspectWhereInput[] {
  const or: Prisma.OutboundProspectWhereInput[] = [];
  // Only real values become clauses: `{ instantlyLeadId: undefined }` is no filter at all in Prisma.
  if (identity.leadIds.length > 0) {
    or.push(vendor === "INSTANTLY" ? { instantlyLeadId: { in: identity.leadIds } } : { aimfoxLeadId: { in: identity.leadIds } });
  }
  for (const email of identity.emails) or.push({ email: { equals: email, mode: "insensitive" } });
  // A broad `contains` narrowed to an exact handle by pickProspect, so /in/sam never matches /in/samantha.
  for (const slug of identity.linkedInSlugs) or.push({ linkedInUrl: { contains: `/in/${slug}`, mode: "insensitive" } });
  return or;
}

// The real (Prisma + live Instantly call) implementation of ChannelPauseDeps — see
// lib/webhooks/outbound-pause.ts for the orchestration this wires up to. Kept as its own object,
// same as prismaDeps below, so both stay easy to read as "here is the whole real-world contract".
const channelPauseDeps: ChannelPauseDeps = {
  async instantlyApiKey(workspaceId) {
    const integration = await prisma.integration.findUnique({
      where: { workspaceId_provider: { workspaceId, provider: "INSTANTLY" } },
    });
    return integration ? (await decryptCredentials<{ apiKey: string }>(integration.encryptedCredentials)).apiKey : null;
  },

  async setInterestStatus(apiKey, email, interestValue) {
    await updateInstantlyLeadInterestStatus(apiKey, { lead_email: email, interest_value: interestValue });
  },

  // Merged into the same `intelligence` JSON column the Strategist writes its scoring/intelligence
  // keys into (see outbound-strategist.ts) — read-then-write, not a transaction: the dedupe claim
  // in outbound-events.ts already means at most one delivery is processing this prospect at a
  // time, so the only real race is with a Strategist re-score landing mid-write, which is rare
  // enough and low-stakes enough (a channelPause key merged a beat late) not to warrant a
  // transaction here — same tradeoff outbound-email.ts's backfillApolloEnrichment already makes.
  async recordState(prospectId, workspaceId, state: ChannelPauseState) {
    // findFirst rather than findUnique(by id) so the where clause carries workspaceId explicitly —
    // id is already workspace-unique on its own (cuid), but every OutboundProspect call in this
    // codebase scopes by workspaceId too as defense in depth (see the "prospect scoping" guard in
    // test/content.test.ts).
    const row = await prisma.outboundProspect.findFirst({ where: { id: prospectId, workspaceId }, select: { intelligence: true } });
    const current = (row?.intelligence ?? {}) as Record<string, unknown>;
    const existingPause = (current.channelPause ?? {}) as ChannelPauseState;
    await prisma.outboundProspect.updateMany({
      where: { id: prospectId, workspaceId },
      data: { intelligence: { ...current, channelPause: { ...existingPause, ...state } } as Prisma.InputJsonObject },
    });
  },

  async notifyFailure(workspaceId, prospectId, message) {
    await prisma.notification.create({
      data: {
        workspaceId,
        type: "outbound_channel_pause_failed",
        title: "Outbound Engine: couldn't pause a sequence",
        body: `${message} (prospect ${prospectId})`,
      },
    });
  },

  log: (message) => console.error(message),
};

const prismaDeps: WebhookDeps<ProspectCandidate> = {
  async findCandidates(vendor, identity, workspaceId) {
    const or = candidateWhere(vendor, identity);
    if (or.length === 0) return [];
    return prisma.outboundProspect.findMany({
      where: { OR: or, ...(workspaceId ? { workspaceId } : {}) },
      select: prospectSelect,
      orderBy: { createdAt: "asc" },
      take: CANDIDATE_LIMIT,
    });
  },

  async claim(workspaceId, vendor, dedupeKey, vendorEventType) {
    try {
      await prisma.webhookReceipt.create({ data: { workspaceId, provider: vendor, dedupeKey, eventType: vendorEventType.slice(0, 100) } });
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
      throw err;
    }
  },

  async release(workspaceId, vendor, dedupeKey) {
    await prisma.webhookReceipt.deleteMany({ where: { workspaceId, provider: vendor, dedupeKey } });
  },

  async applyUpdate(prospect, update) {
    await prisma.outboundProspect.updateMany({
      where: {
        id: prospect.id,
        workspaceId: prospect.workspaceId,
        ...(update.onlyIfStatusIn ? { status: { in: update.onlyIfStatusIn } } : {}),
        ...(update.onlyIfNull ? { [update.onlyIfNull]: null } : {}),
      },
      data: update.data,
    });
  },

  async applyChannelPause(prospect, event) {
    await runChannelPause(event, prospect, channelPauseDeps);
  },

  async revenueAgentId(workspaceId) {
    // Same rule as a manual run (app/api/runs) and pipeline chaining: a disabled agent never runs.
    const config = await prisma.agentConfig.findUnique({
      where: { workspaceId_agentSlug: { workspaceId, agentSlug: "outbound-revenue" } },
      select: { id: true, enabled: true },
    });
    return config?.enabled ? config.id : null;
  },

  async createRevenueRun({ workspaceId, agentConfigId, vendor, input }) {
    const run = await prisma.agentRun.create({
      data: {
        workspaceId,
        agentConfigId,
        status: "PENDING",
        triggeredBy: `webhook:${vendor.toLowerCase()}`,
        input: input as Prisma.InputJsonObject,
      },
      select: { id: true },
    });
    return run.id;
  },

  enqueue: enqueueAgentRun,
  now: () => new Date(),
  log: (message) => console.error(message),
};

/**
 * Prospects are matched ONLY inside the workspace the token authenticated (unsigned grace-window
 * deliveries act only on an unambiguous match). Every answer's body is `{ received: true }` or an
 * error word — never an internal id, and never whether a prospect matched.
 */
export async function receiveOutboundWebhook(vendor: WebhookVendor, req: NextRequest, token: string | null): Promise<NextResponse> {
  const authed = await authenticateWebhook(vendor, token);
  if ("reject" in authed) return NextResponse.json({ error: "Unauthorized" }, { status: authed.reject });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = parseWebhookPayload(vendor, body);
  const { status } = await processWebhook(parsed, authed.workspaceId, prismaDeps);
  if (status === 400) return NextResponse.json({ error: "Invalid payload" }, { status });
  if (status >= 500) return NextResponse.json({ error: "Try again" }, { status });
  return NextResponse.json({ received: true });
}

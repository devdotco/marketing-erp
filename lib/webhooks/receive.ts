/**
 * The database half of the Instantly / Aimfox webhooks: authenticate, parse, and hand
 * lib/webhooks/outbound-events.ts the Prisma calls it needs. Shared by both vendors' bare and
 * tokenised routes (via lib/webhooks/instantly.ts and aimfox.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enqueueAgentRun } from "@/lib/queue";
import { authenticateWebhook } from "@/lib/integrations/webhook-auth";
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

import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { resolveInputs } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { AgentInputError } from "@/lib/ai/errors";
import type { OutboundRevenueDelivery } from "./outbound-revenue-delivery";
import { parsePlayConfig } from "./outbound-play-config";

// Re-exported for lib/agent-handlers/on-approve.ts and test/content.test.ts — the actual
// implementation lives in outbound-revenue-delivery.ts, which imports neither Prisma nor
// Anthropic, so it can be pulled into the test bundle on its own. See that file for why the
// stage/activate split exists.
export {
  activateOutboundRevenueDelivery,
  buildGhlContactBody,
  buildGhlOpportunityBody,
  type OutboundRevenueDelivery,
} from "./outbound-revenue-delivery";

type RevenueEvent = "email_reply" | "linkedin_reply" | "interested" | "meeting_booked";

const GHL_STAGE_MAP: Record<RevenueEvent, string> = {
  email_reply: "Lead",
  linkedin_reply: "Lead",
  interested: "Qualified Lead",
  meeting_booked: "Meeting Set",
};

const GHL_BASE = "https://services.leadconnectorhq.com";
// GHL's v2 API is gated by a date-versioned header, not a version in the URL —
// this is the value documented across the current API, independent of when a
// given endpoint shipped.
const GHL_VERSION = "2021-07-28";
const GHL_TIMEOUT_MS = 15_000;

type GhlPipelineStage = { id: string; name: string };
type GhlPipeline = { id: string; name: string; stages: GhlPipelineStage[] };

/** Per-run memo — several events in a batch can share one locationId's pipeline lookup. */
const pipelineCache = new Map<string, { at: number; pipelines: GhlPipeline[] }>();
const PIPELINE_CACHE_TTL_MS = 5 * 60_000;

/**
 * Pipeline and stage ids are workspace-specific (assigned when the sub-account
 * sets up its pipeline in the GHL UI) — resolve them by name: prefer a pipeline
 * named "Outbound" (this integration's own convention), falling back to the
 * sub-account's first pipeline, then find a stage whose name matches the
 * target stage, falling back to that pipeline's first stage.
 *
 * This is a read-only lookup — safe to run while staging, before approval.
 */
async function resolveGhlPipelineStage(
  authHeaders: Record<string, string>,
  locationId: string,
  targetStageName: string,
  preferredPipelineId?: string,
): Promise<{ pipelineId: string; pipelineStageId: string; pipelineName: string; stageName: string }> {
  const cached = pipelineCache.get(locationId);
  const pipelines =
    cached && Date.now() - cached.at < PIPELINE_CACHE_TTL_MS
      ? cached.pipelines
      : await (async () => {
          let res: Response;
          try {
            res = await fetch(`${GHL_BASE}/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`, {
              headers: authHeaders,
              signal: AbortSignal.timeout(GHL_TIMEOUT_MS),
            });
          } catch (err) {
            throw new AgentInputError(
              "Couldn't reach GoHighLevel to look up the sales pipeline.",
              "This is usually a transient network problem — try running Outbound Revenue again.",
              "ghl_unreachable",
            );
          }
          if (!res.ok) {
            throw new AgentInputError(
              `GoHighLevel rejected the pipeline lookup (HTTP ${res.status}).`,
              res.status === 401 || res.status === 403
                ? "The GoHighLevel private integration token in Settings → Integrations → GoHighLevel is invalid, revoked, or not authorised for this location ID — reconnect it there."
                : "Check the GoHighLevel location and token in Settings → Integrations, then try again.",
              "ghl_pipeline_lookup_failed",
            );
          }
          const body = (await res.json()) as { pipelines?: GhlPipeline[] };
          const fetched = body.pipelines ?? [];
          pipelineCache.set(locationId, { at: Date.now(), pipelines: fetched });
          return fetched;
        })();

  if (pipelines.length === 0) {
    throw new AgentInputError(
      "This GoHighLevel sub-account has no sales pipeline set up.",
      "Create a pipeline (ideally named \"Outbound\") with stages for Lead, Qualified Lead, and Meeting Set in GoHighLevel, then try again.",
      "ghl_no_pipeline",
    );
  }

  // A play with a GHL pipeline id configured (Outbound Engine page) picks that exact pipeline;
  // otherwise falls back to the by-name "Outbound" convention, then the sub-account's first one.
  const pipeline =
    (preferredPipelineId ? pipelines.find((p) => p.id === preferredPipelineId) : undefined) ??
    pipelines.find((p) => p.name.toLowerCase().includes("outbound")) ??
    pipelines[0];
  const stage =
    pipeline.stages.find((s) => s.name.toLowerCase() === targetStageName.toLowerCase()) ??
    pipeline.stages.find((s) => s.name.toLowerCase().includes(targetStageName.toLowerCase())) ??
    pipeline.stages[0];

  if (!stage) {
    throw new AgentInputError(
      `The "${pipeline.name}" pipeline in GoHighLevel has no stages.`,
      "Add at least one stage to the pipeline in GoHighLevel, then try again.",
      "ghl_no_stage",
    );
  }

  return { pipelineId: pipeline.id, pipelineStageId: stage.id, pipelineName: pipeline.name, stageName: stage.name };
}

export const outboundRevenueHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);
  const input = (run.input ?? {}) as Record<string, unknown>;

  const prospectId = (input.prospectId ?? config.prospectId) as string | undefined;
  const event = (input.event ?? config.event ?? "email_reply") as RevenueEvent;
  const replyText = (input.replyText ?? config.replyText ?? "") as string;

  if (!prospectId) {
    const output = { error: "No prospectId in run.input.prospectId" };
    return { output, costUsd: 0 };
  }

  const prospect = await prisma.outboundProspect.findUnique({
    where: { id: prospectId },
    include: { play: true },
  });

  if (!prospect) {
    const output = { error: `Prospect ${prospectId} not found` };
    return { output, costUsd: 0 };
  }

  const ghlIntegration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "GO_HIGH_LEVEL" } },
  });

  const intelligence = (prospect.intelligence ?? {}) as Record<string, unknown>;
  const intel = (intelligence.intelligence ?? {}) as Record<string, unknown>;

  const systemPrompt = `You are a CRM and revenue operations specialist for Dev.co. Your job is to generate GoHighLevel (GHL) contact and opportunity data when a prospect engages.

Generate the exact field values to use when creating or updating GHL records. The data must be complete and accurate.

Always respond with valid JSON only — no markdown, no commentary.`;

  const userPrompt = `Generate GHL CRM data for this engagement event.

Event: ${event}
${replyText ? `Reply text: "${replyText}"` : ""}

Prospect:
- Name: ${prospect.firstName} ${prospect.lastName ?? ""}
- Email: ${prospect.email}
- Title: ${prospect.title ?? "Unknown"}
- Company: ${prospect.company}
- LinkedIn: ${prospect.linkedInUrl ?? "Not available"}
- Play: ${prospect.play.slug} — ${prospect.play.name}
- ICP Score: ${prospect.score}/100
- Channel: ${prospect.channel}

Intelligence:
- Pain hypothesis: ${(intel.painHypothesis as string) ?? "Not available"}
- Best offer: ${(intel.bestOffer as string) ?? "Not available"}
- Primary signal: ${(intel.primarySignal as string) ?? "Not available"}

Return exactly this JSON structure:
{
  "contact": {
    "firstName": "string",
    "lastName": "string",
    "email": "string",
    "phone": null,
    "companyName": "string",
    "jobTitle": "string",
    "website": "string or null",
    "linkedIn": "string or null",
    "tags": ["outbound", "string ICP play tag", "string signal tag"],
    "customFields": {
      "icp_score": 0,
      "icp_play": "string",
      "pain_hypothesis": "string",
      "primary_signal": "string",
      "outbound_channel": "string"
    },
    "notes": "string (1-2 sentence context note for the sales rep)"
  },
  "opportunity": {
    "name": "string (e.g. 'Dev.co — Acme Software')",
    "pipeline": "Outbound",
    "stage": "${GHL_STAGE_MAP[event] ?? "Lead"}",
    "value": 0,
    "currency": "USD",
    "source": "Outbound — ${event}",
    "assignedTo": null
  },
  "timeline_note": "string (event note for the contact timeline, 1 sentence)",
  "action": "create_contact" | "create_opportunity" | "update_opportunity"
}`;

  const message = await client.messages.create({
    model: MODELS.fast,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = textFrom(message);
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let ghlData: Record<string, unknown>;
  try {
    ghlData = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch {
    ghlData = {};
  }

  const contact = (ghlData.contact ?? {}) as Record<string, unknown>;
  const opportunity = ghlData.opportunity as Record<string, unknown> | undefined;
  const wantsOpportunity = event === "interested" || event === "meeting_booked";
  const connected = Boolean(ghlIntegration);

  let locationId: string | undefined;
  let pipelineName: string | undefined;
  let stageName: string | undefined;
  let pipelineId: string | undefined;
  let pipelineStageId: string | undefined;

  if (ghlIntegration) {
    // v1 (rest.gohighlevel.com) is gone; v2 needs a Version header and a
    // locationId on every write. See lib/integrations/catalog.ts and
    // lib/integrations/verify/outbound.ts.
    const creds = await decryptCredentials<{ apiKey: string; locationId: string }>(ghlIntegration.encryptedCredentials);
    locationId = creds.locationId;

    if (wantsOpportunity && !prospect.ghlOpportunityId) {
      const authHeaders = { Authorization: `Bearer ${creds.apiKey}`, Version: GHL_VERSION, "Content-Type": "application/json" };
      // Read-only lookup — safe to run before approval.
      const resolved = await resolveGhlPipelineStage(authHeaders, creds.locationId, GHL_STAGE_MAP[event], parsePlayConfig(prospect.play.config).ghlPipelineId);
      pipelineId = resolved.pipelineId;
      pipelineStageId = resolved.pipelineStageId;
      pipelineName = resolved.pipelineName;
      stageName = resolved.stageName;
    }
  }

  // This records that the prospect engaged (the webhook/run input already told us that much) —
  // not that anything was sent. It's local pipeline bookkeeping, not an outbound side effect, so
  // unlike the GHL contact/opportunity writes below it doesn't need to wait for approval: the
  // status badge should reflect the reply the moment it happens, even before an admin approves
  // writing it to the CRM.
  const statusUpdate: {
    emailRepliedAt?: Date;
    linkedInRepliedAt?: Date;
    interestedAt?: Date;
    meetingBookedAt?: Date;
    status?: "REPLIED" | "INTERESTED" | "MEETING_BOOKED";
  } = {};
  if (event === "email_reply") statusUpdate.emailRepliedAt = new Date();
  if (event === "linkedin_reply") statusUpdate.linkedInRepliedAt = new Date();
  if (event === "interested") {
    statusUpdate.interestedAt = new Date();
    statusUpdate.status = "INTERESTED";
  }
  if (event === "meeting_booked") {
    statusUpdate.meetingBookedAt = new Date();
    statusUpdate.status = "MEETING_BOOKED";
  }
  if (event === "email_reply" || event === "linkedin_reply") statusUpdate.status = "REPLIED";
  await prisma.outboundProspect.update({ where: { id: prospectId }, data: statusUpdate });

  const delivery: OutboundRevenueDelivery = {
    status: "staged",
    prospectId,
    event,
    connected,
    locationId,
    contact,
    wantsOpportunity,
    opportunity,
    pipelineName,
    stageName,
    pipelineId,
    pipelineStageId,
    ghlOpportunityId: prospect.ghlOpportunityId ?? null,
  };

  const output: Record<string, unknown> = {
    prospectId,
    event,
    contact,
    opportunity,
    wantsOpportunity,
    pipeline: wantsOpportunity ? (pipelineName ?? (prospect.ghlOpportunityId ? "existing opportunity — reused, not recreated" : "Outbound")) : undefined,
    stage: GHL_STAGE_MAP[event],
    timelineNote: ghlData.timeline_note,
    action: ghlData.action,
    generatedAt: new Date().toISOString(),
    workspaceId: run.agentConfig.workspaceId,
    delivery,
    approvalRequired: true,
    approvalNote: connected
      ? `Writing ${prospect.email}'s contact record${wantsOpportunity ? " and a sales opportunity" : ""} to GoHighLevel requires workspace admin approval — including when this run was triggered automatically by an Instantly/Aimfox reply webhook. Nothing has been written to GoHighLevel yet.`
      : `No GoHighLevel integration is connected — approving this run will record a simulated contact/opportunity instead of a live one.`,
  };

  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

  await updateStatus("AWAITING_APPROVAL", output);
  return { output, costUsd };
};

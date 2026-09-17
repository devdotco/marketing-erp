import type { AgentHandler } from "./index";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { jsonFrom, textFrom } from "@/lib/ai/extract";
import { resolveInputs } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { AgentInputError } from "@/lib/ai/errors";
import { resolveCrmConnection } from "@/lib/integrations/crm-connection";
import { crmListPipelines, type CrmPipelinesResponse } from "@/lib/integrations/crm-erp-io";
import { prospectUpdatesFor } from "@/lib/webhooks/outbound-events";
import type { OutboundRevenueDelivery, RevenueEvent } from "./outbound-revenue-delivery";
import { buildCrmEngagement, wantsDeal } from "./outbound-revenue-delivery";
import { parsePlayConfig } from "./outbound-play-config";

// Re-exported for lib/agent-handlers/on-approve.ts and test/content.test.ts — the actual
// implementation lives in outbound-revenue-delivery.ts, which imports neither Prisma nor
// Anthropic, so it can be pulled into the test bundle on its own. See that file for why the
// stage/activate split exists.
export {
  activateOutboundRevenueDelivery,
  buildCrmEngagement,
  crmRefusalHint,
  wantsDeal,
  type OutboundRevenueDelivery,
  type RevenueEvent,
} from "./outbound-revenue-delivery";

const EVENTS: RevenueEvent[] = ["email_reply", "linkedin_reply", "interested", "meeting_booked"];

/** What each event is called in a sentence, for the timeline note and the reply draft's framing. */
const EVENT_PHRASE: Record<RevenueEvent, string> = {
  email_reply: "replied to a cold email",
  linkedin_reply: "replied to a LinkedIn message",
  interested: "expressed interest",
  meeting_booked: "booked a meeting",
};

export const outboundRevenueHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const workspaceId = run.agentConfig.workspaceId;
  const config = resolveInputs(run);
  const input = (run.input ?? {}) as Record<string, unknown>;

  const prospectId = (input.prospectId ?? config.prospectId) as string | undefined;
  const rawEvent = (input.event ?? config.event ?? "email_reply") as string;
  const replyText = ((input.replyText ?? config.replyText ?? "") as string).slice(0, 8000);

  if (!prospectId) {
    throw new AgentInputError(
      "This run has no prospect to record.",
      "Outbound Revenue normally starts from an Instantly or Aimfox reply webhook. To run it by hand, set prospectId (and event) in the run's inputs.",
      "missing_prospect",
    );
  }
  if (!EVENTS.includes(rawEvent as RevenueEvent)) {
    throw new AgentInputError(
      `"${rawEvent}" is not an engagement this agent records.`,
      `Use one of: ${EVENTS.join(", ")}.`,
      "unknown_event",
    );
  }
  const event = rawEvent as RevenueEvent;

  // Scoped to this run's workspace: prospectId arrives in run.input, which any OPERATOR can set
  // via POST /api/runs — unscoped, it read (into the run output) and wrote another tenant's prospect.
  const prospect = await prisma.outboundProspect.findFirst({
    where: { id: prospectId, workspaceId },
    include: { play: true },
  });
  if (!prospect) {
    throw new AgentInputError(
      `Prospect ${prospectId} isn't in this workspace's outbound pipeline.`,
      "Check the prospect on the Outbound Engine page, or let the Instantly/Aimfox webhook start this agent itself.",
      "prospect_not_found",
    );
  }

  // ── The CRM link, checked before a token is spent ────────────────────────────────────────────
  //
  // This agent used to fabricate a contact id when GoHighLevel wasn't connected and report success.
  // A staged engagement nobody can deliver is worth less than a refusal that names what to fix, and
  // the check is free — so it happens here, before the model runs.
  const connection = await resolveCrmConnection(workspaceId);
  if (!connection.ok) {
    throw new AgentInputError(
      `This workspace can't reach the erp.io CRM: ${connection.reason}`,
      connection.code === "no_org"
        ? "Outbound Revenue writes to app.erp.io/crm, which is reached through this workspace's erp.io organization. Sign in through app.erp.io so the workspace is linked, or connect a CRM key under Settings → Integrations."
        : "This is a server-side setting (MARKETING_SERVICE_PRIVATE_KEY) — tell whoever runs the deployment.",
      "crm_not_connected",
    );
  }

  const playConfig = parsePlayConfig(prospect.play.config);

  // ── The play's pipeline, checked read-only while staging ─────────────────────────────────────
  let pipelineName: string | undefined;
  const warnings: string[] = [];
  if (playConfig.crmPipelineId) {
    const res = await crmListPipelines(connection.target).catch(() => null);
    if (res?.ok) {
      const body = (await res.json()) as CrmPipelinesResponse;
      const chosen = body.pipelines.find((p) => p.id === playConfig.crmPipelineId);
      if (!chosen) {
        throw new AgentInputError(
          `The CRM pipeline saved on the "${prospect.play.name}" play no longer exists.`,
          "Pick another pipeline on that play (Outbound Engine → Plays), or clear it to use the CRM's own Outbound pipeline.",
          "crm_pipeline_missing",
        );
      }
      pipelineName = chosen.name;
      // Named here rather than discovered at approval: the approver should see that a deal will
      // land in this pipeline and go no further, not find out afterwards.
      const mapped = playConfig.crmStageKeys?.[event];
      const known = chosen.stages.some((s) => s.key === (mapped ?? "")) || chosen.stages.some((s) => !s.outcome);
      if (mapped && !chosen.stages.some((s) => s.key === mapped)) {
        warnings.push(`The "${chosen.name}" pipeline has no stage "${mapped}" for ${event} — the deal will stay where it is until that mapping is fixed on the play.`);
      } else if (!known) {
        warnings.push(`The "${chosen.name}" pipeline has no open stage to move this deal into.`);
      }
    } else {
      // Not fatal: the write itself re-checks, and a momentarily unreachable CRM shouldn't stop a
      // reply being staged for approval.
      warnings.push("Couldn't check the play's CRM pipeline just now — it will be verified again when you approve.");
    }
  } else {
    pipelineName = "Outbound";
  }

  // ── What a person will read: the timeline note, the deal name, the suggested reply ───────────
  const intelligenceBlob = (prospect.intelligence ?? {}) as Record<string, unknown>;
  const intel = (intelligenceBlob.intelligence ?? {}) as Record<string, unknown>;
  const intelligence = {
    painHypothesis: typeof intel.painHypothesis === "string" ? intel.painHypothesis : undefined,
    primarySignal: typeof intel.primarySignal === "string" ? intel.primarySignal : undefined,
    bestOffer: typeof intel.bestOffer === "string" ? intel.bestOffer : undefined,
  };

  const profile = await prisma.businessProfile.findUnique({
    where: { workspaceId },
    select: { businessName: true, uniqueValueProp: true },
  });
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });
  // The brand is the workspace's own, never a hardcoded one: this prompt said "Dev.co" for every
  // workspace that ran it, which is wrong the moment a second brand runs a campaign.
  const brand = profile?.businessName?.trim() || workspace?.name?.trim() || "us";

  const { client } = await resolveAnthropic(workspaceId);
  const name = [prospect.firstName, prospect.lastName].filter(Boolean).join(" ");
  const wantsReplyDraft = Boolean(replyText) || event === "interested" || event === "meeting_booked";

  const systemPrompt = `You write CRM entries for ${brand}'s sales team. You are precise and factual: you use only the details given to you, never invent a company fact, a number, or anything the prospect did not say, and you never promise anything on ${brand}'s behalf. Respond with valid JSON only — no markdown, no commentary.`;

  const userPrompt = `A prospect from an outbound campaign ${EVENT_PHRASE[event]}. Write the CRM entry a salesperson will act on.

Prospect: ${name || prospect.email}${prospect.title ? `, ${prospect.title}` : ""} at ${prospect.company}
Email: ${prospect.email}
Campaign (play): ${prospect.play.name}
ICP score: ${prospect.score}/100${prospect.channel ? `\nChannel: ${prospect.channel}` : ""}
What ${brand} sells on this play: ${playConfig.serviceOffer || "not recorded"}
Pain hypothesis: ${intelligence.painHypothesis ?? "not recorded"}
Buying signal that got them sourced: ${intelligence.primarySignal ?? "not recorded"}
Best offer for them: ${intelligence.bestOffer ?? "not recorded"}
${replyText ? `\nWhat they wrote:\n"""\n${replyText}\n"""` : ""}

Return exactly this JSON:
{
  "note": "one sentence for the CRM timeline, past tense, stating what happened and the single most useful piece of context",
  "dealName": "short deal name, '<Company> — <what they'd buy>', max 60 characters",
  "tags": ["2-4 short lowercase tags: the play, the signal, the channel — no spaces, use hyphens"],
  ${wantsReplyDraft ? `"replyDraft": "a reply for a salesperson to review and send${replyText ? ", answering what they actually wrote" : ""} — plain text, under 120 words, no subject line, no placeholders like [name], sign off as the ${brand} team, and if they asked to be removed say only that we'll stop and apologise"` : `"replyDraft": null`}
}`;

  const message = await client.messages.create({
    // Sonnet, not Haiku: a person sends the reply draft this writes, and a note in a shared CRM
    // timeline is read by people who were not in the conversation.
    model: MODELS.standard,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const written = (jsonFrom(textFrom(message)) ?? {}) as Record<string, unknown>;
  const writing = {
    note: typeof written.note === "string" ? written.note : undefined,
    dealName: typeof written.dealName === "string" ? written.dealName : undefined,
    tags: Array.isArray(written.tags) ? written.tags.filter((t): t is string => typeof t === "string") : undefined,
    replyDraft: typeof written.replyDraft === "string" ? written.replyDraft : undefined,
  };

  // ── Local pipeline bookkeeping ───────────────────────────────────────────────────────────────
  //
  // That the prospect engaged is already true — the webhook (or the person running this) told us
  // so, and the Outbound page should show it without waiting for an approval. But it is applied
  // through the SAME guarded updates the webhook path uses (prospectUpdatesFor): statuses only
  // move forward, timestamps are written once. A re-run of an older event can no longer drag a
  // MEETING_BOOKED prospect back to REPLIED, which is exactly what this agent used to do.
  const now = new Date();
  for (const update of prospectUpdatesFor(event, now)) {
    await prisma.outboundProspect.updateMany({
      where: {
        id: prospectId,
        workspaceId,
        ...(update.onlyIfStatusIn ? { status: { in: update.onlyIfStatusIn } } : {}),
        ...(update.onlyIfNull ? { [update.onlyIfNull]: null } : {}),
      },
      data: update.data,
    });
  }

  const engagement = buildCrmEngagement({
    prospect: {
      id: prospect.id,
      firstName: prospect.firstName,
      lastName: prospect.lastName,
      email: prospect.email,
      title: prospect.title,
      company: prospect.company,
      companyDomain: prospect.companyDomain,
      linkedInUrl: prospect.linkedInUrl,
      score: prospect.score,
      channel: prospect.channel,
      play: { slug: prospect.play.slug, name: prospect.play.name },
      intelligence,
    },
    event,
    runId: run.id,
    occurredAt: now,
    replyText,
    writing,
    play: {
      crmPipelineId: playConfig.crmPipelineId,
      crmStageKeys: playConfig.crmStageKeys,
      crmDealOn: playConfig.crmDealOn,
    },
  });

  const delivery: OutboundRevenueDelivery = {
    status: "staged",
    prospectId,
    event,
    engagement,
    pipelineName,
    warnings,
  };

  const opensDeal = wantsDeal(event, playConfig.crmDealOn);
  const output: Record<string, unknown> = {
    prospectId,
    event,
    crmWorkspace: connection.via === "service" ? "this organization's CRM workspace" : "the CRM workspace this key belongs to",
    contact: engagement.contact,
    note: engagement.note,
    dealName: opensDeal ? engagement.deal?.name : undefined,
    opensDeal,
    pipeline: opensDeal ? (pipelineName ?? "Outbound") : undefined,
    replyDraft: engagement.replyDraft,
    warnings,
    generatedAt: now.toISOString(),
    workspaceId,
    delivery,
    approvalRequired: true,
    approvalNote:
      `Approving writes ${prospect.email} to the erp.io CRM as a contact` +
      (opensDeal ? `, opens or moves their deal in the ${pipelineName ?? "Outbound"} pipeline` : "") +
      (engagement.replyDraft ? ", and leaves the suggested reply as a task for a person to send" : "") +
      ". Nothing has been written to the CRM yet, and the CRM never sends the reply itself.",
  };

  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  await updateStatus("AWAITING_APPROVAL", output);
  return { output, costUsd };
};

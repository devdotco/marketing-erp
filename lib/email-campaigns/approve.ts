/**
 * Approving a campaign-type run: attach the campaign's SendGrid lists and
 * segments to the draft Single Send, set the subject the approver picked, and
 * schedule it for the send day (9:00 AM MT by default). Called from
 * on-approve.ts, inside the approve route's atomic claim.
 *
 * Safe to call twice: a run that already recorded `scheduled` returns at once,
 * and a Single Send SendGrid already shows as scheduled is recorded, not
 * scheduled again. A failure between the PATCH and the schedule leaves a draft
 * that a retried approval simply PATCHes again.
 */
import type { AgentRun, AgentConfig } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AgentInputError } from "@/lib/ai/errors";
import { findPrice, htmlProblem } from "./checks";
import { SENDGRID_UNSUBSCRIBE, visibleText } from "./template";
import {
  createDraftSingleSend,
  getSingleSend,
  prepareSingleSend,
  requireSendgrid,
  resolveSenderId,
  scheduleSingleSend,
} from "@/lib/integrations/sendgrid";

/** The send must be at least this far out when approved, or SendGrid may refuse it and nobody gets a review window. */
const MIN_LEAD_MS = 10 * 60_000;

export function isCampaignOutput(output: unknown): output is Record<string, unknown> & { campaignId: string } {
  return !!output && typeof output === "object" && typeof (output as Record<string, unknown>).campaignId === "string";
}

/** The checks that still apply to a stored draft. Returns problems, empty when it may go. */
export function storedDraftProblems(output: Record<string, unknown>, now = new Date()): string[] {
  const problems: string[] = [];
  const html = typeof output.html === "string" ? output.html : "";
  const subject = typeof output.chosenSubject === "string" ? output.chosenSubject.trim() : "";
  if (!subject) problems.push("No subject is chosen.");
  const price = findPrice(`${subject}\n${visibleText(html)}`);
  if (price) problems.push(`The email contains ${price}.`);
  const broken = htmlProblem(html);
  if (broken) problems.push(`The HTML is malformed: ${broken}.`);
  if (!html.includes(`href="${SENDGRID_UNSUBSCRIBE}"`)) problems.push("The unsubscribe link is missing.");
  const checks = Array.isArray(output.checks) ? (output.checks as { passed?: boolean; name?: string }[]) : [];
  for (const c of checks) if (c.passed === false) problems.push(`Check failed: ${c.name}.`);
  const sendAt = new Date(String(output.sendAt ?? ""));
  if (Number.isNaN(sendAt.getTime())) problems.push("The run has no send time.");
  else if (sendAt.getTime() - now.getTime() < MIN_LEAD_MS) {
    problems.push(`The send time (${String(output.sendAtLabel ?? output.sendAt)}) has passed or is less than 10 minutes away.`);
  }
  return problems;
}

export async function approveCampaignRun(run: AgentRun & { agentConfig: AgentConfig }): Promise<Record<string, unknown> | undefined> {
  const output = { ...((run.output ?? {}) as Record<string, unknown>) };
  if (!isCampaignOutput(output)) return;
  if (output.scheduled) return; // already done by an earlier call

  if (output.test === true) {
    throw new AgentInputError(
      "This is a test run, so approving it cannot schedule a send.",
      "The draft is in SendGrid for you to inspect. Reject this run when you're done; the real draft comes from the scheduled run.",
      "test_run",
    );
  }

  const problems = storedDraftProblems(output);
  if (problems.length) {
    throw new AgentInputError(`This draft can't be scheduled: ${problems.join(" ")}`, "Reject it and run the campaign again for a later date.", "campaign_not_sendable");
  }

  const workspaceId = run.agentConfig.workspaceId;
  const campaign = await prisma.emailCampaign.findFirst({ where: { id: output.campaignId, workspaceId } });
  if (!campaign) throw new AgentInputError("This campaign type was deleted after the draft was made.", "Reject the run.", "campaign_missing");
  if (campaign.listIds.length === 0 && campaign.segmentIds.length === 0) {
    throw new AgentInputError(
      `${campaign.name} has no SendGrid list or segment, so there is nobody to send it to.`,
      "Pick the audience on the campaign (Email Marketing → Campaigns), then approve again.",
      "campaign_no_audience",
    );
  }

  const creds = await requireSendgrid(workspaceId);
  const subject = String(output.chosenSubject);
  const name = `${campaign.name} ${String(output.sendDate)}`;
  const html = String(output.html);

  let single = output.singleSend as { id?: string; status?: string } | undefined;
  if (!single?.id) {
    const created = await createDraftSingleSend(creds.apiKey, {
      name,
      subject,
      html,
      senderId: await resolveSenderId(creds),
      suppressionGroupId: Number(creds.suppressionGroupId),
      categories: ["marketing-erp", campaign.name],
    });
    single = { id: created.id, status: created.status };
  }
  const id = single.id!;

  const current = await getSingleSend(creds.apiKey, id);
  const sendAt = new Date(String(output.sendAt));
  if (current.status !== "scheduled") {
    if (current.status !== "draft") {
      throw new AgentInputError(
        `The SendGrid Single Send is "${current.status}", not a draft, so it was left alone.`,
        "Check it in SendGrid (Marketing → Single Sends). If it already went out, reject this run.",
        "single_send_not_draft",
      );
    }
    await prepareSingleSend(creds.apiKey, id, { name, subject, listIds: campaign.listIds, segmentIds: campaign.segmentIds });
    await scheduleSingleSend(creds.apiKey, id, sendAt);
  }

  return {
    ...output,
    singleSend: { ...single, id, status: "scheduled", sendAt: sendAt.toISOString() },
    scheduled: {
      at: new Date().toISOString(),
      by: run.approvedBy ?? null,
      subject,
      listIds: campaign.listIds,
      segmentIds: campaign.segmentIds,
    },
  };
}

/**
 * Tell the reviewer a campaign draft needs them. This is what makes Monday
 * night work like the old Gmail draft: the run lands in Awaiting approval and
 * an email says so, with the subject options and the send time in it.
 *
 * Never throws. A notification failure must not fail (or un-fail) the run.
 */
import { prisma } from "@/lib/prisma";
import { appUrl } from "@/lib/base-path";
import { sendRunHeadsUp } from "@/lib/email";

export async function campaignReviewers(workspaceId: string, notifyEmails: string[]): Promise<string[]> {
  if (notifyEmails.length > 0) return notifyEmails;
  const admins = await prisma.workspaceMember.findMany({
    where: { workspaceId, role: { in: ["WORKSPACE_ADMIN", "SUPER_ADMIN"] } },
    select: { user: { select: { email: true } } },
  });
  return admins.map((a) => a.user.email).filter((e): e is string => !!e);
}

export async function notifyCampaignRun(opts: {
  workspaceId: string;
  runId: string;
  notifyEmails: string[];
  type: "email_campaign_ready" | "email_campaign_failed";
  title: string;
  lines: string[];
}): Promise<void> {
  try {
    await prisma.notification.create({
      data: { workspaceId: opts.workspaceId, type: opts.type, title: opts.title, body: opts.lines.join("\n"), runId: opts.runId },
    });
  } catch (err) {
    console.error(`[email-campaign] notification row for run ${opts.runId} failed:`, err);
  }
  try {
    const to = await campaignReviewers(opts.workspaceId, opts.notifyEmails);
    await sendRunHeadsUp(to, {
      subject: opts.title,
      heading: opts.title,
      lines: opts.lines,
      ctaText: opts.type === "email_campaign_ready" ? "Review the draft" : "Open the run",
      ctaUrl: appUrl(`/runs/${opts.runId}`),
    });
  } catch (err) {
    console.error(`[email-campaign] heads-up email for run ${opts.runId} failed:`, err);
  }
}

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import { parseTemplate } from "@/lib/email-campaigns/template";
import { upcomingOccurrences, longDateTime } from "@/lib/email-campaigns/schedule";
import { listAudiences, requireSendgrid, type SendgridAudience } from "@/lib/integrations/sendgrid";
import { CampaignForm, type CampaignFormValues } from "./CampaignForm";

export const metadata = { title: "Campaign type", description: "A saved Email Marketing campaign type: template, audience, latitude and calendar." };

export default async function CampaignPage({ params }: { params: Promise<{ slug: string; campaignId: string }> }) {
  const { slug, campaignId } = await params;
  if (slug !== "email-marketing") notFound();
  const session = await getServerSession();
  if (!session?.user) redirect("/login");
  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");
  await requireWorkspaceAccess(workspaceId, "WORKSPACE_ADMIN");

  const [campaign, templates] = await Promise.all([
    campaignId === "new" ? null : prisma.emailCampaign.findFirst({ where: { id: campaignId, workspaceId } }),
    prisma.emailTemplate.findMany({ where: { workspaceId }, orderBy: { name: "asc" } }),
  ]);
  if (campaignId !== "new" && !campaign) notFound();

  let audiences: SendgridAudience[] = [];
  let audienceError: string | null = null;
  try {
    audiences = await listAudiences((await requireSendgrid(workspaceId)).apiKey);
  } catch (err) {
    audienceError = err instanceof Error ? err.message : String(err);
  }

  const values: CampaignFormValues = campaign
    ? { ...campaign }
    : {
        id: "",
        name: "",
        enabled: false,
        templateId: templates[0]?.id ?? "",
        listIds: [],
        segmentIds: [],
        editableSections: [],
        changeLevel: "light",
        sourceUrls: [],
        brief: "",
        monthlyPush: "",
        sendWeekday: 4,
        sendNth: 3,
        sendTime: "09:00",
        timezone: "America/Denver",
        draftWeekday: 1,
        draftTime: "17:47",
        notifyEmails: [],
      };

  const upcoming = campaign ? upcomingOccurrences(campaign, new Date(), 4) : [];

  return (
    <div className="scrollable">
      <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 20 }}>
        <Link href="/agents/email-marketing" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Email Marketing</Link>
        {" / "}
        <Link href="/agents/email-marketing/campaigns" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Campaigns</Link>
        {` / ${campaign?.name ?? "New campaign type"}`}
      </div>
      <div style={{ maxWidth: 760 }}>
        {upcoming.length > 0 && (
          <div className="card" style={{ marginBottom: 16, fontSize: 12, lineHeight: 1.7 }}>
            <strong>Next sends</strong>
            {upcoming.map((o) => (
              <div key={o.sendDate}>
                {longDateTime(o.sendAt, campaign!.timezone)} · drafted {longDateTime(o.draftAt, campaign!.timezone)}
              </div>
            ))}
          </div>
        )}
        <CampaignForm
          values={values}
          templates={templates.map((t) => ({ id: t.id, name: t.name, sections: parseTemplate(t.html).sections.map((s) => ({ key: s.key, group: s.group, kind: s.kind })) }))}
          audiences={audiences}
          audienceError={audienceError}
        />
      </div>
    </div>
  );
}

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import { parseTemplate } from "@/lib/email-campaigns/template";
import { describeSchedule, longDateTime, nextOccurrence } from "@/lib/email-campaigns/schedule";
import { RunCampaignForm } from "./RunCampaignForm";

export const metadata = { title: "Email campaigns", description: "Templates and campaign types for the Email Marketing agent." };

export default async function CampaignsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (slug !== "email-marketing") notFound();

  const session = await getServerSession();
  if (!session?.user) redirect("/login");
  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");
  const { member } = await requireWorkspaceAccess(workspaceId, "VIEWER");
  const isAdmin = session.user.isSuperAdmin || member?.role === "WORKSPACE_ADMIN" || member?.role === "SUPER_ADMIN";

  const [templates, campaigns, sendgrid, config] = await Promise.all([
    prisma.emailTemplate.findMany({ where: { workspaceId }, orderBy: { name: "asc" } }),
    prisma.emailCampaign.findMany({ where: { workspaceId }, orderBy: { name: "asc" }, include: { template: { select: { name: true } } } }),
    prisma.integration.findUnique({ where: { workspaceId_provider: { workspaceId, provider: "SENDGRID" } }, select: { id: true } }),
    prisma.agentConfig.findUnique({ where: { workspaceId_agentSlug: { workspaceId, agentSlug: "email-marketing" } }, select: { enabled: true } }),
  ]);
  const now = new Date();

  return (
    <div className="scrollable">
      <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 20 }}>
        <Link href="/agents" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Agents</Link>
        {" / "}
        <Link href="/agents/email-marketing" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Email Marketing</Link>
        {" / Campaigns"}
      </div>

      <div style={{ maxWidth: 820, display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 6 }}>Campaigns</h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.65 }}>
            Each campaign type fills a locked master template on its own monthly calendar. A run drafts the email, checks it in
            code and leaves a draft Single Send in SendGrid with no recipients and no send time. Approving the run attaches the
            audience and schedules the send.
          </p>
        </div>

        {(!sendgrid || !config?.enabled) && (
          <div className="card" style={{ borderColor: "var(--warning)" }}>
            {!sendgrid && (
              <p style={{ fontSize: 13, marginBottom: 6 }}>
                SendGrid isn&rsquo;t connected. <Link href="/integrations/connect/SENDGRID">Connect it</Link> with the API key, sender address and unsubscribe group.
              </p>
            )}
            {!config?.enabled && <p style={{ fontSize: 13 }}>The Email Marketing agent is off, so no campaign drafts on schedule. Turn it on from the agent page.</p>}
          </div>
        )}

        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600 }}>Campaign types</h2>
            {isAdmin && templates.length > 0 && (
              <Link href="/agents/email-marketing/campaigns/new" className="btn btn-secondary btn-sm">New campaign type</Link>
            )}
          </div>
          {campaigns.length === 0 && <p style={{ fontSize: 13, color: "var(--text-muted)" }}>None yet. Add a template first, then a campaign type that uses it.</p>}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {campaigns.map((c) => {
              const next = (() => {
                try {
                  return nextOccurrence(c, now);
                } catch {
                  return null;
                }
              })();
              return (
                <div key={c.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>
                        {c.name}{" "}
                        <span className={`badge ${c.enabled ? "badge-active" : "badge-muted"}`}>{c.enabled ? "On" : "Off"}</span>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.6 }}>
                        {describeSchedule(c)} · template {c.template.name} · {c.changeLevel} changes ·{" "}
                        {c.listIds.length + c.segmentIds.length || "no"} audience{c.listIds.length + c.segmentIds.length === 1 ? "" : "s"}
                        {next && (
                          <>
                            <br />
                            Next send {longDateTime(next.sendAt, c.timezone)}, drafted {longDateTime(next.draftAt, c.timezone)}
                          </>
                        )}
                      </div>
                    </div>
                    {isAdmin && (
                      <Link href={`/agents/email-marketing/campaigns/${c.id}`} className="btn btn-ghost btn-sm">Edit</Link>
                    )}
                  </div>
                  <RunCampaignForm campaignId={c.id} defaultDate={next?.sendDate ?? ""} />
                </div>
              );
            })}
          </div>
        </div>

        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600 }}>Templates</h2>
            {isAdmin && <Link href="/agents/email-marketing/campaigns/templates/new" className="btn btn-secondary btn-sm">New template</Link>}
          </div>
          {templates.length === 0 && (
            <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
              Paste a master HTML email and wrap each piece the agent may rewrite in edit markers. Everything else stays locked.
            </p>
          )}
          {templates.map((t) => {
            const parsed = parseTemplate(t.html);
            const used = campaigns.filter((c) => c.templateId === t.id).length;
            return (
              <div key={t.id} style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border)", padding: "10px 0" }}>
                <div style={{ fontSize: 13 }}>
                  <strong>{t.name}</strong>
                  <span style={{ color: "var(--text-muted)" }}>
                    {" "}· {parsed.sections.length} editable sections · used by {used}
                    {parsed.errors.length > 0 && " · has marker problems"}
                  </span>
                </div>
                {isAdmin && <Link href={`/agents/email-marketing/campaigns/templates/${t.id}`} className="btn btn-ghost btn-sm">Edit</Link>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

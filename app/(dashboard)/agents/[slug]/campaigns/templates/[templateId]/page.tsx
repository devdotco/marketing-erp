import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import { TemplateForm } from "./TemplateForm";

export const metadata = { title: "Email template", description: "A locked master email for the Email Marketing agent." };

export default async function TemplatePage({ params }: { params: Promise<{ slug: string; templateId: string }> }) {
  const { slug, templateId } = await params;
  if (slug !== "email-marketing") notFound();
  const session = await getServerSession();
  if (!session?.user) redirect("/login");
  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");
  await requireWorkspaceAccess(workspaceId, "WORKSPACE_ADMIN");

  const template = templateId === "new" ? null : await prisma.emailTemplate.findFirst({ where: { id: templateId, workspaceId } });
  if (templateId !== "new" && !template) notFound();

  return (
    <div className="scrollable">
      <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 20 }}>
        <Link href="/agents/email-marketing" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Email Marketing</Link>
        {" / "}
        <Link href="/agents/email-marketing/campaigns" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Campaigns</Link>
        {` / ${template?.name ?? "New template"}`}
      </div>
      <TemplateForm id={template?.id ?? ""} name={template?.name ?? ""} html={template?.html ?? ""} />
    </div>
  );
}

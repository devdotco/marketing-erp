import { redirect } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import { PromptManager } from "./PromptManager";

export const metadata = { title: "Tracked prompts — marketing.erp.io" };
export const dynamic = "force-dynamic";

export default async function PromptsPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");
  await requireWorkspaceAccess(workspaceId);

  const prompts = await prisma.trackedPrompt.findMany({
    where: { workspaceId },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      text: true,
      topic: true,
      source: true,
      active: true,
      _count: { select: { captures: true } },
    },
  });

  return (
    <div className="scrollable">
      <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 20 }}>
        <Link href="/visibility" style={{ color: "var(--text-dim)", textDecoration: "none" }}>
          AI Visibility
        </Link>
        {" / "}
        <span>Prompts</span>
      </div>

      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 4 }}>Tracked prompts</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: "62ch", lineHeight: 1.6 }}>
          Every connected engine is asked each of these, once a day. They are the denominator of every figure on the
          visibility dashboard, so changing this list changes the numbers.
        </p>
      </div>

      <PromptManager
        workspaceId={workspaceId}
        prompts={prompts.map((p) => ({
          id: p.id,
          text: p.text,
          topic: p.topic,
          source: p.source,
          active: p.active,
          captures: p._count.captures,
        }))}
      />
    </div>
  );
}

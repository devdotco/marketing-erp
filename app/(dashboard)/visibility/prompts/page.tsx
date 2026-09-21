import { redirect } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import { PromptManager } from "./PromptManager";
import { connectedEngines } from "@/lib/answer-engines";
import { estimateCapture, MAX_PROMPTS_PER_CAPTURE } from "@/lib/visibility/budget";

export const metadata = { title: "Tracked prompts — marketing.erp.io" };
export const dynamic = "force-dynamic";

export default async function PromptsPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");
  await requireWorkspaceAccess(workspaceId);

  const engines = await connectedEngines(workspaceId);
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

  const activeCount = prompts.filter((p) => p.active).length;
  const activeEstimate = engines.length > 0 && activeCount > 0 ? estimateCapture(activeCount, engines) : null;

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

      {activeEstimate && (
        <div
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "14px 18px",
            marginBottom: 16,
          }}
        >
          <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>
            {activeEstimate.prompts} prompts × {activeEstimate.engines}{" "}
            {activeEstimate.engines === 1 ? "engine" : "engines"} ={" "}
            <strong>{activeEstimate.capturesPerDay} answers a day</strong>, roughly{" "}
            <strong>${activeEstimate.perDayUsd.toFixed(2)} a day</strong> (~$
            {activeEstimate.perMonthUsd.toFixed(0)}/month) on your own engine keys if you capture daily.
          </p>
          <p style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 6, lineHeight: 1.6 }}>
            An estimate from published rates, not a bill — each run records what it actually spent. A single
            capture asks at most {MAX_PROMPTS_PER_CAPTURE} prompts; any beyond that stay tracked but are not asked.
          </p>
        </div>
      )}

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

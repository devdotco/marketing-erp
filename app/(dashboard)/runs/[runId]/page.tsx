import { notFound, redirect } from "next/navigation";
import { getServerSession } from "@/lib/session";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import { prisma } from "@/lib/prisma";
import { ByokPrompt } from "@/components/ui/ByokPrompt";
import { getAgent } from "@/lib/agents";
import Link from "next/link";
import { RunActions } from "./RunActions";

export default async function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;

  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");

  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    include: {
      agentConfig: { select: { agentSlug: true, config: true } },
    },
  });

  if (!run || run.workspaceId !== workspaceId) notFound();

  await requireWorkspaceAccess(workspaceId);

  const triggeredByUser = run.triggeredBy
    ? await prisma.user.findUnique({ where: { id: run.triggeredBy }, select: { name: true } })
    : null;

  const agent = getAgent(run.agentConfig.agentSlug);
  const STATUS_BADGE: Record<string, string> = {
    PENDING: "badge-pending", RUNNING: "badge-running",
    AWAITING_APPROVAL: "badge-awaiting", APPROVED: "badge-approved",
    REJECTED: "badge-rejected", COMPLETED: "badge-completed", FAILED: "badge-failed",
  };

  const isActive = ["PENDING", "RUNNING"].includes(run.status);
  const needsApproval = run.status === "AWAITING_APPROVAL";
  const output = run.output as Record<string, unknown> | null;

  // A failed run stores a structured error (see lib/ai/errors.ts). Older runs
  // stored the provider's raw message as a bare string — render both.
  const rawError = output?.["error"];
  const runError =
    rawError && typeof rawError === "object"
      ? (rawError as { code?: string; message?: string; hint?: string; retryable?: boolean; attempts?: number; detail?: string })
      : typeof rawError === "string"
        ? { message: "The agent failed while running.", detail: rawError }
        : null;
  const hasReadableOutput = Boolean(output) && !runError;

  // Stage-by-stage progress, written by the handler as it goes. Without it a
  // multi-minute pipeline is a spinner, and the QA note that "nothing in the UI
  // warned this would fail" is half about that silence.
  const metadata = run.metadata as { progress?: Array<{ stage: string; detail: string }> } | null;
  const progress = Array.isArray(metadata?.progress) ? metadata.progress : [];

  // The quality pass reports what it found. A reviewer approving a draft should
  // see the defects before they read it, not after they publish it.
  const quality = output?.["qualityReport"] as
    | { pass?: boolean; defects?: string[]; warnings?: string[]; wordCount?: number; externalLinks?: number; repairRounds?: number }
    | undefined;

  const dur = run.completedAt && run.startedAt
    ? Math.round((run.completedAt.getTime() - run.startedAt.getTime()) / 1000)
    : null;

  return (
    <div className="scrollable">
      <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 20 }}>
        <Link href="/runs" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Runs</Link>
        {" / "}
        <span style={{ fontFamily: "monospace" }}>{runId.slice(0, 8)}…</span>
      </div>

      <div style={{ display: "flex", alignItems: "flex-start", gap: 20, marginBottom: 28 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", fontFamily: "monospace" }}>
              {agent?.name ?? run.agentConfig.agentSlug}
            </h1>
            <span className={`badge ${STATUS_BADGE[run.status] ?? "badge-muted"}`}>
              {run.status.replace(/_/g, " ")}
            </span>
          </div>
          <p style={{ fontSize: 12, color: "var(--text-dim)", fontFamily: "monospace" }}>{runId}</p>
        </div>

        {needsApproval && (
          <RunActions runId={runId} />
        )}
      </div>

      {/* Auto-refresh for running */}
      {isActive && (
        <div
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "12px 16px",
            fontSize: 12,
            color: "var(--text-muted)",
            marginBottom: 20,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--warning)", display: "inline-block", animation: "pulse 1.5s infinite" }} />
          Run is in progress — page will auto-refresh every 5 seconds
          <meta httpEquiv="refresh" content="5" />
        </div>
      )}

      {/* Approval prompt */}
      {needsApproval && output && (
        <div
          style={{
            background: "var(--warning-bg)",
            border: "1px solid var(--warning)",
            borderRadius: "var(--radius)",
            padding: "16px 20px",
            marginBottom: 20,
          }}
        >
          <p style={{ fontSize: 13, fontWeight: 600, color: "var(--warning)", marginBottom: 4 }}>
            Review required before publishing
          </p>
          <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
            This agent produced output and is waiting for your approval. Review below, then approve or reject.
          </p>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 240px", gap: 20 }}>
        {/* Output */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {runError?.code === "no_api_key" && (
            <ByokPrompt />
          )}

          {runError && (
            <div
              className="card"
              style={{ borderColor: "var(--danger, var(--warning))" }}
            >
              <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>This run did not complete</h2>
              <p style={{ fontSize: 14, color: "var(--text)", lineHeight: 1.6, marginBottom: 10 }}>
                {runError.message}
              </p>
              {runError.hint && (
                <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.65, marginBottom: 14 }}>
                  {runError.hint}
                </p>
              )}
              <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.65, marginBottom: 14 }}>
                Nothing you entered caused this, and no work was lost — the agent stopped before producing a draft.
                {Number(run.costUsd) === 0 ? " You were not charged for it." : ""}
              </p>
              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                <Link href={`/agents/${run.agentConfig.agentSlug}`} className="btn btn-secondary btn-sm">
                  Back to agent
                </Link>
              </div>
              {runError.detail && (
                <details>
                  <summary style={{ fontSize: 12, color: "var(--text-dim)", cursor: "pointer" }}>
                    Technical detail{runError.code ? ` (${runError.code})` : ""}
                    {runError.attempts ? ` — ${runError.attempts} attempt${runError.attempts === 1 ? "" : "s"}` : ""}
                  </summary>
                  <pre
                    style={{
                      fontSize: 11,
                      fontFamily: "monospace",
                      overflow: "auto",
                      maxHeight: 260,
                      background: "var(--surface-2)",
                      padding: 14,
                      borderRadius: "var(--radius)",
                      color: "var(--text-muted)",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      marginTop: 10,
                    }}
                  >
                    {runError.detail}
                  </pre>
                </details>
              )}
            </div>
          )}

          {isActive && progress.length > 0 && (
            <div className="card">
              <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Progress</h2>
              <ol style={{ display: "flex", flexDirection: "column", gap: 8, margin: 0, paddingLeft: 18 }}>
                {progress.map((entry, i) => (
                  <li key={`${entry.stage}-${i}`} style={{ fontSize: 13 }}>
                    <span style={{ fontWeight: 600 }}>{entry.stage}</span>
                    <span style={{ color: "var(--text-muted)" }}> — {entry.detail}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {quality && (
            <div className="card">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <h2 style={{ fontSize: 14, fontWeight: 600 }}>Quality check</h2>
                <span className={`badge ${quality.pass ? "badge-completed" : "badge-awaiting"}`}>
                  {quality.pass ? "Passed" : `${quality.defects?.length ?? 0} to review`}
                </span>
              </div>

              <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 12 }}>
                {quality.wordCount} words &middot; {quality.externalLinks} external link
                {quality.externalLinks === 1 ? "" : "s"} &middot; {quality.repairRounds} repair round
                {quality.repairRounds === 1 ? "" : "s"}
              </p>

              {(quality.defects?.length ?? 0) > 0 && (
                <>
                  <p style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Unresolved</p>
                  <ul style={{ display: "flex", flexDirection: "column", gap: 6, margin: "0 0 12px", paddingLeft: 18 }}>
                    {quality.defects!.map((defect, i) => (
                      <li key={i} style={{ fontSize: 12, color: "var(--text-muted)" }}>{defect}</li>
                    ))}
                  </ul>
                </>
              )}

              {(quality.warnings?.length ?? 0) > 0 && (
                <>
                  <p style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Worth a look</p>
                  <ul style={{ display: "flex", flexDirection: "column", gap: 6, margin: 0, paddingLeft: 18 }}>
                    {quality.warnings!.map((warning, i) => (
                      <li key={i} style={{ fontSize: 12, color: "var(--text-muted)" }}>{warning}</li>
                    ))}
                  </ul>
                </>
              )}

              {quality.pass && (quality.warnings?.length ?? 0) === 0 && (
                <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                  Every check passed: length band, heading variety, filler and stock phrasing, paragraph
                  length, link budget and anchors, uncited figures, unlinked source names, keyword
                  placement, and the brief&rsquo;s own must-cover and must-avoid lists.
                </p>
              )}
            </div>
          )}

          {hasReadableOutput && output && (
            <div className="card">
              <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Output</h2>

              {/* Blog post content */}
              {Boolean(output["content"]) && (
                <div>
                  {Boolean(output["title"]) && (
                    <p style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>{String(output["title"])}</p>
                  )}
                  {Boolean(output["metaDescription"]) && (
                    <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12, fontStyle: "italic" }}>
                      {String(output["metaDescription"])}
                    </p>
                  )}
                  <div
                    style={{
                      maxHeight: 400,
                      overflow: "auto",
                      fontSize: 13,
                      lineHeight: 1.65,
                      color: "var(--text-muted)",
                      background: "var(--surface-2)",
                      padding: 16,
                      borderRadius: "var(--radius)",
                      whiteSpace: "pre-wrap",
                    }}
                    dangerouslySetInnerHTML={{ __html: String(output["content"]) }}
                  />
                </div>
              )}

              {/* Generic JSON output */}
              {!output["content"] && (
                <pre
                  style={{
                    fontSize: 11,
                    fontFamily: "monospace",
                    overflow: "auto",
                    maxHeight: 400,
                    background: "var(--surface-2)",
                    padding: 14,
                    borderRadius: "var(--radius)",
                    color: "var(--text-muted)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {JSON.stringify(output, null, 2)}
                </pre>
              )}
            </div>
          )}

          {!output && !runError && (
            <div
              style={{
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                padding: "40px 24px",
                textAlign: "center",
                color: "var(--text-muted)",
                fontSize: 13,
              }}
            >
              {isActive ? "Waiting for output…" : "No output available."}
            </div>
          )}
        </div>

        {/* Metadata */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="card">
            <h3 style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-dim)", marginBottom: 14 }}>Run details</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div>
                <p style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 2 }}>Agent</p>
                <Link href={`/agents/${run.agentConfig.agentSlug}`} style={{ fontSize: 12, color: "var(--text)", textDecoration: "none", fontFamily: "monospace" }}>
                  {agent?.name ?? run.agentConfig.agentSlug}
                </Link>
              </div>
              <div>
                <p style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 2 }}>Triggered by</p>
                <p style={{ fontSize: 12, color: "var(--text)", margin: 0 }}>{triggeredByUser?.name ?? "System"}</p>
              </div>
              <div>
                <p style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 2 }}>Started</p>
                <p style={{ fontSize: 12, color: "var(--text)", margin: 0 }}>
                  {run.startedAt ? run.startedAt.toLocaleString() : "—"}
                </p>
              </div>
              {run.completedAt && (
                <div>
                  <p style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 2 }}>Completed</p>
                  <p style={{ fontSize: 12, color: "var(--text)", margin: 0 }}>{run.completedAt.toLocaleString()}</p>
                </div>
              )}
              {dur !== null && (
                <div>
                  <p style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 2 }}>Duration</p>
                  <p style={{ fontSize: 12, color: "var(--text)", margin: 0, fontVariantNumeric: "tabular-nums" }}>{dur}s</p>
                </div>
              )}
              <div>
                <p style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 2 }}>Cost</p>
                <p style={{ fontSize: 12, color: "var(--text)", margin: 0, fontVariantNumeric: "tabular-nums" }}>
                  ${Number(run.costUsd).toFixed(6)}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

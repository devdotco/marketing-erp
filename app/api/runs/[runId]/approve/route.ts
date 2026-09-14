import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess } from "@/lib/actions/workspace";
import { getOnApprove } from "@/lib/agent-handlers/on-approve";
import { AgentInputError } from "@/lib/ai/errors";

export const dynamic = "force-dynamic";

/**
 * Approve a run.
 *
 * For most agents this only changes the status. For agents with an approval hook (Email
 * Marketing's Instantly/Apollo/erp.io CRM channels) approval is what SENDS — it moves leads into a
 * live campaign or enrols contacts in a sequence. So:
 *
 *  - Only a workspace admin may approve a run whose approval has a side effect: the same bar as
 *    connecting the integration whose credits and sender reputation it spends.
 *  - The run is CLAIMED atomically before the side effect runs. Two approvals in flight at once (a
 *    double-click, a retry after a timeout, two tabs) used to both pass the AWAITING_APPROVAL
 *    check and both activate. Now exactly one request wins the compare-and-swap; the other gets a
 *    409 and does nothing.
 *  - The activated output is written the moment the side effect returns, with retries. If that
 *    write still fails, the run stays APPROVED — never back in AWAITING_APPROVAL — so nobody can
 *    click Approve again and send a second time.
 *  - If the side effect itself fails, the claim is released back to AWAITING_APPROVAL with the
 *    error, so the person can fix the cause (reconnect, add a segment) and approve again. Each
 *    activate*() also refuses to run twice once it has recorded activatedAt.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;

  const run = await prisma.agentRun.findUnique({ where: { id: runId }, include: { agentConfig: true } });
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const onApprove = getOnApprove(run.agentConfig.agentSlug);
  await requireWorkspaceAccess(run.workspaceId, onApprove ? "WORKSPACE_ADMIN" : "OPERATOR");

  if (run.status !== "AWAITING_APPROVAL") {
    return NextResponse.json({ error: `Run is ${run.status}, not awaiting approval` }, { status: 400 });
  }

  // The claim. Nothing below runs unless this request is the one that moved the run.
  const claimed = await prisma.agentRun.updateMany({
    where: { id: runId, status: "AWAITING_APPROVAL" },
    data: { status: "APPROVED", approvedBy: session.user.id ?? null },
  });
  if (claimed.count !== 1) {
    return NextResponse.json({ error: "This run is already being approved" }, { status: 409 });
  }

  if (!onApprove) {
    return NextResponse.json(await prisma.agentRun.findUnique({ where: { id: runId } }));
  }

  let activatedOutput: Record<string, unknown> | undefined;
  try {
    activatedOutput = await onApprove(run);
  } catch (err) {
    // Release the claim so approval can be retried once the cause is fixed.
    const message = err instanceof Error ? err.message : "Approval failed";
    const output = { ...((run.output ?? {}) as Record<string, unknown>), approvalError: { message, at: new Date().toISOString() } };
    await prisma.agentRun
      .updateMany({ where: { id: runId, status: "APPROVED" }, data: { status: "AWAITING_APPROVAL", approvedBy: null, output } })
      .catch((releaseErr) => console.error(`[approve] could not release claim on ${runId}:`, releaseErr));
    if (err instanceof AgentInputError) {
      return NextResponse.json({ error: err.message, hint: err.hint, code: err.code }, { status: 422 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (activatedOutput) {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const updated = await prisma.agentRun.update({ where: { id: runId }, data: { output: activatedOutput as object } });
        return NextResponse.json(updated);
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
    // The send happened; only the record of it failed. The run is APPROVED, so it cannot be
    // approved (and sent) again. Log everything needed to reconcile by hand.
    console.error(`[approve] run ${runId} activated but output write failed:`, lastErr, JSON.stringify(activatedOutput));
    return NextResponse.json(
      { error: "Approved and sent, but the confirmation could not be saved. Do not re-run; contact support to reconcile." },
      { status: 500 },
    );
  }

  return NextResponse.json(await prisma.agentRun.findUnique({ where: { id: runId } }));
}

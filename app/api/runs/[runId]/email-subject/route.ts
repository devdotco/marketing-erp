import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess } from "@/lib/actions/workspace";
import { isCampaignOutput } from "@/lib/email-campaigns/approve";
import { findPrice } from "@/lib/email-campaigns/checks";
import { resolveProfile } from "@/lib/content/editorial";

export const dynamic = "force-dynamic";

/**
 * Pick the subject a campaign draft goes out with: one of the three offered,
 * or the reviewer's own. Only while the run awaits approval, and through the
 * same price, merge-tag and em-dash rules the draft itself passed. Approval
 * then sets it on the SendGrid Single Send.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await params;

  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await requireWorkspaceAccess(run.workspaceId, "OPERATOR");
  if (run.status !== "AWAITING_APPROVAL" || !isCampaignOutput(run.output)) {
    return NextResponse.json({ error: "This run's subject can't be changed now." }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as { subject?: unknown };
  let subject = typeof body.subject === "string" ? body.subject.replace(/\s+/g, " ").trim() : "";
  const output = run.output as Record<string, unknown>;
  if (output.test === true && !subject.startsWith("[TEST] ")) subject = `[TEST] ${subject}`;

  if (!subject) return NextResponse.json({ error: "The subject is empty." }, { status: 422 });
  if (subject.length > 90) return NextResponse.json({ error: "Keep the subject under 90 characters." }, { status: 422 });
  if (/\{\{/.test(subject)) return NextResponse.json({ error: "The subject can't contain merge tags." }, { status: 422 });
  const price = findPrice(subject);
  if (price) return NextResponse.json({ error: `The subject contains ${price}.` }, { status: 422 });
  const editorial = await prisma.editorialProfile.findUnique({ where: { workspaceId: run.workspaceId } });
  if (!resolveProfile(editorial?.preset, editorial?.overrides).allowEmDash && subject.includes("—")) {
    return NextResponse.json({ error: "No em dashes in the subject." }, { status: 422 });
  }

  const updated = await prisma.agentRun.updateMany({
    where: { id: runId, status: "AWAITING_APPROVAL" },
    data: { output: { ...output, chosenSubject: subject } },
  });
  if (updated.count !== 1) return NextResponse.json({ error: "The run changed while you were editing. Reload." }, { status: 409 });
  return NextResponse.json({ chosenSubject: subject });
}

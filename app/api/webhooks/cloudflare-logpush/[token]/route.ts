import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { resolveWebhookWorkspace } from "@/lib/integrations/webhook-auth";
import { ingestLogBatch } from "@/lib/crawlers/ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Cloudflare Logpush destination — one URL per workspace, the token in the path.
 *
 * Logpush offers no signature, only the URL and optional headers, which is the
 * same constraint Instantly and Aimfox impose; this reuses their token scheme
 * rather than inventing a second one.
 *
 * Cloudflare probes the destination before it will save a job, and treats a
 * non-2xx as a broken endpoint. GET therefore answers 200 for a valid token —
 * without it the job cannot be created at all.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const workspaceId = await resolveWebhookWorkspace("CLOUDFLARE_LOGPUSH", token);
  if (!workspaceId) return NextResponse.json({ error: "Unknown token" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const workspaceId = await resolveWebhookWorkspace("CLOUDFLARE_LOGPUSH", token);
  if (!workspaceId) return NextResponse.json({ error: "Unknown token" }, { status: 404 });

  const body = Buffer.from(await req.arrayBuffer());
  if (body.length === 0) return NextResponse.json({ ok: true, lines: 0 });

  // Which hostnames this workspace owns, so a Logpush job covering a whole
  // Cloudflare account cannot attribute another site's traffic here.
  let hosts: string[] = [];
  try {
    const integration = await prisma.integration.findUnique({
      where: { workspaceId_provider: { workspaceId, provider: "CLOUDFLARE_LOGPUSH" } },
      select: { encryptedCredentials: true },
    });
    if (integration) {
      const creds = await decryptCredentials<{ hosts?: string }>(integration.encryptedCredentials);
      hosts = (creds.hosts ?? "")
        .split(/[\s,]+/)
        .map((h) => h.trim())
        .filter(Boolean);
    }
  } catch {
    // Unreadable credentials must not drop the batch — ingest without the
    // host filter and let the operator notice the missing filter, rather
    // than silently losing a day of crawl data.
  }

  try {
    const result = await ingestLogBatch(workspaceId, body, { hosts });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[logpush] ingest failed:", err instanceof Error ? err.message : err);
    // A 5xx makes Cloudflare retry, which is what we want for a transient
    // failure — the batch hash makes the retry safe.
    return NextResponse.json({ error: "Ingest failed" }, { status: 500 });
  }
}

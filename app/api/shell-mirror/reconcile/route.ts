import { NextResponse } from "next/server";
import { SHELL_ISSUER, shellKeySet } from "@/lib/shell-token";
import { verifyMirrorToken } from "@/lib/shell-mirror/verify";
import { applySnapshot, mirrorContext } from "@/lib/shell-mirror/apply";
import { mirrorEnabled, mirrorSecretMatches } from "@/lib/shell-mirror/gate";

/**
 * POST /api/shell-mirror/reconcile[?dryRun=1][&orgId=…] — pull the shell's full
 * workspace-mirror truth and bring Marketing into line with it.
 *
 * Heals anything a push missed, and materialises the one-off backfill: it adopts
 * DEV.co's existing workspace by the id the shell's new org names (no second
 * DEV.co), creates the twins other orgs lack, links users and sets memberships.
 * Run with `dryRun=1` first; nothing is written and the report lists every change.
 *
 * Auth: `x-shell-mirror-secret: $SHELL_MIRROR_SECRET`, used for the mirror and
 * nothing else; the same secret is sent to the shell's snapshot endpoint. The
 * pulled snapshot is also verified as a shell-signed JWT for aud=marketing, so a
 * wrong SHELL_URL cannot feed it a forged member list. Off unless MIRROR_MODULES
 * includes `marketing` (503). The report is for the operator only.
 *
 * Schedule: a Coolify scheduled task on the Marketing app every 15 minutes. The
 * image has node but not necessarily curl, so:
 *   node -e 'fetch("http://localhost:3000/marketing/api/shell-mirror/reconcile",{method:"POST",headers:{"x-shell-mirror-secret":process.env.SHELL_MIRROR_SECRET}}).then(async r=>{console.log(r.status,await r.text());process.exit(r.ok?0:1)})'
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function shellUrl(): string {
  return (process.env.SHELL_URL ?? "https://app.erp.io").replace(/\/$/, "");
}

export async function POST(req: Request) {
  if (!mirrorSecretMatches(req.headers.get("x-shell-mirror-secret"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!mirrorEnabled("marketing")) return NextResponse.json({ error: "mirror disabled" }, { status: 503 });

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1" || url.searchParams.get("dryRun") === "true";
  const orgId = url.searchParams.get("orgId");

  const snapshotUrl = new URL(`${shellUrl()}/api/shell/mirror/snapshot`);
  snapshotUrl.searchParams.set("aud", "marketing");
  if (orgId) snapshotUrl.searchParams.set("orgId", orgId);

  let token: string;
  try {
    const res = await fetch(snapshotUrl, {
      headers: { "x-shell-mirror-secret": process.env.SHELL_MIRROR_SECRET! },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return NextResponse.json({ error: `shell snapshot answered ${res.status}` }, { status: 502 });
    token = ((await res.json()) as { token?: string }).token ?? "";
  } catch (err) {
    return NextResponse.json({ error: `shell unreachable: ${(err as Error).message}` }, { status: 502 });
  }

  let verified;
  try {
    verified = await verifyMirrorToken(token, shellKeySet, SHELL_ISSUER);
  } catch (err) {
    console.error("[shell-mirror] snapshot failed verification:", (err as Error).message);
    return NextResponse.json({ error: "snapshot failed verification" }, { status: 502 });
  }
  if (verified.kind !== "snapshot") return NextResponse.json({ error: "expected a snapshot" }, { status: 502 });

  const ctx = mirrorContext(dryRun);
  await applySnapshot(verified.snapshot, ctx);

  const counts: Record<string, number> = {};
  for (const r of ctx.report) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  const report = ctx.report.filter((r) => r.kind !== "member.unchanged");
  // Every removal and role change, listed on its own so a dry run cannot bury one.
  const removals = ctx.report.filter((r) => r.kind === "member.removed");
  const roleChanges = ctx.report.filter((r) => r.kind === "member.role_changed");
  return NextResponse.json({ dryRun, orgs: verified.snapshot.orgs.length, counts, removals, roleChanges, report });
}

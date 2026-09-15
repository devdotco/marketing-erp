import { Prisma, type MemberRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  decideUserLink,
  isNewer,
  localAccountVerified,
  mirroredMarketingRole,
  memberKey,
  mirrorMayRemove,
  orgKey,
  snapshotRemovals,
  type MirrorEvent,
  type MirrorMember,
  type MirrorOrg,
  type MirrorRetiredOrg,
  type MirrorSnapshot,
  type MirrorUser,
  PLATFORM_SUPER_ADMIN_REFUSAL,
  platformAdminMayJoin,
} from "./protocol";
import { isPlatformSuperAdmin } from "@/lib/platform-admin";

/**
 * Applying shell mirror state to Marketing's tables — the one implementation
 * behind pushed events, the reconcile, its dry run, and the SSO hand-off.
 *
 * Writes only: `Workspace` (created for an org with none, ADOPTED by id when the
 * shell names an unlinked workspace — DEV.co's — and renamed to the org's name),
 * `User` (created or linked — verified addresses only), and `WorkspaceMember`
 * (created with `source = 'mirror'`, re-roled, deleted).
 *
 * Removal is narrow on purpose (owner decision, 2026-09-14): only memberships
 * the mirror created are ever deleted. In-app invites (`app`), rows that predate
 * the mirror (`legacy`) and any SUPER_ADMIN membership stay. Never a workspace's
 * data, integrations, runs or plays, and never a workspace itself.
 */

export type MirrorReportEntry = {
  kind:
    | "workspace.created"
    | "workspace.adopted"
    | "workspace.renamed"
    | "member.added"
    | "member.role_changed"
    | "member.unchanged"
    | "member.removed"
    | "user.linked"
    | "user.created"
    | "link.refused"
    | "stale"
    | "unmanaged"
    | "conflict";
  orgId: string;
  email?: string;
  detail?: string;
};

export type MirrorContext = {
  dryRun: boolean;
  report: MirrorReportEntry[];
  workspaces: Map<string, { id: string | null; name: string } | null>;
};

export function mirrorContext(dryRun = false): MirrorContext {
  return { dryRun, report: [], workspaces: new Map() };
}

type Db = Prisma.TransactionClient | typeof prisma;

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

export async function uniqueWorkspaceSlug(base: string, db: Db = prisma): Promise<string> {
  const root = slugify(base) || "workspace";
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`;
    const taken = await db.workspace.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!taken) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}

async function claimVersion(tx: Prisma.TransactionClient, key: string, version: number, removed = false): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ key: string }>>`
    INSERT INTO "ShellMirrorVersion" ("key", "version", "removed", "updatedAt")
    VALUES (${key}, ${BigInt(version)}, ${removed}, now())
    ON CONFLICT ("key") DO UPDATE SET "version" = EXCLUDED."version", "removed" = EXCLUDED."removed", "updatedAt" = now()
    WHERE "ShellMirrorVersion"."version" < EXCLUDED."version"
    RETURNING "key"`;
  return rows.length === 1;
}

async function wouldClaim(key: string, version: number): Promise<boolean> {
  const row = await prisma.shellMirrorVersion.findUnique({ where: { key }, select: { version: true } });
  return isNewer(row?.version, version);
}

/**
 * The org's workspace: found by shellOrgId, adopted by id when the shell names
 * an unlinked one, or created. Null on a conflict (reported, nothing written).
 *
 * Creating or adopting also CLAIMS the org's version (when one is given) and
 * sets the name in the same transaction, so a delayed older `org.upserted`
 * cannot rename it back. The hand-off passes no version: it has no ordering.
 */
export async function ensureWorkspace(
  org: MirrorOrg,
  ctx: MirrorContext,
  version: number | null = null,
): Promise<{ id: string | null; name: string } | null> {
  if (ctx.workspaces.has(org.id)) return ctx.workspaces.get(org.id)!;
  const remember = (w: { id: string | null; name: string } | null) => (ctx.workspaces.set(org.id, w), w);

  const existing = await prisma.workspace.findUnique({ where: { shellOrgId: org.id }, select: { id: true, name: true } });
  if (existing) return remember(existing);

  if (org.adopt?.marketing) {
    const target = await prisma.workspace.findUnique({
      where: { id: org.adopt.marketing },
      select: { id: true, name: true, slug: true, shellOrgId: true },
    });
    if (!target) {
      ctx.report.push({ kind: "conflict", orgId: org.id, detail: `adopt: workspace ${org.adopt.marketing} does not exist — nothing created` });
      return remember(null);
    }
    if (target.shellOrgId && target.shellOrgId !== org.id) {
      ctx.report.push({ kind: "conflict", orgId: org.id, detail: `adopt: workspace ${target.slug} already belongs to org ${target.shellOrgId}` });
      return remember(null);
    }
    ctx.report.push({ kind: "workspace.adopted", orgId: org.id, detail: target.slug });
    if (ctx.dryRun) return remember({ id: target.id, name: org.name });
    const adopted = await prisma.$transaction(async (tx) => {
      // Guarded on NULL: an adoption never moves a workspace another org owns.
      const moved = await tx.workspace.updateMany({ where: { id: target.id, shellOrgId: null }, data: { shellOrgId: org.id } });
      if (moved.count !== 1) return false;
      if (version !== null && (await claimVersion(tx, orgKey(org.id), version))) {
        await tx.workspace.update({ where: { id: target.id }, data: { name: org.name } });
      }
      return true;
    });
    if (!adopted) {
      const now = await prisma.workspace.findUnique({ where: { shellOrgId: org.id }, select: { id: true, name: true } });
      if (now) return remember(now);
      ctx.report.push({ kind: "conflict", orgId: org.id, detail: `adopt: workspace ${target.slug} was linked elsewhere concurrently` });
      return remember(null);
    }
    return remember(await prisma.workspace.findUnique({ where: { id: target.id }, select: { id: true, name: true } }));
  }

  ctx.report.push({ kind: "workspace.created", orgId: org.id, detail: org.name });
  if (ctx.dryRun) return remember({ id: null, name: org.name });
  try {
    const slug = await uniqueWorkspaceSlug(org.slug);
    const created = await prisma.$transaction(async (tx) => {
      const w = await tx.workspace.create({ data: { shellOrgId: org.id, name: org.name, slug }, select: { id: true, name: true } });
      if (version !== null) await claimVersion(tx, orgKey(org.id), version);
      return w;
    });
    return remember(created);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const now = await prisma.workspace.findUnique({ where: { shellOrgId: org.id }, select: { id: true, name: true } });
      if (now) return remember(now);
    }
    throw err;
  }
}

const USER_SELECT = { id: true, email: true, shellUserId: true, name: true, emailVerified: true, referralSource: true } as const;

function localUser<T extends { id: string; email: string; shellUserId: string | null; emailVerified: Date | null; referralSource: string | null }>(u: T | null) {
  return u ? { ...u, emailVerified: localAccountVerified(u) } : null;
}

/**
 * The local account for a shell user, linking or creating it. Returns null when
 * linking is refused (see decideUserLink) — including for any unverified
 * address — and the caller must not proceed.
 */
export async function resolveShellUser(
  shellUser: MirrorUser,
  db: Db = prisma,
  onEvent?: (kind: "user.linked" | "user.created" | "link.refused", detail?: string) => void,
): Promise<{ id: string; email: string; name: string | null; image: string | null } | null> {
  const email = shellUser.email.trim().toLowerCase();
  const [byShellId, byEmail] = await Promise.all([
    db.user.findUnique({ where: { shellUserId: shellUser.id }, select: USER_SELECT }),
    db.user.findUnique({ where: { email }, select: USER_SELECT }),
  ]);
  const decision = decideUserLink(shellUser, localUser(byShellId), localUser(byEmail));
  const full = { id: true, email: true, name: true, image: true } as const;

  switch (decision.action) {
    case "refuse":
      onEvent?.("link.refused", decision.reason);
      return null;
    case "create": {
      onEvent?.("user.created");
      return db.user.create({
        data: {
          email,
          name: shellUser.name || email,
          shellUserId: shellUser.id,
          // The shell verified this address (decideUserLink refuses otherwise).
          emailVerified: new Date(),
          referralSource: "erp.io shell",
        },
        select: full,
      });
    }
    case "link":
      onEvent?.("user.linked");
      return db.user.update({
        where: { id: decision.userId },
        data: { shellUserId: shellUser.id, ...(!byEmail!.name && shellUser.name ? { name: shellUser.name } : {}) },
        select: full,
      });
    case "use":
      return db.user.update({
        where: { id: decision.userId },
        // The shell owns identity, so its display name wins — as the hand-off always did here.
        data: shellUser.name && shellUser.name !== byShellId!.name ? { name: shellUser.name } : {},
        select: full,
      });
  }
}

export async function applyOrg(org: MirrorOrg, version: number, ctx: MirrorContext): Promise<void> {
  const ws = await ensureWorkspace(org, ctx, version);
  if (!ws?.id || ws.name === org.name) return;

  if (ctx.dryRun) {
    if (await wouldClaim(orgKey(org.id), version)) ctx.report.push({ kind: "workspace.renamed", orgId: org.id, detail: `${ws.name} → ${org.name}` });
    return;
  }
  await prisma.$transaction(async (tx) => {
    if (!(await claimVersion(tx, orgKey(org.id), version))) return void ctx.report.push({ kind: "stale", orgId: org.id, detail: "org name" });
    await tx.workspace.update({ where: { id: ws.id! }, data: { name: org.name } });
    ctx.report.push({ kind: "workspace.renamed", orgId: org.id, detail: `${ws.name} → ${org.name}` });
    ws.name = org.name;
  });
}

export async function applyMemberUpsert(org: MirrorOrg, member: MirrorMember, version: number, ctx: MirrorContext): Promise<void> {
  const email = member.user.email;
  // Before anything — including creating the workspace — so an unverified
  // person leaves no trace.
  if (member.user.emailVerified !== true) {
    ctx.report.push({ kind: "link.refused", orgId: org.id, email, detail: "shell email unverified — skipped" });
    return;
  }
  // A platform super admin is never given a membership in an OUTSIDE org —
  // checked before the workspace, so it is not created for them either.
  // (Internal orgs are decided without the lookup: platformAdminMayJoin allows them.)
  if (org.internal !== true && !platformAdminMayJoin(org, await localPlatformSuperAdmin(member.user))) {
    ctx.report.push({ kind: "link.refused", orgId: org.id, email, detail: PLATFORM_SUPER_ADMIN_REFUSAL });
    return;
  }
  const ws = await ensureWorkspace(org, ctx, version);
  if (!ws) return;
  const key = memberKey(org.id, member.user.id);

  if (ctx.dryRun) {
    const [byShellId, byEmail] = await Promise.all([
      prisma.user.findUnique({ where: { shellUserId: member.user.id }, select: USER_SELECT }),
      prisma.user.findUnique({ where: { email }, select: USER_SELECT }),
    ]);
    const decision = decideUserLink(member.user, localUser(byShellId), localUser(byEmail));
    if (decision.action === "refuse") return void ctx.report.push({ kind: "link.refused", orgId: org.id, email, detail: decision.reason });
    if (!(await wouldClaim(key, version))) return void ctx.report.push({ kind: "stale", orgId: org.id, email });
    if (decision.action === "link") ctx.report.push({ kind: "user.linked", orgId: org.id, email });
    if (decision.action === "create") ctx.report.push({ kind: "user.created", orgId: org.id, email });
    const userId = decision.action === "create" ? null : decision.userId;
    const existing = ws.id && userId
      ? await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: ws.id, userId } }, select: { role: true, source: true } })
      : null;
    reportMembership(ctx, org.id, email, existing?.role ?? null, mirroredMarketingRole(member.role, existing), existing?.source);
    return;
  }

  await prisma.$transaction(async (tx) => {
    if (!(await claimVersion(tx, key, version))) return void ctx.report.push({ kind: "stale", orgId: org.id, email });
    let refused = false;
    const user = await resolveShellUser(member.user, tx, (kind, detail) => {
      if (kind === "link.refused") refused = true;
      ctx.report.push({ kind, orgId: org.id, email, detail });
    });
    if (!user || refused) {
      // Throwing rolls the version back, so a later event is not mistaken for a stale one.
      throw new LinkRefused();
    }
    const existing = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: ws.id!, userId: user.id } },
      select: { id: true, role: true, source: true },
    });
    // Only a mirror-created row is re-roled; an invited or legacy row keeps its role.
    const role = mirroredMarketingRole(member.role, existing);
    if (!existing) await tx.workspaceMember.create({ data: { workspaceId: ws.id!, userId: user.id, role, source: "mirror" } });
    else if (existing.role !== role) await tx.workspaceMember.update({ where: { id: existing.id }, data: { role } });
    reportMembership(ctx, org.id, email, existing?.role ?? null, role, existing?.source);
  }).catch((err) => {
    if (!(err instanceof LinkRefused)) throw err;
  });
}

class LinkRefused extends Error {}

/**
 * Whether the local account this shell user would reach — by shell id, else by
 * email — is a Marketing platform super admin. Either match counts: refusing is
 * the safe answer, and a verified shell address IS that person.
 */
async function localPlatformSuperAdmin(shellUser: MirrorUser): Promise<boolean> {
  const [byShellId, byEmail] = await Promise.all([
    prisma.user.findUnique({ where: { shellUserId: shellUser.id }, select: { id: true } }),
    prisma.user.findUnique({ where: { email: shellUser.email.trim().toLowerCase() }, select: { id: true } }),
  ]);
  for (const u of [byShellId, byEmail]) {
    if (u && (await isPlatformSuperAdmin(u.id))) return true;
  }
  return false;
}

function reportMembership(ctx: MirrorContext, orgId: string, email: string, before: MemberRole | null, after: MemberRole, source?: string) {
  if (!before) ctx.report.push({ kind: "member.added", orgId, email, detail: after });
  else if (before !== after) ctx.report.push({ kind: "member.role_changed", orgId, email, detail: `${before} → ${after}` });
  else ctx.report.push({ kind: "member.unchanged", orgId, email, detail: source && source !== "mirror" ? `${after} (${source} role kept)` : after });
}

export async function applyMemberRemoval(
  org: MirrorOrg,
  shellUserId: string,
  version: number,
  ctx: MirrorContext,
  /** Appended to the report's `member.removed` entry (the retired-org reconcile says why). */
  why?: string,
): Promise<void> {
  const [ws, user] = await Promise.all([
    prisma.workspace.findUnique({ where: { shellOrgId: org.id }, select: { id: true } }),
    prisma.user.findUnique({ where: { shellUserId }, select: { id: true, email: true, shellUserId: true } }),
  ]);
  const key = memberKey(org.id, shellUserId);
  const membership = ws && user
    ? await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: ws.id, userId: user.id } }, select: { id: true, role: true, source: true } })
    : null;
  const removable = !!membership && mirrorMayRemove({ shellUserId: user!.shellUserId, source: membership.source, role: membership.role });

  if (ctx.dryRun) {
    if (!(await wouldClaim(key, version))) return void ctx.report.push({ kind: "stale", orgId: org.id, email: user?.email });
    if (removable) ctx.report.push({ kind: "member.removed", orgId: org.id, email: user!.email, ...(why ? { detail: why } : {}) });
    else if (membership) ctx.report.push({ kind: "unmanaged", orgId: org.id, email: user?.email, detail: `${membership.role} (${membership.source}): kept` });
    return;
  }

  await prisma.$transaction(async (tx) => {
    // The tombstone is recorded even when there is nothing to delete: it is what
    // stops a delayed, older "added" event — or a hand-off token older than this
    // removal — from putting this person back.
    if (!(await claimVersion(tx, key, version, true))) return void ctx.report.push({ kind: "stale", orgId: org.id, email: user?.email });
    if (!removable) {
      if (membership) ctx.report.push({ kind: "unmanaged", orgId: org.id, email: user?.email, detail: `${membership.role} (${membership.source}): kept` });
      return;
    }
    const res = await tx.workspaceMember.deleteMany({ where: { id: membership!.id, source: "mirror", NOT: { role: "SUPER_ADMIN" } } });
    if (res.count) ctx.report.push({ kind: "member.removed", orgId: org.id, email: user!.email, ...(why ? { detail: why } : {}) });
  });
}

export async function applyOrgSnapshot(org: MirrorOrg, members: MirrorMember[], version: number, ctx: MirrorContext): Promise<void> {
  await applyOrg(org, version, ctx);
  for (const m of members) await applyMemberUpsert(org, m, version, ctx);

  const ws = ctx.workspaces.get(org.id);
  if (!ws?.id) return;
  const rows = await prisma.workspaceMember.findMany({
    where: { workspaceId: ws.id },
    select: { role: true, source: true, user: { select: { shellUserId: true, email: true } } },
  });
  const emailsInSnapshot = new Set(members.map((m) => m.user.email));
  const { remove, unmanaged } = snapshotRemovals(
    rows.map((r) => ({ role: r.role, source: r.source, email: r.user.email, shellUserId: r.user.shellUserId })),
    new Set(members.map((m) => m.user.id)),
  );
  for (const r of remove) await applyMemberRemoval(org, r.shellUserId!, version, ctx);
  for (const u of unmanaged) {
    if (emailsInSnapshot.has(u.email.toLowerCase())) continue;
    ctx.report.push({ kind: "unmanaged", orgId: org.id, email: u.email, detail: `${u.role} (${u.source}): not removed by the mirror` });
  }
}

export async function applyEvent(event: MirrorEvent, ctx: MirrorContext): Promise<void> {
  switch (event.type) {
    case "org.upserted":
      return applyOrg(event.org, event.version, ctx);
    case "member.upserted":
      return applyMemberUpsert(event.org, event.member, event.version, ctx);
    case "member.removed":
      return applyMemberRemoval(event.org, event.userId, event.version, ctx);
    case "org.snapshot":
      return applyOrgSnapshot(event.org, event.members, event.version, ctx);
  }
}

/** The report detail on a removal made because the org is no longer mirrored. */
export const RETIRED_REMOVAL_DETAIL = "org no longer eligible for the mirror: remove-only";

/**
 * A mirrored org that is not eligible now: REMOVE-ONLY.
 *
 * Deletes mirror-created memberships, in the org's EXISTING workspace, of
 * anyone not in `memberUserIds` — the same rule, through the same
 * `applyMemberRemoval` (source = 'mirror' only, never a SUPER_ADMIN row,
 * version-gated with a tombstone) as a full snapshot. It never creates, adopts
 * or renames a workspace and never adds or re-roles a member: an ineligible org
 * gets nothing new. Heals a missed removal of an org's last eligible member,
 * which is exactly the write that made it ineligible.
 */
export async function applyRetiredOrg(
  retired: MirrorRetiredOrg,
  workspaceId: string,
  version: number,
  ctx: MirrorContext,
): Promise<void> {
  // Only `id` is ever read from the org on the removal path.
  const org: MirrorOrg = { id: retired.orgId, name: "", slug: "" };
  const rows = await prisma.workspaceMember.findMany({
    where: { workspaceId },
    select: { role: true, source: true, user: { select: { shellUserId: true, email: true } } },
  });
  const { remove } = snapshotRemovals(
    rows.map((r) => ({ role: r.role, source: r.source, email: r.user.email, shellUserId: r.user.shellUserId })),
    new Set(retired.memberUserIds),
  );
  for (const r of remove) await applyMemberRemoval(org, r.shellUserId!, version, ctx, RETIRED_REMOVAL_DETAIL);
}

export async function applySnapshot(snapshot: MirrorSnapshot, ctx: MirrorContext): Promise<void> {
  for (const { org, members } of snapshot.orgs) {
    try {
      await applyOrgSnapshot(org, members, snapshot.version, ctx);
    } catch (err) {
      ctx.report.push({ kind: "conflict", orgId: org.id, detail: `failed: ${(err as Error).message}` });
    }
  }

  // Retired orgs: one lookup for all of them; only those with an existing
  // workspace go further. An id also present in `orgs` is ignored — the shell
  // never sends both, and the full snapshot is the stronger statement.
  const live = new Set(snapshot.orgs.map((o) => o.org.id));
  const retired = (snapshot.retired ?? []).filter((r) => !live.has(r.orgId));
  if (retired.length === 0) return;
  const workspaces = await prisma.workspace.findMany({
    where: { shellOrgId: { in: retired.map((r) => r.orgId) } },
    select: { id: true, shellOrgId: true },
  });
  const workspaceFor = new Map(workspaces.map((w) => [w.shellOrgId!, w.id]));
  for (const r of retired) {
    const workspaceId = workspaceFor.get(r.orgId);
    if (!workspaceId) continue;
    try {
      await applyRetiredOrg(r, workspaceId, snapshot.version, ctx);
    } catch (err) {
      ctx.report.push({ kind: "conflict", orgId: r.orgId, detail: `failed (retired): ${(err as Error).message}` });
    }
  }
}

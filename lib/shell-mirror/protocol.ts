/**
 * The Marketing/CRM workspace mirror, from Marketing's side — pure decisions only.
 *
 * The shell (app.erp.io) is the source of truth for which organizations exist,
 * what they are called, who belongs to them and in what role. A Marketing
 * workspace is a projection keyed by `Workspace.shellOrgId`, kept current by
 * signed events pushed to /api/shell-mirror/events and a signed snapshot pulled
 * in /api/shell-mirror/reconcile. Both run through lib/shell-mirror/apply.ts.
 *
 * The contract is defined in app-erp-io `lib/shell/mirror/protocol.ts`; this is
 * Marketing's copy of what it needs. No database here, so every rule is
 * covered by test/mirror.test.ts.
 */

import type { MemberRole } from "@prisma/client";

export const MIRROR_JWT_TYPE = "erp-mirror+jwt";
export const MIRROR_SUBJECT = "shell:mirror";
export const MIRROR_AUDIENCE = "marketing";
export const MIRROR_MAX_TTL_SECONDS = 300;

export type LadderRole = "VIEWER" | "OPERATOR" | "WORKSPACE_ADMIN" | "SUPER_ADMIN";
const LADDER: readonly LadderRole[] = ["VIEWER", "OPERATOR", "WORKSPACE_ADMIN", "SUPER_ADMIN"];

export type MirrorAdopt = { crm?: string; marketing?: string };
export type MirrorOrg = { id: string; name: string; slug: string; adopt?: MirrorAdopt; internal?: boolean };
export type MirrorUser = { id: string; email: string; name: string; emailVerified: boolean };
export type MirrorMember = { user: MirrorUser; role: LadderRole };

export type MirrorEvent =
  | { type: "org.upserted"; version: number; org: MirrorOrg }
  | { type: "member.upserted"; version: number; org: MirrorOrg; member: MirrorMember }
  | { type: "member.removed"; version: number; org: MirrorOrg; userId: string }
  | { type: "org.snapshot"; version: number; org: MirrorOrg; members: MirrorMember[] };

export type MirrorSnapshot = { version: number; orgs: Array<{ org: MirrorOrg; members: MirrorMember[] }> };

export class MirrorPayloadError extends Error {}

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || !v.trim()) throw new MirrorPayloadError(`${what} must be a non-empty string`);
  return v;
}

function version(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new MirrorPayloadError("version must be a positive integer");
  return v;
}

/**
 * The org id is the tenancy key. An empty or missing id must never reach
 * `where: { shellOrgId }` — every workspace created by local sign-up has a NULL
 * there, and a careless null would match them.
 */
export function orgIdOf(v: unknown): string {
  return str(v, "org.id");
}

function parseOrg(v: unknown): MirrorOrg {
  const o = (v ?? {}) as Record<string, unknown>;
  const org: MirrorOrg = { id: orgIdOf(o.id), name: str(o.name, "org.name"), slug: str(o.slug, "org.slug") };
  const a = o.adopt as Record<string, unknown> | undefined;
  if (a && typeof a === "object") {
    const adopt: MirrorAdopt = {};
    if (typeof a.crm === "string" && a.crm) adopt.crm = a.crm;
    if (typeof a.marketing === "string" && a.marketing) adopt.marketing = a.marketing;
    if (adopt.crm || adopt.marketing) org.adopt = adopt;
  }
  if (o.internal === true) org.internal = true;
  return org;
}

function parseMember(v: unknown): MirrorMember {
  const m = (v ?? {}) as Record<string, unknown>;
  const u = (m.user ?? {}) as Record<string, unknown>;
  const role = m.role;
  if (typeof role !== "string" || !(LADDER as readonly string[]).includes(role)) {
    throw new MirrorPayloadError("member.role must be a ladder role");
  }
  return {
    user: {
      id: str(u.id, "member.user.id"),
      email: str(u.email, "member.user.email").trim().toLowerCase(),
      name: typeof u.name === "string" ? u.name : "",
      emailVerified: u.emailVerified === true,
    },
    role: role as LadderRole,
  };
}

export function parseEvent(v: unknown): MirrorEvent {
  const e = (v ?? {}) as Record<string, unknown>;
  const org = parseOrg(e.org);
  const ver = version(e.version);
  switch (e.type) {
    case "org.upserted":
      return { type: "org.upserted", version: ver, org };
    case "member.upserted":
      return { type: "member.upserted", version: ver, org, member: parseMember(e.member) };
    case "member.removed":
      return { type: "member.removed", version: ver, org, userId: str(e.userId, "userId") };
    case "org.snapshot":
      if (!Array.isArray(e.members)) throw new MirrorPayloadError("members must be an array");
      return { type: "org.snapshot", version: ver, org, members: e.members.map(parseMember) };
    default:
      throw new MirrorPayloadError(`unknown event type ${String(e.type)}`);
  }
}

export function parseSnapshot(v: unknown): MirrorSnapshot {
  const s = (v ?? {}) as Record<string, unknown>;
  if (!Array.isArray(s.orgs)) throw new MirrorPayloadError("snap.orgs must be an array");
  return {
    version: version(s.version),
    orgs: s.orgs.map((o) => {
      const row = (o ?? {}) as Record<string, unknown>;
      if (!Array.isArray(row.members)) throw new MirrorPayloadError("snap.orgs[].members must be an array");
      return { org: parseOrg(row.org), members: row.members.map(parseMember) };
    }),
  };
}

/**
 * The Marketing role a mirrored member ends up with.
 *
 *   shell ladder      → WorkspaceMember.role
 *   SUPER_ADMIN       → WORKSPACE_ADMIN   (the shell means "owns their org")
 *   WORKSPACE_ADMIN   → WORKSPACE_ADMIN
 *   OPERATOR          → OPERATOR
 *   VIEWER            → VIEWER
 *
 * SUPER_ADMIN here is a PLATFORM flag — any SUPER_ADMIN membership anywhere
 * unlocks /superadmin across every workspace — so it is NEVER granted from the
 * shell. It is also never taken away by a role change: the shell cannot express
 * it, so it cannot speak for it. An existing SUPER_ADMIN membership stays one;
 * only removing the person from the org (which deletes the membership) ends it.
 */
export function marketingRoleFor(ladder: LadderRole | string | null | undefined, existing?: MemberRole | null): MemberRole {
  if (existing === "SUPER_ADMIN") return "SUPER_ADMIN";
  switch (ladder) {
    case "SUPER_ADMIN":
    case "WORKSPACE_ADMIN":
      return "WORKSPACE_ADMIN";
    case "OPERATOR":
      return "OPERATOR";
    default:
      // Anything unrecognised is the least it could mean.
      return "VIEWER";
  }
}

/**
 * The role a membership ends with after a mirror upsert or hand-off. Only a row
 * the mirror created follows the shell; an invited or legacy row keeps the role
 * set here. SUPER_ADMIN is kept either way and never granted.
 */
export function mirroredMarketingRole(
  ladder: LadderRole | string | null | undefined,
  existing: { role: MemberRole; source: string } | null | undefined,
): MemberRole {
  if (existing && existing.source !== "mirror") return existing.role;
  return marketingRoleFor(ladder, existing?.role);
}

/** Apply only a strictly newer state. Equal is a duplicate delivery — a no-op, not an error. */
export function isNewer(stored: bigint | number | null | undefined, incoming: number): boolean {
  if (stored === null || stored === undefined) return true;
  return BigInt(incoming) > BigInt(stored);
}

export const orgKey = (shellOrgId: string) => `org:${orgIdOf(shellOrgId)}`;
export const memberKey = (shellOrgId: string, shellUserId: string) => `member:${orgIdOf(shellOrgId)}:${shellUserId}`;

/**
 * A Marketing account. `emailVerified` means Marketing itself trusts the address:
 * `User.emailVerified` is set (its own magic link) or the shell created the row.
 * A password sign-up here never verifies, so it does not count.
 */
export type LocalUser = { id: string; email: string; shellUserId: string | null; emailVerified: boolean };

/** Whether a Marketing user row counts as verified for linking. */
export function localAccountVerified(u: { emailVerified: Date | string | null; referralSource?: string | null }): boolean {
  return u.emailVerified !== null || u.referralSource === "erp.io shell";
}

export type LinkDecision =
  | { action: "use"; userId: string }
  | { action: "link"; userId: string }
  | { action: "create" }
  | { action: "refuse"; reason: string };

/**
 * Which local account a shell user is: the one carrying their shell id; else
 * the one with their email if it is unlinked AND the shell verified the address;
 * else a new account. Linking on an unverified address would let anyone sign up
 * in the shell with someone else's email and inherit their workspaces.
 */
export function decideUserLink(
  shellUser: { id: string; emailVerified: boolean },
  byShellId: LocalUser | null,
  byEmail: LocalUser | null,
): LinkDecision {
  // Unverified people are skipped ENTIRELY: creating an account would stamp an
  // unproven address as verified and link it permanently. The shell pushes them
  // again the moment they verify.
  if (shellUser.emailVerified !== true) {
    return { action: "refuse", reason: "shell email is unverified; nobody is created or linked until it is verified" };
  }
  if (byShellId) return { action: "use", userId: byShellId.id };
  if (!byEmail) return { action: "create" };
  if (byEmail.shellUserId && byEmail.shellUserId !== shellUser.id) {
    return { action: "refuse", reason: "email belongs to an account linked to a different shell user" };
  }
  // PRE-HIJACK: Marketing's own sign-up never verifies an address, so an account
  // here may have been registered by someone who merely typed this email. Linking
  // it would give that account (and its password, and any live JWT session) the
  // shell user's workspaces. Only a verified or shell-created account is linked.
  if (!byEmail.emailVerified) {
    return { action: "refuse", reason: "the existing Marketing account with this email was never verified; it is not linked" };
  }
  return { action: "link", userId: byEmail.id };
}

/**
 * Memberships a snapshot removes: CREATED BY THE MIRROR (`source = 'mirror'`),
 * of an account linked to a shell user who is not in the snapshot, and never a
 * SUPER_ADMIN membership (the platform operator flag the shell cannot express).
 * In-app invites and legacy rows stay (owner decision 2026-09-14) and are reported.
 */
export function snapshotRemovals<T extends { shellUserId: string | null; source: string; role: string }>(
  memberships: T[],
  snapshotShellUserIds: ReadonlySet<string>,
): { remove: T[]; unmanaged: T[] } {
  const remove: T[] = [];
  const unmanaged: T[] = [];
  for (const m of memberships) {
    if (m.shellUserId && snapshotShellUserIds.has(m.shellUserId)) continue;
    if (mirrorMayRemove(m)) remove.push(m);
    else unmanaged.push(m);
  }
  return { remove, unmanaged };
}

export function mirrorMayRemove(m: { shellUserId: string | null; source: string; role: string }): boolean {
  return m.source === "mirror" && !!m.shellUserId && m.role !== "SUPER_ADMIN";
}

/**
 * Whether the shell hand-off may create a membership, given the last mirror
 * state recorded for it. A removal recorded at or after the moment the token was
 * minted wins: the token is older news than the removal.
 */
export function signInMayRestore(
  tombstone: { version: bigint | number; removed: boolean } | null | undefined,
  tokenIssuedAtSeconds: number | null | undefined,
): boolean {
  if (!tombstone?.removed) return true;
  if (!tokenIssuedAtSeconds) return false;
  return BigInt(Math.trunc(tokenIssuedAtSeconds)) * BigInt(1_000_000) > BigInt(tombstone.version);
}

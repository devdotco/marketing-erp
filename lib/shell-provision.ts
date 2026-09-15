import { prisma } from "@/lib/prisma";
import type { ShellClaims } from "@/lib/shell-token";
import { ShellTokenInvalid } from "@/lib/shell-token";
import { ensureWorkspace, mirrorContext, resolveShellUser } from "@/lib/shell-mirror/apply";
import { memberKey, mirroredMarketingRole, platformAdminMayJoin, signInMayRestore } from "@/lib/shell-mirror/protocol";
import { isPlatformSuperAdmin } from "@/lib/platform-admin";

/**
 * Turn a verified shell identity into a local user, workspace and membership.
 *
 * Since the Marketing/CRM mirror (lib/shell-mirror), the shell PUSHES orgs,
 * members and roles here and a reconcile heals anything missed — so this is only
 * the first-contact fallback: somebody arriving before the mirror has told us
 * about them still lands in their workspace. It uses the mirror's own functions,
 * so the two cannot disagree about who a person is or what role they hold.
 *
 * Three refusals, each closing a way back in:
 *
 *   - An address the shell has not verified — a MISSING claim included — gets no
 *     account, no link and no membership. The shell does not hand off to
 *     Marketing for one anyway; this is the belt to that brace.
 *   - Identity is matched on the shell USER ID; an existing local account is
 *     linked by email only for a verified address.
 *   - A membership the mirror REMOVED is not recreated by a token minted before
 *     that removal (`signInMayRestore` against the version tombstone). Before
 *     this, a removed member who still held a token was put straight back.
 *   - A PLATFORM super admin acting as an org the shell has not marked internal
 *     (`org_internal`) is signed in, but nothing is written for that org — no
 *     workspace, no membership, no re-role (`platformAdminMayJoin`). Their
 *     reach into customer workspaces is /superadmin, not a membership row.
 *
 * Returns the workspace the token's org maps to, so the caller can make it the
 * active one: switching org in the shell and opening Marketing should land in
 * that org's workspace, not whichever one the cookie last pointed at.
 */
export async function provisionFromShell(claims: ShellClaims) {
  if (claims.emailVerified !== true) {
    throw new ShellTokenInvalid("shell email is not verified");
  }

  const user = await resolveShellUser({
    id: claims.sub,
    email: claims.email,
    name: claims.name,
    emailVerified: true,
  });
  if (!user) throw new ShellTokenInvalid("existing account could not be linked to this shell user");

  // No organisation on the token means the shell could not resolve one. It
  // still signs the person in — being unable to name a workspace is not a
  // reason to refuse a valid identity.
  if (!claims.org) return { user, workspaceId: null as string | null };

  if (!platformAdminMayJoin({ internal: claims.orgInternal }, await isPlatformSuperAdmin(user.id))) {
    // Read-only from here. Land in that workspace only if they are ALREADY a
    // member of it (a row that predates this rule); otherwise land nowhere.
    const ws = await prisma.workspace.findUnique({ where: { shellOrgId: claims.org }, select: { id: true } });
    const member = ws
      ? await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: ws.id, userId: user.id } }, select: { id: true } })
      : null;
    console.warn(`[auth] shell hand-off for ${claims.email}: platform super admin acting as outside org ${claims.org} — signed in, no membership written`);
    return { user, workspaceId: member ? ws!.id : null };
  }

  // The token carries no adoption anchor, so a brand-new org gets a new
  // workspace here. That is why the backfill runs the reconcile (which DOES
  // carry the anchor) before switching Marketing on for the orgs it touches.
  const ctx = mirrorContext(false);
  const ws = await ensureWorkspace(
    { id: claims.org, name: claims.orgName ?? "Workspace", slug: claims.orgName ?? claims.org },
    ctx,
  );
  if (!ws?.id) return { user, workspaceId: null as string | null };

  const [existing, tombstone] = await Promise.all([
    prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: ws.id, userId: user.id } },
      select: { id: true, role: true, source: true },
    }),
    prisma.shellMirrorVersion.findUnique({
      where: { key: memberKey(claims.org, claims.sub) },
      select: { version: true, removed: true },
    }),
  ]);

  if (!existing && !signInMayRestore(tombstone, claims.issuedAt)) {
    // Removed by the mirror after this token was minted. Signed in, but not
    // back into that workspace.
    console.warn(`[auth] shell hand-off for ${claims.email}: membership in ${claims.org} was removed after this token was minted — not recreated`);
    return { user, workspaceId: null as string | null };
  }

  if (claims.orgName && ws.name !== claims.orgName) {
    await prisma.workspace.update({ where: { id: ws.id }, data: { name: claims.orgName } });
  }
  // SUPER_ADMIN is never granted from a hand-off (it is a platform flag here,
  // and every shell sign-up is SUPER_ADMIN of their own org) and never taken
  // away by one — see marketingRoleFor.
  // Only a mirror-created row follows the shell's role; an invited or legacy
  // membership keeps the role set here (mirroredMarketingRole).
  const role = mirroredMarketingRole(claims.role, existing);
  if (!existing) {
    // Created from the shell's word, so the shell may take it away again.
    await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, role, source: "mirror" } });
  } else if (existing.role !== role) {
    await prisma.workspaceMember.update({ where: { id: existing.id }, data: { role } });
  }

  return { user, workspaceId: ws.id };
}

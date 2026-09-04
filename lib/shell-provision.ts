import { prisma } from "@/lib/prisma";
import type { ShellClaims } from "@/lib/shell-token";
import { $Enums } from "@prisma/client";

type MemberRole = $Enums.MemberRole;

/**
 * Turn a verified shell identity into a local user, workspace and membership.
 *
 * Runs on every hand-off, not just the first, because all three can drift: a
 * person renamed in the shell, a workspace renamed, someone added to an
 * organisation after their first visit. It is written to be idempotent rather
 * than guarded by a "first time" flag, since the flag is what goes stale.
 *
 * The local row is keyed on **email**, not on the shell's user id. The shell is
 * the authority on identity and email is unique in both, so matching on it
 * links a shell hand-off to the account someone already made here with a
 * password — rather than silently creating a second one beside it.
 */
export async function provisionFromShell(claims: ShellClaims) {
  const user = await prisma.user.upsert({
    where: { email: claims.email },
    update: { name: claims.name },
    create: {
      email: claims.email,
      name: claims.name,
      // Arriving through the shell IS the verification: they could not have
      // reached this point without a live shell session.
      emailVerified: new Date(),
      referralSource: "erp.io shell",
    },
  });

  // No organisation on the token means the shell could not resolve one. It
  // still signs the person in — being unable to name a workspace is not a
  // reason to refuse a valid identity — and they land wherever a member with no
  // workspace lands.
  if (!claims.org) return user;

  const workspace = await prisma.workspace.upsert({
    where: { shellOrgId: claims.org },
    update: claims.orgName ? { name: claims.orgName } : {},
    create: {
      shellOrgId: claims.org,
      name: claims.orgName ?? "Workspace",
      slug: await uniqueSlug(claims.orgName ?? claims.org),
    },
  });

  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
    update: { role: roleFor(claims.role) },
    create: { workspaceId: workspace.id, userId: user.id, role: roleFor(claims.role) },
  });

  return user;
}

/**
 * The shell's role, narrowed to this app's.
 *
 * The shell normalises onto the same four-tier ladder this app uses, so most of
 * this is an identity mapping. The exception is the top of it, and it is the
 * important line here:
 *
 * **SUPER_ADMIN is never granted from a hand-off.** In the shell that means
 * "administrator of their own organisation" — which every new sign-up is, by
 * construction. In THIS app `isSuperAdmin` is a platform-operator flag: any
 * SUPER_ADMIN membership anywhere unlocks /superadmin and every workspace in
 * it. Passing the claim through would make each new customer an operator of the
 * whole product, so the top of the shell's ladder lands as WORKSPACE_ADMIN,
 * which is what "admin of their own workspace" actually means here.
 *
 * Anything unrecognised becomes the least it could mean: a role added to the
 * shell later must not arrive as more access than it was given.
 */
function roleFor(role: string | null): MemberRole {
  switch ((role ?? "").toUpperCase()) {
    case "SUPER_ADMIN":
    case "WORKSPACE_ADMIN":
      return "WORKSPACE_ADMIN" as MemberRole;
    case "OPERATOR":
      return "OPERATOR" as MemberRole;
    default:
      return "VIEWER" as MemberRole;
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base) || "workspace";
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`;
    const taken = await prisma.workspace.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!taken) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}

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
 * Anything unrecognised becomes the least it could mean. A new role name added
 * in the shell must not arrive here as more access than it was given.
 */
function roleFor(role: string | null): MemberRole {
  switch ((role ?? "").toUpperCase()) {
    case "PLATFORM_ADMIN":
    case "ENTITY_ADMIN":
      return "WORKSPACE_ADMIN" as MemberRole;
    case "TEAM_MEMBER":
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

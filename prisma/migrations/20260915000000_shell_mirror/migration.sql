-- Marketing/CRM workspace mirror (2026-09-14: every Marketing workspace has a CRM twin, both tied to
-- one shell organization; the shell keeps name, members and roles in step). See lib/shell-mirror.

-- The shell user an account IS. Linked on the next hand-off or mirror event (shell id, else a
-- verified email). Unique: one shell user, one account.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "shellUserId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "User_shellUserId_key" ON "User"("shellUserId");

CREATE TABLE IF NOT EXISTS "ShellMirrorVersion" (
    "key" TEXT NOT NULL,
    "version" BIGINT NOT NULL,
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShellMirrorVersion_pkey" PRIMARY KEY ("key")
);

CREATE TABLE IF NOT EXISTS "SignedRequestReceipt" (
    "jti" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SignedRequestReceipt_pkey" PRIMARY KEY ("jti")
);
CREATE INDEX IF NOT EXISTS "SignedRequestReceipt_expiresAt_idx" ON "SignedRequestReceipt"("expiresAt");

-- Where a membership came from. Every existing row predates the mirror: `legacy`, never removed by
-- it. New rows default to `app` (invited or created here, also never removed by the mirror); the
-- mirror and the shell hand-off write `mirror`, and only those rows can be removed by the mirror.
ALTER TABLE "WorkspaceMember" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "WorkspaceMember" ALTER COLUMN "source" SET DEFAULT 'app';

-- Memberships the SHELL created are `mirror`, so the shell can take them away again. A workspace with
-- a shellOrgId was created by a shell hand-off, and the hand-off is what adds its members — except an
-- accepted in-app Invitation (stays `legacy`, unless the account itself was created by the shell), and
-- any SUPER_ADMIN row (the platform flag; never removable). Workspaces with no shellOrgId (DEV.co's
-- `devco`) stay `legacy` entirely. The first reconcile only removes rows whose account is LINKED to a
-- shell user absent from that org's snapshot; its dry run lists every one (`removals`).
UPDATE "WorkspaceMember" m
SET "source" = 'mirror'
FROM "Workspace" w, "User" u
WHERE m."workspaceId" = w.id
  AND m."userId" = u.id
  AND m."source" = 'legacy'
  AND w."shellOrgId" IS NOT NULL
  AND m.role <> 'SUPER_ADMIN'
  AND (
    u."referralSource" = 'erp.io shell'
    OR NOT EXISTS (
      SELECT 1 FROM "Invitation" i
      WHERE i."workspaceId" = m."workspaceId" AND lower(i.email) = lower(u.email) AND i."acceptedAt" IS NOT NULL
    )
  );

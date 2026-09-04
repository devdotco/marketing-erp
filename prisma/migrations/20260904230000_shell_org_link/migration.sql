-- Which app.erp.io organisation a workspace mirrors.
--
-- Null is the ordinary case for anything that existed before the shell
-- hand-off: those workspaces were made here and have no counterpart. Unique so
-- one shell organisation can only ever map to one workspace — without that a
-- second hand-off would quietly create a duplicate and split a customer's work
-- across two of them.
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "shellOrgId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Workspace_shellOrgId_key"
  ON "Workspace"("shellOrgId");

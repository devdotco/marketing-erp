-- Bring-your-own-key, and per-workspace editorial profiles.
--
-- Two changes that together make this app multi-tenant in the ways that matter:
-- model spend lands on the workspace that asked for the work, and a workspace's
-- content sounds like the workspace rather than like whoever wrote the engine.

-- 1. ANTHROPIC becomes a connectable integration, so a workspace's API key is
--    stored exactly like every other credential: encrypted, one row per
--    provider, dropped with the workspace.
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'ANTHROPIC';

-- 2. The platform key stops being the silent default. New workspaces get false:
--    an agent run refuses with a legible message before spending a token rather
--    than quietly billing us.
ALTER TABLE "Workspace"
  ADD COLUMN IF NOT EXISTS "allowPlatformKey" BOOLEAN NOT NULL DEFAULT false;

--    Existing workspaces are grandfathered to true, deliberately. Every one of
--    them is ours, and shipping the column at false would stop every agent in
--    production the moment this deploys — a live regression, dressed up as a
--    policy. BYOK is enforced from here forward, and each of these is turned off
--    from the super-admin workspace page once it has a key of its own.
UPDATE "Workspace" SET "allowPlatformKey" = true;

-- 3. Editorial profiles. A workspace with no row uses the neutral default, so
--    this is additive and nothing needs backfilling.
CREATE TABLE IF NOT EXISTS "EditorialProfile" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "preset"      TEXT NOT NULL DEFAULT 'neutral-professional',
  "overrides"   JSONB NOT NULL DEFAULT '{}',
  "updatedBy"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EditorialProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EditorialProfile_workspaceId_key"
  ON "EditorialProfile"("workspaceId");

DO $$
BEGIN
  ALTER TABLE "EditorialProfile"
    ADD CONSTRAINT "EditorialProfile_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

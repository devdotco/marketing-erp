-- Add new IntegrationProvider values
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'INSTANTLY';
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'AIMFOX';
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'ZOOMINFO';
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'APOLLO';
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'GO_HIGH_LEVEL';

-- Create OutboundChannel enum
DO $$ BEGIN
    CREATE TYPE "OutboundChannel" AS ENUM ('EMAIL_AND_LINKEDIN', 'EMAIL_ONLY', 'WATCHLIST', 'DISCARDED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create OutboundStatus enum
DO $$ BEGIN
    CREATE TYPE "OutboundStatus" AS ENUM ('PENDING', 'IN_SEQUENCE', 'REPLIED', 'INTERESTED', 'NOT_INTERESTED', 'MEETING_BOOKED', 'CONVERTED', 'SUPPRESSED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create OutboundPlay table
CREATE TABLE IF NOT EXISTS "OutboundPlay" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slug"        TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "enabled"     BOOLEAN NOT NULL DEFAULT true,
    "config"      JSONB NOT NULL DEFAULT '{}',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundPlay_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OutboundPlay"
    DROP CONSTRAINT IF EXISTS "OutboundPlay_workspaceId_fkey";
ALTER TABLE "OutboundPlay"
    ADD CONSTRAINT "OutboundPlay_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "OutboundPlay_workspaceId_slug_key"
    ON "OutboundPlay"("workspaceId", "slug");

-- Create OutboundProspect table
CREATE TABLE IF NOT EXISTS "OutboundProspect" (
    "id"                TEXT NOT NULL,
    "workspaceId"       TEXT NOT NULL,
    "playId"            TEXT NOT NULL,
    "firstName"         TEXT NOT NULL,
    "lastName"          TEXT,
    "email"             TEXT NOT NULL,
    "linkedInUrl"       TEXT,
    "title"             TEXT,
    "company"           TEXT NOT NULL,
    "companyDomain"     TEXT,
    "score"             INTEGER NOT NULL DEFAULT 0,
    "channel"           "OutboundChannel" NOT NULL DEFAULT 'EMAIL_ONLY',
    "status"            "OutboundStatus" NOT NULL DEFAULT 'PENDING',
    "intelligence"      JSONB,
    "instantlyLeadId"   TEXT,
    "aimfoxLeadId"      TEXT,
    "ghlContactId"      TEXT,
    "ghlOpportunityId"  TEXT,
    "emailRepliedAt"    TIMESTAMP(3),
    "linkedInRepliedAt" TIMESTAMP(3),
    "interestedAt"      TIMESTAMP(3),
    "meetingBookedAt"   TIMESTAMP(3),
    "excludedAt"        TIMESTAMP(3),
    "excludeUntil"      TIMESTAMP(3),
    "exclusionReason"   TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundProspect_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OutboundProspect"
    DROP CONSTRAINT IF EXISTS "OutboundProspect_workspaceId_fkey";
ALTER TABLE "OutboundProspect"
    ADD CONSTRAINT "OutboundProspect_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OutboundProspect"
    DROP CONSTRAINT IF EXISTS "OutboundProspect_playId_fkey";
ALTER TABLE "OutboundProspect"
    ADD CONSTRAINT "OutboundProspect_playId_fkey"
    FOREIGN KEY ("playId") REFERENCES "OutboundPlay"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "OutboundProspect_workspaceId_email_key"
    ON "OutboundProspect"("workspaceId", "email");

-- Add outboundPlays and outboundProspects relations to Workspace (no DDL needed, handled by FK)

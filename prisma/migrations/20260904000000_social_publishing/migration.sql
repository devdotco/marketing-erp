-- SocialPlatform enum
DO $$ BEGIN
    CREATE TYPE "SocialPlatform" AS ENUM ('LINKEDIN', 'TWITTER_X');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- SocialAccountType enum
DO $$ BEGIN
    CREATE TYPE "SocialAccountType" AS ENUM ('PERSONAL', 'COMPANY');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- SocialPostStatus enum
DO $$ BEGIN
    CREATE TYPE "SocialPostStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- SocialAccount table
CREATE TABLE IF NOT EXISTS "SocialAccount" (
    "id"                TEXT NOT NULL,
    "workspaceId"       TEXT NOT NULL,
    "platform"          "SocialPlatform" NOT NULL,
    "accountType"       "SocialAccountType" NOT NULL DEFAULT 'PERSONAL',
    "platformAccountId" TEXT NOT NULL,
    "displayName"       TEXT NOT NULL,
    "username"          TEXT,
    "headline"          TEXT,
    "avatarUrl"         TEXT,
    "platformEmail"     TEXT,
    "organizationUrn"   TEXT,
    "companyName"       TEXT,
    "accessToken"       TEXT NOT NULL,
    "refreshToken"      TEXT,
    "expiresAt"         TIMESTAMP(3) NOT NULL,
    "scopes"            TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SocialAccount"
    DROP CONSTRAINT IF EXISTS "SocialAccount_workspaceId_fkey";
ALTER TABLE "SocialAccount"
    ADD CONSTRAINT "SocialAccount_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "SocialAccount_workspaceId_platform_platformAccountId_key"
    ON "SocialAccount"("workspaceId", "platform", "platformAccountId");

-- SocialPost table
CREATE TABLE IF NOT EXISTS "SocialPost" (
    "id"              TEXT NOT NULL,
    "workspaceId"     TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "content"         TEXT NOT NULL,
    "mediaUrls"       JSONB NOT NULL DEFAULT '[]',
    "status"          "SocialPostStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt"     TIMESTAMP(3),
    "publishedAt"     TIMESTAMP(3),
    "platformPostId"  TEXT,
    "errorMessage"    TEXT,
    "aiGenerated"     JSONB,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialPost_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SocialPost"
    DROP CONSTRAINT IF EXISTS "SocialPost_workspaceId_fkey";
ALTER TABLE "SocialPost"
    ADD CONSTRAINT "SocialPost_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SocialPost"
    DROP CONSTRAINT IF EXISTS "SocialPost_socialAccountId_fkey";
ALTER TABLE "SocialPost"
    ADD CONSTRAINT "SocialPost_socialAccountId_fkey"
    FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

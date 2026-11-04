-- Email Marketing campaign types (Press Release, Dashboard…) over a locked
-- template library, sent through SendGrid Single Sends. Additive only.

-- ALTER TYPE … ADD VALUE cannot share a transaction with statements that use the
-- new value; nothing below uses it.
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'SENDGRID';

CREATE TABLE "EmailTemplate" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmailCampaign" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "templateId" TEXT NOT NULL,
    "listIds" TEXT[],
    "segmentIds" TEXT[],
    "editableSections" TEXT[],
    "changeLevel" TEXT NOT NULL DEFAULT 'light',
    "sourceUrls" TEXT[],
    "brief" TEXT NOT NULL DEFAULT '',
    "monthlyPush" TEXT NOT NULL DEFAULT '',
    "sendWeekday" INTEGER NOT NULL DEFAULT 4,
    "sendNth" INTEGER NOT NULL DEFAULT 3,
    "sendTime" TEXT NOT NULL DEFAULT '09:00',
    "timezone" TEXT NOT NULL DEFAULT 'America/Denver',
    "draftWeekday" INTEGER NOT NULL DEFAULT 1,
    "draftTime" TEXT NOT NULL DEFAULT '16:00',
    "notifyEmails" TEXT[],
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmailCampaign_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailTemplate_workspaceId_idx" ON "EmailTemplate"("workspaceId");
CREATE INDEX "EmailCampaign_workspaceId_idx" ON "EmailCampaign"("workspaceId");
CREATE INDEX "EmailCampaign_enabled_idx" ON "EmailCampaign"("enabled");

ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailCampaign" ADD CONSTRAINT "EmailCampaign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailCampaign" ADD CONSTRAINT "EmailCampaign_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EmailTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

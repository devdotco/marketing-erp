-- Crawler and AI-referral analytics, fed by Cloudflare Logpush.
--
-- Additive: three tables, one IntegrationProvider value. Nothing existing is
-- touched.
--
-- Pre-aggregated by day rather than one row per request. A busy site pushes
-- millions of log lines and almost none are individually interesting; the
-- question is "which pages did which engine read, and how often". One row per
-- (day, bot, path) makes ingest an upsert-with-increment and keeps the table
-- small enough that retention never becomes a conversation.
--
-- LogBatchReceipt is the idempotency record. Cloudflare retries any batch it
-- did not get a 2xx for, and a retry after a partial write would double every
-- counter in it. The primary key is a hash of the batch body: it needs nothing
-- from Cloudflare and is stable across a retry of the identical payload, which
-- is precisely what a retry is.

-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'CLOUDFLARE_LOGPUSH';

-- CreateTable
CREATE TABLE "CrawlerDaily" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "bot" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "verifiedHits" INTEGER NOT NULL DEFAULT 0,
    "errorHits" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrawlerDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralDaily" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "visits" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LogBatchReceipt" (
    "hash" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "lines" INTEGER NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LogBatchReceipt_pkey" PRIMARY KEY ("hash")
);

-- CreateIndex
CREATE INDEX "CrawlerDaily_workspaceId_day_idx" ON "CrawlerDaily"("workspaceId", "day");

-- CreateIndex
CREATE INDEX "CrawlerDaily_workspaceId_bot_day_idx" ON "CrawlerDaily"("workspaceId", "bot", "day");

-- CreateIndex
CREATE UNIQUE INDEX "CrawlerDaily_workspaceId_day_bot_path_key" ON "CrawlerDaily"("workspaceId", "day", "bot", "path");

-- CreateIndex
CREATE INDEX "ReferralDaily_workspaceId_day_idx" ON "ReferralDaily"("workspaceId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralDaily_workspaceId_day_source_path_key" ON "ReferralDaily"("workspaceId", "day", "source", "path");

-- CreateIndex
CREATE INDEX "LogBatchReceipt_receivedAt_idx" ON "LogBatchReceipt"("receivedAt");

-- AddForeignKey
ALTER TABLE "CrawlerDaily" ADD CONSTRAINT "CrawlerDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralDaily" ADD CONSTRAINT "ReferralDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


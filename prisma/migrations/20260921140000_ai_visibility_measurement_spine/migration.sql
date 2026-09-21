-- The AI search visibility measurement spine.
--
-- Additive only: four new tables, two new enums, three new IntegrationProvider
-- values. Nothing existing is altered, so a workspace that never touches AI
-- visibility is unaffected and every current run keeps working.
--
-- Why these four tables and not one:
--
--   TrackedPrompt   the question we ask, and the unit everything is measured
--                   per. Unique per (workspace, text, locale) so re-adding a
--                   prompt continues its history instead of forking it.
--   AnswerCapture   what an engine actually said, kept in full. Every metric
--                   below is derived from this text, and derivations get
--                   corrected — brand-term matching especially — so keeping
--                   the answer means a fix applies to history, not only to
--                   captures taken after the fix shipped.
--   Citation        one row per link inside an answer, with workspaceId
--                   denormalised so "which domains influence answers about
--                   us" is a groupBy rather than a join on every read.
--   Observation     the generic time-series row everything derives into. One
--                   table rather than one per metric, so a new chart is a new
--                   `metric` value instead of another migration.
--
-- The uniqueness that makes retries safe is (promptId, engine, capturedOn),
-- where capturedOn is the UTC day written by the pipeline rather than derived
-- in SQL. A capture re-run on the same day updates its row; without it, a
-- worker retry after a partial failure would double-count the day and bend
-- the trend line it exists to draw.
--
-- ALTER TYPE ... ADD VALUE is safe in one transaction here only because none
-- of the three new IntegrationProvider values is USED by a statement in this
-- migration. Do not add a data write that references them to this file.

-- CreateEnum
CREATE TYPE "AnswerEngine" AS ENUM ('CLAUDE', 'GEMINI', 'PERPLEXITY', 'OPENAI');

-- CreateEnum
CREATE TYPE "TrackedPromptSource" AS ENUM ('MANUAL', 'SUGGESTED', 'SEARCH_CONSOLE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "IntegrationProvider" ADD VALUE 'OPENAI';
ALTER TYPE "IntegrationProvider" ADD VALUE 'GOOGLE_GEMINI';
ALTER TYPE "IntegrationProvider" ADD VALUE 'PERPLEXITY';

-- CreateTable
CREATE TABLE "TrackedPrompt" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "topic" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en-US',
    "source" "TrackedPromptSource" NOT NULL DEFAULT 'MANUAL',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackedPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnswerCapture" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "engine" "AnswerEngine" NOT NULL,
    "model" TEXT NOT NULL,
    "answerText" TEXT NOT NULL,
    "brandMentioned" BOOLEAN NOT NULL DEFAULT false,
    "brandRank" INTEGER,
    "sentiment" TEXT,
    "competitors" TEXT[],
    "costUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "runId" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedOn" TEXT NOT NULL,

    CONSTRAINT "AnswerCapture_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Citation" (
    "id" TEXT NOT NULL,
    "captureId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "isOwned" BOOLEAN NOT NULL DEFAULT false,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Citation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Competitor" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "aliases" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Competitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Observation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "dimensions" JSONB NOT NULL DEFAULT '{}',
    "dimensionKey" TEXT NOT NULL DEFAULT '',
    "value" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "observedOn" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Observation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrackedPrompt_workspaceId_active_idx" ON "TrackedPrompt"("workspaceId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedPrompt_workspaceId_text_locale_key" ON "TrackedPrompt"("workspaceId", "text", "locale");

-- CreateIndex
CREATE INDEX "AnswerCapture_workspaceId_capturedAt_idx" ON "AnswerCapture"("workspaceId", "capturedAt");

-- CreateIndex
CREATE INDEX "AnswerCapture_workspaceId_engine_capturedAt_idx" ON "AnswerCapture"("workspaceId", "engine", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AnswerCapture_promptId_engine_capturedOn_key" ON "AnswerCapture"("promptId", "engine", "capturedOn");

-- CreateIndex
CREATE INDEX "Citation_workspaceId_domain_capturedAt_idx" ON "Citation"("workspaceId", "domain", "capturedAt");

-- CreateIndex
CREATE INDEX "Citation_captureId_idx" ON "Citation"("captureId");

-- CreateIndex
CREATE UNIQUE INDEX "Competitor_workspaceId_name_key" ON "Competitor"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "Observation_workspaceId_metric_observedOn_idx" ON "Observation"("workspaceId", "metric", "observedOn");

-- CreateIndex
CREATE INDEX "Observation_workspaceId_subject_metric_observedOn_idx" ON "Observation"("workspaceId", "subject", "metric", "observedOn");

-- CreateIndex
CREATE UNIQUE INDEX "Observation_workspaceId_subject_metric_dimensionKey_observe_key" ON "Observation"("workspaceId", "subject", "metric", "dimensionKey", "observedOn");

-- AddForeignKey
ALTER TABLE "TrackedPrompt" ADD CONSTRAINT "TrackedPrompt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnswerCapture" ADD CONSTRAINT "AnswerCapture_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnswerCapture" ADD CONSTRAINT "AnswerCapture_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "TrackedPrompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Citation" ADD CONSTRAINT "Citation_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "AnswerCapture"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Competitor" ADD CONSTRAINT "Competitor_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


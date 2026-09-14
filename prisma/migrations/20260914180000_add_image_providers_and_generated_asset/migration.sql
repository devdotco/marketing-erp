-- Bring-your-own-key image generation for the Blog Writer's AI-generated
-- image blocks (lib/images/*). See prisma/schema.prisma's GeneratedAsset doc
-- comment for why bytes are stored directly rather than in an object store.
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'OPENAI_IMAGES';
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'GOOGLE_IMAGES';

CREATE TABLE IF NOT EXISTS "GeneratedAsset" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "runId"       TEXT,
    "mimeType"    TEXT NOT NULL,
    "bytes"       BYTEA NOT NULL,
    "alt"         TEXT NOT NULL,
    "prompt"      TEXT NOT NULL,
    "costUsd"     DECIMAL(10,6),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeneratedAsset_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "GeneratedAsset"
    DROP CONSTRAINT IF EXISTS "GeneratedAsset_workspaceId_fkey";
ALTER TABLE "GeneratedAsset"
    ADD CONSTRAINT "GeneratedAsset_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "GeneratedAsset_workspaceId_runId_idx"
    ON "GeneratedAsset"("workspaceId", "runId");

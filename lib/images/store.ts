import { prisma } from "@/lib/prisma";

/**
 * Where generated images live: the GeneratedAsset table (prisma/schema.prisma),
 * bytes stored directly as Postgres bytea. This app had no S3/R2/blob storage
 * anywhere (grepped for one before adding this) — standing up an object store
 * for a first version of AI images is more infrastructure than the feature
 * needs yet, and Postgres already holds every other piece of run output. A
 * dedicated blob store is the natural next step if image volume grows enough
 * for row size or backup time to matter; nothing here would need to change at
 * the call site, only this file's two functions.
 *
 * Served back out through app/api/assets/[id]/route.ts, which is
 * workspace-scoped and requires a session — never a public URL. That is fine
 * for the in-app preview but NOT good enough for a customer's own CMS to
 * fetch from at publish time (WordPress/Payload need the raw bytes to upload
 * as their own media, and can't authenticate as one of our sessions) — the
 * publish path in lib/agent-handlers/blog-writer.ts reads bytes from this
 * table directly, server-side, rather than round-tripping through that route.
 */

export interface StoredAssetInput {
  workspaceId: string;
  runId: string | null;
  mimeType: string;
  bytes: Buffer;
  alt: string;
  prompt: string;
  costUsd?: number;
}

export async function saveGeneratedAsset(input: StoredAssetInput): Promise<{ id: string }> {
  const asset = await prisma.generatedAsset.create({
    data: {
      workspaceId: input.workspaceId,
      runId: input.runId,
      mimeType: input.mimeType,
      bytes: input.bytes,
      alt: input.alt,
      prompt: input.prompt,
      costUsd: input.costUsd ?? null,
    },
    select: { id: true },
  });
  return asset;
}

/** Workspace-scoped read — callers must always filter by workspaceId, never trust an id alone. */
export async function getGeneratedAsset(
  workspaceId: string,
  id: string,
): Promise<{ id: string; mimeType: string; bytes: Buffer } | null> {
  const asset = await prisma.generatedAsset.findFirst({
    where: { id, workspaceId },
    select: { id: true, mimeType: true, bytes: true },
  });
  return asset;
}

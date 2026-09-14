import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { openAiImageProvider } from "./openai";
import { googleImageProvider } from "./google";
import type { ImageProvider, ImageProviderKind } from "./provider";

export type ImageProviderStatus =
  | { connected: true; provider: ImageProvider }
  | { connected: false; reason: "not_connected" };

/**
 * Which image provider (if any) this workspace has connected, bring-your-own-
 * key like every other model integration in this app (see lib/ai/client.ts).
 * OpenAI is preferred when both are connected — implemented first here, and
 * gpt-image-1's request/response shape is the one this integration is most
 * confident about (see lib/images/openai.ts's doc comment). Never falls back
 * to a platform-wide key: there is no such thing for image generation.
 */
export async function resolveImageProvider(workspaceId: string): Promise<ImageProviderStatus> {
  const integrations = await prisma.integration.findMany({
    where: { workspaceId, provider: { in: ["OPENAI_IMAGES", "GOOGLE_IMAGES"] } },
  });

  const byProvider = new Map(integrations.map((i) => [i.provider as ImageProviderKind, i]));

  const openai = byProvider.get("OPENAI_IMAGES");
  if (openai) {
    const creds = await decryptCredentials<{ apiKey?: string }>(openai.encryptedCredentials);
    if (creds.apiKey?.trim()) return { connected: true, provider: openAiImageProvider(creds.apiKey.trim()) };
  }

  const google = byProvider.get("GOOGLE_IMAGES");
  if (google) {
    const creds = await decryptCredentials<{ apiKey?: string }>(google.encryptedCredentials);
    if (creds.apiKey?.trim()) return { connected: true, provider: googleImageProvider(creds.apiKey.trim()) };
  }

  return { connected: false, reason: "not_connected" };
}

/**
 * Image generation, provider-abstracted, bring-your-own-key — same shape as
 * lib/ai/client.ts's resolveAnthropic: a workspace's own key, never ours, and
 * a clear refusal (not a silent skip) when nothing is connected.
 *
 * Two providers ship here. Both are new as of 2026-09-14 and their exact
 * current model id has NOT been confirmed against a live call (the local
 * Anthropic key covers Messages API only, and no image-provider key is
 * available in this environment) — see the report this work shipped with for
 * what to verify before a production deploy. Model ids are centralised below
 * so pinning a newer one is a one-line change either way.
 */
import type { GeneratedAsset } from "@prisma/client";

export type ImageProviderKind = "OPENAI_IMAGES" | "GOOGLE_IMAGES";

export interface GenerateImageArgs {
  prompt: string;
  /** "1024x1024" | "1536x1024" (landscape) | "1024x1536" (portrait). Provider maps this to its own accepted sizes. */
  size: "1024x1024" | "1536x1024" | "1024x1536";
}

export interface GeneratedImageBytes {
  bytes: Buffer;
  mimeType: string;
  /** USD, when the provider's response includes usage/cost data. Undefined when it doesn't. */
  costUsd?: number;
}

export interface ImageProvider {
  kind: ImageProviderKind;
  modelId: string;
  generateImage(args: GenerateImageArgs): Promise<GeneratedImageBytes>;
}

/** Re-exported so callers that only need the stored-asset shape don't import @prisma/client directly. */
export type { GeneratedAsset };

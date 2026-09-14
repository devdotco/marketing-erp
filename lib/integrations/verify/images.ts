import type { KeyVerifier } from "./types";
import { verifyOpenAiImagesKey } from "@/lib/images/openai";
import { verifyGoogleImagesKey } from "@/lib/images/google";

/**
 * Cheap, read-only, no-generation calls that prove a stored image-provider
 * key actually works — same rationale as every other verifier in this
 * folder. Neither call generates an image, so connecting costs nothing.
 */
const openAiImages: KeyVerifier = async (credentials) => verifyOpenAiImagesKey(credentials.apiKey);
const googleImages: KeyVerifier = async (credentials) => verifyGoogleImagesKey(credentials.apiKey);

export const VERIFIERS: Partial<Record<string, KeyVerifier>> = {
  OPENAI_IMAGES: openAiImages,
  GOOGLE_IMAGES: googleImages,
};

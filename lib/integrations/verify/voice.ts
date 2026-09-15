import type { KeyVerifier } from "./types";
import { verifyGoogleTtsKey } from "@/lib/voice/google-tts";

/**
 * Voice providers other than Cartesia (whose verifier predates this file and
 * lives in seo-content.ts). One free, read-only models.get call — no audio is
 * generated, so connecting costs nothing. See verifyGoogleTtsKey.
 */
const googleTts: KeyVerifier = async (credentials) => verifyGoogleTtsKey(credentials.apiKey);

export const VERIFIERS: Partial<Record<string, KeyVerifier>> = {
  GOOGLE_TTS: googleTts,
};

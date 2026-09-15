/**
 * Which text-to-speech provider a Podcast run voices its script with.
 *
 * Cartesia and Google (Gemini TTS) are alternatives: a workspace needs one of
 * them, not both. Pure, so the choice is unit-tested without a database.
 */

export const VOICE_PROVIDER_OPTIONS = ["Auto (use whichever is connected)", "Cartesia", "Google (Gemini TTS)"] as const;
export const VOICE_PROVIDER_DEFAULT = VOICE_PROVIDER_OPTIONS[0];

export type VoiceProviderChoice = "auto" | "cartesia" | "google";
export type VoiceProvider = "cartesia" | "google";

export const VOICE_PROVIDER_NAMES: Record<VoiceProvider, string> = {
  cartesia: "Cartesia",
  google: "Google Text-to-Speech (Gemini)",
};

/** Form label (or a bare "google"/"cartesia" from an API caller) → choice. Unknown means auto. */
export function voiceProviderChoice(raw: string | undefined): VoiceProviderChoice {
  const value = (raw ?? "").trim().toLowerCase();
  if (value.startsWith("cartesia")) return "cartesia";
  if (value.startsWith("google") || value.startsWith("gemini")) return "google";
  return "auto";
}

export type VoiceProviderSelection =
  | { provider: VoiceProvider; note?: undefined }
  | { provider: null; note: string };

/**
 * Auto prefers Cartesia when both are connected, so a workspace that was
 * already producing Cartesia audio keeps sounding the same after Google is
 * added. An explicit choice is honoured even when only the other provider is
 * connected — silently switching voices mid-show would be worse than a note.
 */
export function selectVoiceProvider(
  choice: VoiceProviderChoice,
  connected: { cartesia: boolean; google: boolean },
): VoiceProviderSelection {
  if (choice === "cartesia" || choice === "google") {
    if (connected[choice]) return { provider: choice };
    const other: VoiceProvider = choice === "cartesia" ? "google" : "cartesia";
    return {
      provider: null,
      note: connected[other]
        ? `Voice Provider is set to ${VOICE_PROVIDER_NAMES[choice]}, which isn't connected — connect it in Settings → Integrations, or set Voice Provider to ${VOICE_PROVIDER_NAMES[other]} or Auto to use the one you have.`
        : `Voice Provider is set to ${VOICE_PROVIDER_NAMES[choice]}, which isn't connected — connect it in Settings → Integrations to generate audio for this script.`,
    };
  }
  if (connected.cartesia) return { provider: "cartesia" };
  if (connected.google) return { provider: "google" };
  return {
    provider: null,
    note: "Connect Cartesia or Google Text-to-Speech (Gemini) in Settings → Integrations to generate audio for this script.",
  };
}

/**
 * The text to voice. The writer's JSON carries `fullScript`; when that is
 * missing (a long script can run the JSON out of tokens) fall back to the
 * segment scripts rather than voicing nothing — never to the raw reply, which
 * would read JSON aloud.
 */
export function scriptForSpeech(output: Record<string, unknown>): string {
  const full = typeof output.fullScript === "string" ? output.fullScript.trim() : "";
  if (full) return full;
  const segments = Array.isArray(output.segments) ? output.segments : [];
  return segments
    .map((s) => (s && typeof s === "object" && typeof (s as { script?: unknown }).script === "string" ? (s as { script: string }).script.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
}

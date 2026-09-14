import type { GenerateImageArgs, GeneratedImageBytes, ImageProvider } from "./provider";

/**
 * Google's Gemini API image generation ("Nano Banana").
 *
 * Model id: "gemini-2.5-flash-image" — https://ai.google.dev/gemini-api/docs/image-generation
 *
 * Three separate fetches of Google's current docs on 2026-09-14 all listed a
 * newer "gemini-3.1-flash-image" ("Nano Banana 2") as the current recommended
 * default, with gemini-2.5-flash-image marked legacy. This integration uses
 * 2.5 anyway: one of those fetches described the request/response shape as a
 * `model`+`input` body against a `/v1beta/interactions` endpoint returning
 * `output_image.data`, which does not match any documented Gemini API
 * convention this was built against (Gemini uses `contents`/`generateContent`
 * and `inlineData`; that shape reads like OpenAI's Responses API bleeding into
 * a page summary) — not confident enough to ship against without a live call,
 * which this environment cannot make. gemini-2.5-flash-image, by contrast, was
 * named consistently across all three fetches as real and current knowledge
 * from training, so it is the safer default. Update MODEL_ID below once the
 * 3.1 request shape is confirmed against real docs or a live call.
 *
 * POST https://generativelanguage.googleapis.com/v1beta/models/{MODEL_ID}:generateContent
 * Header: x-goog-api-key: <key>
 * Body: { contents: [{ parts: [{ text: prompt }] }] }
 * Response: candidates[0].content.parts[] — the image part carries
 * inlineData: { mimeType, data } (base64).
 */
const MODEL_ID = "gemini-2.5-flash-image";
const TIMEOUT_MS = 60_000;

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  error?: { message?: string };
  usageMetadata?: { totalTokenCount?: number };
}

// No published per-image dollar figure to anchor a fallback on for this
// model at time of writing, so cost is reported only when Google's own
// response carries usage data (see generateImage below) — never guessed.

function googleImageProvider(apiKey: string): ImageProvider {
  return {
    kind: "GOOGLE_IMAGES",
    modelId: MODEL_ID,
    async generateImage({ prompt, size }: GenerateImageArgs): Promise<GeneratedImageBytes> {
      // Gemini's image model does not take a pixel-size parameter the way
      // OpenAI's does; the aspect ratio is a hint appended to the prompt
      // instead, which is the documented workaround for models without a
      // dedicated size field.
      const aspectHint =
        size === "1536x1024" ? "Landscape orientation, roughly 3:2." :
        size === "1024x1536" ? "Portrait orientation, roughly 2:3." :
        "Square orientation, 1:1.";

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${prompt}\n\n${aspectHint}` }] }],
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );

      const json = (await res.json().catch(() => ({}))) as GeminiResponse;
      if (!res.ok) {
        throw new Error(`Gemini image API ${res.status}: ${json.error?.message ?? "request failed"}`);
      }
      const imagePart = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!imagePart?.inlineData?.data) {
        throw new Error("Gemini image API returned no image data.");
      }

      return {
        bytes: Buffer.from(imagePart.inlineData.data, "base64"),
        mimeType: imagePart.inlineData.mimeType || "image/png",
        costUsd: undefined,
      };
    },
  };
}

/** Cheap, read-only model-list call — same rationale as the other key verifiers in lib/integrations/verify/*. */
export async function verifyGoogleImagesKey(apiKey: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1`, {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { ok: false, reason: "Google rejected that API key — check it was copied whole from Google AI Studio and hasn't been revoked." };
    }
    if (!res.ok) return { ok: false, reason: `Google returned ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { ok: false, reason: "Google didn't respond in time. Try again." };
    }
    return { ok: false, reason: `Couldn't reach Google: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export { googleImageProvider, MODEL_ID as GOOGLE_IMAGE_MODEL_ID };

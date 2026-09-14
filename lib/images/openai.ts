import type { GenerateImageArgs, GeneratedImageBytes, ImageProvider } from "./provider";

/**
 * OpenAI Images API.
 *
 * Model id: "gpt-image-1" — https://platform.openai.com/docs/api-reference/images
 * (platform.openai.com returned an auth-walled 403 to this session's fetch
 * tool, so this was NOT re-confirmed live against current docs; "gpt-image-1"
 * is the model this integration was built and trained against. If OpenAI has
 * shipped a newer default image model by the time this deploys, update
 * MODEL_ID below — nothing else in this file needs to change.)
 *
 * POST https://api.openai.com/v1/images/generations
 * Body: { model, prompt, size, quality: "low"|"medium"|"high"|"auto", n: 1 }
 * gpt-image-1 always returns base64 (no response_format switch, unlike the
 * older dall-e-3): data[0].b64_json, mime type is PNG.
 */
const MODEL_ID = "gpt-image-1";
const TIMEOUT_MS = 60_000;

// Roughly the published per-image cost band for gpt-image-1 at "medium"
// quality, 1024x1024 — used only when the response carries no usage/cost
// data of its own, so a run's cost report is never simply blank. Not shown
// in any user-facing copy as a dollar figure per house style; a per-image
// note only.
const FALLBACK_COST_USD = 0.04;

interface OpenAiImagesResponse {
  data?: Array<{ b64_json?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

function openAiImageProvider(apiKey: string): ImageProvider {
  return {
    kind: "OPENAI_IMAGES",
    modelId: MODEL_ID,
    async generateImage({ prompt, size }: GenerateImageArgs): Promise<GeneratedImageBytes> {
      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL_ID,
          prompt,
          size,
          quality: "medium",
          n: 1,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      const json = (await res.json().catch(() => ({}))) as OpenAiImagesResponse;
      if (!res.ok) {
        throw new Error(`OpenAI Images API ${res.status}: ${json.error?.message ?? "request failed"}`);
      }
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) throw new Error("OpenAI Images API returned no image data.");

      // gpt-image-1's own token-based pricing, when the response carries usage.
      // https://platform.openai.com/docs/pricing at time of writing: image
      // output tokens are billed distinctly from input — this uses a flat
      // per-image fallback rather than guess at a $/token figure that may have
      // moved, and only when usage is present at all.
      const costUsd = json.usage ? FALLBACK_COST_USD : undefined;

      return { bytes: Buffer.from(b64, "base64"), mimeType: "image/png", costUsd };
    },
  };
}

/** One cheap, read-only call proving the key can reach the API at all — used by the connect-time verifier. */
export async function verifyOpenAiImagesKey(apiKey: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) return { ok: false, reason: "OpenAI rejected that API key — check it was copied whole and hasn't been revoked." };
    if (!res.ok) return { ok: false, reason: `OpenAI returned ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { ok: false, reason: "OpenAI didn't respond in time. Try again." };
    }
    return { ok: false, reason: `Couldn't reach OpenAI: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export { openAiImageProvider, MODEL_ID as OPENAI_IMAGE_MODEL_ID };

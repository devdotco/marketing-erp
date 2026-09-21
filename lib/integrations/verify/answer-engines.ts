import type { KeyVerifier } from "./types";
import { ENGINE_MODELS } from "@/lib/answer-engines/models";

/**
 * Key checks for the answer engines AI visibility captures from.
 *
 * Same rule as every verifier here: one cheap, read-only call, and a sentence
 * a customer can act on. It matters more for these than for most — an engine
 * key that fails at capture time leaves a gap in a trend line, and a gap looks
 * like a drop in visibility rather than like a broken key.
 */

const TIMEOUT_MS = 10_000;

function unreachable(name: string, err: unknown): { ok: false; reason: string } {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return { ok: false, reason: `${name} didn't respond in time. Try again.` };
  }
  return { ok: false, reason: `Couldn't reach ${name}: ${err instanceof Error ? err.message : String(err)}` };
}

const openAi: KeyVerifier = async (credentials) => {
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${credentials.apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) {
      return { ok: false, reason: "OpenAI rejected that API key — check it was copied whole and hasn't been revoked." };
    }
    if (!res.ok) return { ok: false, reason: `OpenAI returned ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (err) {
    return unreachable("OpenAI", err);
  }
};

const gemini: KeyVerifier = async (credentials) => {
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": credentials.apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return {
        ok: false,
        reason: "Google rejected that API key. Make sure it's a Gemini API key from aistudio.google.com and that the Generative Language API is enabled on its project.",
      };
    }
    if (!res.ok) return { ok: false, reason: `Google returned ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (err) {
    return unreachable("Google", err);
  }
};

/**
 * Perplexity has no free listing endpoint, so this is a one-token completion —
 * a fraction of a cent, and the only thing that actually proves the key can
 * reach the API it will be used against. Same reasoning as the Anthropic
 * verifier in lib/ai/client.ts: a key can pass a metadata call and still be
 * barred from inference.
 */
const perplexity: KeyVerifier = async (credentials) => {
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: ENGINE_MODELS.PERPLEXITY, messages: [{ role: "user", content: "." }], max_tokens: 1 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) {
      return { ok: false, reason: "Perplexity rejected that API key — check it was copied whole and hasn't been revoked." };
    }
    if (res.status === 402) {
      return { ok: false, reason: "That key is valid but the Perplexity account has no credit. Add credit before captures will run." };
    }
    // The account is busy, not broken. Storing the key is correct.
    if (res.status === 429) return { ok: true };
    if (!res.ok) return { ok: false, reason: `Perplexity returned ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (err) {
    return unreachable("Perplexity", err);
  }
};

export const VERIFIERS: Partial<Record<string, KeyVerifier>> = {
  OPENAI: openAi,
  GOOGLE_GEMINI: gemini,
  PERPLEXITY: perplexity,
};

import Anthropic from "@anthropic-ai/sdk";

/**
 * Single source of truth for every Claude model this app calls.
 *
 * Never hardcode a model id in a handler. Model ids here are the plain,
 * undated aliases — a date-suffixed snapshot (e.g. "claude-sonnet-5-20251015")
 * is not a valid model and fails with a 404 not_found_error at the first API
 * call, before any work happens. That is exactly the failure the Blog Writer
 * QA run hit on 2026-09-08.
 */
export const MODELS = {
  /** Long-form writing, ads, strategy — anything a human reads verbatim. */
  standard: "claude-sonnet-5",
  /** Classification, extraction, summarisation, high-volume monitoring. */
  fast: "claude-haiku-4-5",
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

/** USD per 1M tokens. Keep in step with anthropic.com/pricing. */
const PRICING: Record<ModelId, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

type UsageLike = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

/** Cost of one Messages API call, in USD. */
export function estimateCostUsd(model: ModelId, usage: UsageLike): number {
  const price = PRICING[model];
  if (!price) return 0;
  return (
    usage.input_tokens * price.input +
    usage.output_tokens * price.output +
    (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite +
    (usage.cache_read_input_tokens ?? 0) * price.cacheRead
  ) / 1_000_000;
}

export type ModelHealth = {
  ok: boolean;
  checkedAt: string;
  models: { id: string; ok: boolean; error?: string }[];
};

let cached: { at: number; result: ModelHealth } | null = null;
const TTL_MS = 10 * 60 * 1000;

/**
 * Ask the Models API whether every model we reference actually exists.
 *
 * This is the pre-flight the workbench was missing: "Enable agent" and
 * "Run now" both behaved as though everything was wired while the model
 * reference was stale. Result is cached for 10 minutes so page renders and
 * health polls do not each cost a round trip.
 */
export async function checkModelsAvailable(force = false): Promise<ModelHealth> {
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.result;

  const ids = [...new Set(Object.values(MODELS))];

  // With bring-your-own-key, a platform key is optional: most workspaces run on
  // their own. Absent one there is simply nothing to health-check here, and
  // reporting that as an outage would have the worker crying wolf at every boot.
  // A workspace's own key is verified when it is connected instead.
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    const result: ModelHealth = {
      ok: true,
      checkedAt: new Date().toISOString(),
      models: ids.map((id) => ({ id, ok: true, error: "Not checked: no platform key. Workspaces run on their own." })),
    };
    cached = { at: Date.now(), result };
    return result;
  }

  let client: Anthropic;
  try {
    client = new Anthropic();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result: ModelHealth = {
      ok: false,
      checkedAt: new Date().toISOString(),
      models: ids.map((id) => ({ id, ok: false, error: message })),
    };
    cached = { at: Date.now(), result };
    return result;
  }

  const models = await Promise.all(
    ids.map(async (id) => {
      try {
        await client.models.retrieve(id);
        return { id, ok: true };
      } catch (err) {
        return {
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );

  const result: ModelHealth = {
    ok: models.every((m) => m.ok),
    checkedAt: new Date().toISOString(),
    models,
  };
  cached = { at: Date.now(), result };
  return result;
}

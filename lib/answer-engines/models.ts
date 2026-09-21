import type { AnswerEngine } from "@prisma/client";
import { MODELS } from "@/lib/ai/models";

/**
 * The ONLY place an answer-engine model id may appear.
 *
 * This exists because the identical mistake has already cost this app a
 * fleet. 27 handlers each hardcoded `claude-sonnet-5-20251015` — a snapshot
 * that does not exist — and every run 404'd at the first call for $0.00,
 * looking like a bug in the agent rather than a bad string. lib/ai/models.ts
 * and `npm run check:models` exist to stop that recurring for Anthropic.
 *
 * Three new providers arrived with their ids inlined in their clients and no
 * gate at all, which is the same hole in a new wall. They live here now, and
 * scripts/check-models.mjs fails the build on any engine id written anywhere
 * else, exactly as it does for `claude-*`.
 *
 * A stale id here does not fail loudly on its own: it fails per capture, on a
 * schedule, at night, and shows up as a flat line on a chart. Verify against
 * each provider before changing one.
 */
export const ENGINE_MODELS: Record<AnswerEngine, string> = {
  /// Claude is the one engine already covered: its id comes from the existing
  /// registry in lib/ai/models.ts, which check:models verifies against the
  /// live Models API. Repeating the literal here would create exactly the
  /// drift this file exists to prevent.
  CLAUDE: MODELS.standard,
  OPENAI: "gpt-5",
  GEMINI: "gemini-2.5-flash",
  PERPLEXITY: "sonar",
};

/** Where to check when one of these stops working. */
export const ENGINE_MODEL_DOCS: Record<AnswerEngine, string> = {
  CLAUDE: "https://docs.anthropic.com/en/docs/about-claude/models",
  OPENAI: "https://platform.openai.com/docs/models",
  GEMINI: "https://ai.google.dev/gemini-api/docs/models",
  PERPLEXITY: "https://docs.perplexity.ai/getting-started/models",
};

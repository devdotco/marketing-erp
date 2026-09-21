import type { AnswerEngine } from "@prisma/client";

/**
 * What a capture costs, before anyone schedules one.
 *
 * Captures multiply: prompts × engines × days. Fifty prompts on four engines
 * is two hundred grounded answers every day, on the workspace's own keys,
 * started by a scheduler nobody watches. Shipping that with no number attached
 * would mean the first time a customer learns the rate is their provider
 * invoice — which is exactly the kind of surprise BYOK is supposed to prevent,
 * since the whole point of BYOK is that they see and control the spend.
 *
 * These are estimates and are labelled as such wherever they are shown. They
 * are per-answer averages at the default 2048-token ceiling with live search
 * on, taken from each provider's published rates. Real spend is recorded per
 * run from actual usage; this is only for deciding whether to press the button.
 */
const PER_CAPTURE_USD: Record<AnswerEngine, number> = {
  // Sonnet 5 at $2/$10 per M. Web-search results are billed as output tokens
  // and share the same ceiling, so this sits near the top of the budget.
  CLAUDE: 0.022,
  // GPT at $1.25/$10 per M, plus the hosted web_search call.
  OPENAI: 0.019,
  // Flash is the cheapest of the four by an order of magnitude.
  GEMINI: 0.003,
  // Sonar's token rate is low; the per-request search fee dominates.
  PERPLEXITY: 0.01,
};

/** One Haiku classification per answer that names the brand. */
const SENTIMENT_USD = 0.0007;

export interface CaptureEstimate {
  prompts: number;
  engines: number;
  capturesPerDay: number;
  perDayUsd: number;
  perMonthUsd: number;
}

export function estimateCapture(prompts: number, engines: AnswerEngine[]): CaptureEstimate {
  const perDayUsd = engines.reduce(
    (sum, engine) => sum + prompts * (PER_CAPTURE_USD[engine] + SENTIMENT_USD),
    0,
  );
  return {
    prompts,
    engines: engines.length,
    capturesPerDay: prompts * engines.length,
    perDayUsd: Math.round(perDayUsd * 100) / 100,
    perMonthUsd: Math.round(perDayUsd * 30 * 100) / 100,
  };
}

/**
 * The most prompts one capture will ask.
 *
 * A ceiling rather than a budget: it exists so that a workspace which pastes
 * six hundred prompts in gets a capped, legible run and a warning, instead of
 * a job that quietly spends forty times what the last one did. Prompts beyond
 * the cap stay tracked and are simply not asked — the run reports how many it
 * skipped, so the cause is visible in the run rather than inferred from a bill.
 */
export const MAX_PROMPTS_PER_CAPTURE = 100;

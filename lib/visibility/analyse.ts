import type Anthropic from "@anthropic-ai/sdk";
import { MODELS, estimateCostUsd } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { firstIndexOfTerm, type BrandIdentity } from "./brand";

export interface AnswerAnalysis {
  brandMentioned: boolean;
  /** 1 = first brand named in the answer. Null when we are not named. */
  brandRank: number | null;
  /** Tracked competitors named in this answer, by competitor name. */
  competitors: string[];
  sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE" | null;
  /** Cost of the sentiment classification, if one was made. */
  costUsd: number;
}

/**
 * Read one answer for what it says about us.
 *
 * Rank is the ordering of first mentions, not a score. "Which brand does the
 * answer name first" is the question a marketer actually asks, and it is
 * answerable from the text without a model — which matters, because a
 * model-derived rank would put a guess back into the one number this feature
 * exists to measure.
 */
export function analyseMentions(text: string, brand: BrandIdentity): Omit<AnswerAnalysis, "sentiment" | "costUsd"> {
  const positions: Array<{ name: string; at: number; isBrand: boolean }> = [];

  const brandAt = earliest(text, brand.terms);
  if (brandAt >= 0) positions.push({ name: brand.name, at: brandAt, isBrand: true });

  const competitors: string[] = [];
  for (const competitor of brand.competitors) {
    const at = earliest(text, competitor.terms);
    if (at >= 0) {
      positions.push({ name: competitor.name, at, isBrand: false });
      competitors.push(competitor.name);
    }
  }

  positions.sort((a, b) => a.at - b.at);
  const rank = positions.findIndex((p) => p.isBrand);

  return {
    brandMentioned: brandAt >= 0,
    brandRank: rank >= 0 ? rank + 1 : null,
    competitors,
  };
}

function earliest(text: string, terms: string[]): number {
  let best = -1;
  for (const term of terms) {
    const at = firstIndexOfTerm(text, term);
    if (at >= 0 && (best === -1 || at < best)) best = at;
  }
  return best;
}

const SENTIMENT_SYSTEM = [
  "You classify how an AI assistant's answer portrays one specific brand.",
  "Judge only the portrayal of the named brand, not the overall tone of the answer and not the other brands in it.",
  "POSITIVE: recommended, praised, or presented as a leading option.",
  "NEUTRAL: named factually, listed among others, or described without evaluation.",
  "NEGATIVE: criticised, warned against, described as limited, or corrected.",
  "Reply with exactly one word: POSITIVE, NEUTRAL, or NEGATIVE.",
].join("\n");

/**
 * How the answer portrays us.
 *
 * Only called when we are actually mentioned — sentiment about a brand an
 * answer never names is not a neutral reading, it is a meaningless one, and
 * charting it would put a flat line where the real story is absence.
 *
 * A classification that comes back as anything other than the three words
 * returns null rather than defaulting to NEUTRAL. A wrong neutral is
 * indistinguishable from a real one on a chart; a null is visibly missing.
 */
export async function classifySentiment(
  client: Anthropic,
  brandName: string,
  answerText: string,
): Promise<{ sentiment: AnswerAnalysis["sentiment"]; costUsd: number }> {
  const message = await client.messages.create({
    model: MODELS.fast,
    max_tokens: 8,
    system: SENTIMENT_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Brand: ${brandName}\n\nAnswer:\n${answerText.slice(0, 8000)}`,
      },
    ],
  });

  const word = textFrom(message).trim().toUpperCase();
  const sentiment =
    word === "POSITIVE" || word === "NEUTRAL" || word === "NEGATIVE" ? word : null;

  return { sentiment, costUsd: estimateCostUsd(MODELS.fast, message.usage) };
}

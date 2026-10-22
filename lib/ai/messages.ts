import type Anthropic from "@anthropic-ai/sdk";
import { estimateCostUsd, type ModelId } from "./models";

/**
 * Make one Messages API call and wait for the whole answer.
 *
 * Always streams. The SDK refuses a non-streaming request outright once
 * `max_tokens` implies the call could run past ten minutes — "Streaming is
 * required for operations that may take longer than 10 minutes" — and a
 * long-form article with a real token budget crosses that line every time. The
 * refusal happens client-side before any request is sent, so it is not something
 * a retry or a larger timeout fixes.
 *
 * Streaming and collecting is otherwise identical to `messages.create`: the
 * final message carries the same content blocks, stop_reason and usage.
 *
 * The client is passed in rather than constructed here, because which key a call
 * runs on is a property of the workspace. See `resolveAnthropic`.
 */
export async function createMessage(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  options?: { timeout?: number; signal?: AbortSignal },
): Promise<Anthropic.Message> {
  return client.messages.stream(params, options).finalMessage();
}

/**
 * The smallest output budget an agent call gets.
 *
 * Handlers were written with `max_tokens: 4096` or `8096`, back when that meant
 * "room for the answer". Sonnet 5 decides per request whether to think first,
 * and thinking is billed against the same budget, so a long JSON calendar,
 * a four-format repurpose or a six-story newsletter ran out partway through
 * and stopped mid-string. QA audit 2026-10-21: three of seven runs cut off
 * like that, every one saved as an approvable success.
 *
 * A cap is not a spend — only tokens actually generated are billed — so a high
 * floor costs nothing on a short answer. `completeMessage` streams, so a high
 * budget no longer trips the SDK's ten-minute non-streaming refusal either.
 */
export const MIN_OUTPUT_TOKENS = 32000;

/**
 * The model ran out of output budget before it finished. Partial output is
 * never offered for approval; the run fails and says so.
 */
export class OutputTruncatedError extends Error {
  readonly partialText: string;
  /** Tokens were generated and billed to the workspace's key even though the answer is unusable. */
  readonly costUsd: number;

  constructor(partialText: string, costUsd = 0) {
    super("The model's answer hit its output limit and was cut off before it finished.");
    this.name = "OutputTruncatedError";
    this.partialText = partialText;
    this.costUsd = costUsd;
  }
}

/** Today, as the model should understand it. Exported for tests. */
export function dateContext(now = new Date()): string {
  const iso = now.toISOString().slice(0, 10);
  const year = now.getUTCFullYear();
  return [
    `Today's date is ${iso}. The current year is ${year}.`,
    `Anything time-bound you write — titles, "in ${year}" framing, report names, deadlines — uses ${year} or later, never an earlier year, unless the content is specifically about that earlier period.`,
  ].join(" ");
}

function withDate(system: Anthropic.MessageCreateParamsNonStreaming["system"], now?: Date) {
  const preamble = dateContext(now);
  if (!system) return preamble;
  if (typeof system === "string") return `${preamble}\n\n${system}`;
  return [{ type: "text" as const, text: preamble }, ...system];
}

/**
 * The call every agent handler makes. `createMessage`, plus three guarantees:
 *
 *  1. The model is told today's date. Without it, titles came back as
 *     "SEO Benchmark Report 2025" on a run made in October 2026.
 *  2. The output budget is at least MIN_OUTPUT_TOKENS.
 *  3. A response that stopped at the token limit throws OutputTruncatedError
 *     rather than being parsed, half-filled, and shown as a draft.
 */
export async function completeMessage(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  options?: { timeout?: number; signal?: AbortSignal },
): Promise<Anthropic.Message> {
  const message = await createMessage(
    client,
    {
      ...params,
      max_tokens: Math.max(params.max_tokens, MIN_OUTPUT_TOKENS),
      system: withDate(params.system),
    },
    options,
  );
  if (message.stop_reason === "max_tokens") {
    const partial = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    throw new OutputTruncatedError(partial, estimateCostUsd(params.model as ModelId, message.usage));
  }
  return message;
}

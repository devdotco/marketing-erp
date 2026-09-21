import type Anthropic from "@anthropic-ai/sdk";

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

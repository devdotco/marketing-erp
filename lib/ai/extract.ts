import type Anthropic from "@anthropic-ai/sdk";

/**
 * Read the assistant's answer out of a Messages API response.
 *
 * Every handler used to do this instead:
 *
 *   const rawText = message.content[0].type === "text" ? message.content[0].text : "";
 *
 * That is only correct when the very first content block is text, and it often
 * is not. Sonnet 5 decides per request whether to think first, so a long-form
 * prompt comes back as ["thinking", "text"] — block 0 is the thinking block,
 * `rawText` becomes "", and the caller happily stores an empty result. That is
 * exactly the Blog Writer run of 2026-09-11 (QA audit, Run 2): 48s, $0.047 of
 * real tokens spent, 3081 of them thinking, and an Output panel reading
 * {"content": "", …} that a human was then asked to approve.
 *
 * Always go through this. It concatenates every text block and ignores thinking,
 * redacted thinking, tool calls and server-tool results.
 */
export function textFrom(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** The input of the first `tool_use` block with this name, if the model called it. */
export function toolInputFrom<T = Record<string, unknown>>(
  message: Anthropic.Message,
  toolName: string,
): T | undefined {
  const block = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === toolName,
  );
  return block ? (block.input as T) : undefined;
}

/**
 * Pull a JSON object out of a text answer.
 *
 * Prefer a `tool_use` block and `toolInputFrom` — a tool call is schema-checked
 * by the API and cannot arrive as prose. This exists for the handlers that ask
 * for JSON in the prompt. It strips markdown fences, then falls back to the
 * outermost brace pair, and returns undefined rather than a half-parsed object.
 */
export function jsonFrom<T = Record<string, unknown>>(text: string): T | undefined {
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  const candidates = [unfenced];
  const firstBrace = unfenced.indexOf("{");
  const lastBrace = unfenced.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(unfenced.slice(firstBrace, lastBrace + 1));
  }
  const firstBracket = unfenced.indexOf("[");
  const lastBracket = unfenced.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    candidates.push(unfenced.slice(firstBracket, lastBracket + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try the next shape
    }
  }
  return undefined;
}

/**
 * Throw when the model was cut off mid-answer.
 *
 * A truncated response looks like a malformed one: the trailing fields of a tool
 * call are simply absent, and the error downstream blames whatever field went
 * missing rather than the token limit that actually caused it.
 */
export function assertNotTruncated(message: Anthropic.Message, what = "The model's answer"): void {
  if (message.stop_reason === "max_tokens") {
    throw new Error(
      `${what} hit the max_tokens limit and was cut off before it finished. Raise max_tokens for this step or ask for a shorter result.`,
    );
  }
}

/**
 * True when the model refused rather than answered. A refusal is a normal
 * `end_turn` with prose in it, so it otherwise reads as a successful run.
 */
export function isRefusal(message: Anthropic.Message): boolean {
  return message.stop_reason === "refusal";
}

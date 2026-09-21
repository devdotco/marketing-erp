import { arr, dedupeCitations, rec, str } from "./parse";
import { EngineShapeError, type AnswerEngineClient, type AskOptions, type EngineAnswer } from "./types";

const ENDPOINT = "https://api.openai.com/v1/responses";
const MODEL = "gpt-5";

/**
 * ChatGPT's model, answering with the hosted web_search tool.
 *
 * This is the closest reachable proxy for "what ChatGPT tells a customer", and
 * it is a proxy, not the thing itself: the consumer app applies its own
 * system prompt, memory and ranking on top of the same model. Captures from
 * here are labelled OPENAI rather than "ChatGPT" for that reason, and the
 * dashboard says so. Measuring the app itself needs browser automation, which
 * is a separate decision with a separate cost.
 */
export function openAiEngine(apiKey: string): AnswerEngineClient {
  return {
    engine: "OPENAI",
    name: "OpenAI (GPT)",
    async ask(prompt: string, opts: AskOptions = {}): Promise<EngineAnswer> {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          input: prompt,
          tools: [{ type: "web_search" }],
          max_output_tokens: opts.maxTokens ?? 2048,
        }),
        signal: opts.signal,
      });

      if (!res.ok) {
        throw new Error(`OpenAI API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }

      const body = rec(await res.json());
      if (!body) throw new EngineShapeError("OPENAI", "response was not an object");

      const { text, citations } = readOutput(body);
      if (!text) {
        throw new EngineShapeError("OPENAI", "no assistant text in the output array", body);
      }

      return {
        engine: "OPENAI",
        model: str(body.model) || MODEL,
        text,
        citations: dedupeCitations(citations),
        costUsd: openAiCost(rec(body.usage)),
      };
    },
  };
}

/**
 * Walk the Responses output array.
 *
 * `output` holds tool calls and messages interleaved; only `message` items
 * carry the answer, and the sources are `url_citation` annotations hanging off
 * each output_text part. `output_text` — the flattened convenience field — is
 * an SDK nicety and is not reliably present on the raw JSON, so it is a
 * fallback here rather than the primary read.
 */
function readOutput(body: Record<string, unknown>): {
  text: string;
  citations: Array<{ url: string; title?: string }>;
} {
  const parts: string[] = [];
  const citations: Array<{ url: string; title?: string }> = [];

  for (const item of arr(body.output)) {
    const node = rec(item);
    if (!node || str(node.type) !== "message") continue;
    for (const c of arr(node.content)) {
      const part = rec(c);
      if (!part) continue;
      const text = str(part.text);
      if (text) parts.push(text);
      for (const a of arr(part.annotations)) {
        const ann = rec(a);
        if (!ann) continue;
        if (str(ann.type) !== "url_citation") continue;
        const url = str(ann.url);
        if (url) citations.push({ url, title: str(ann.title) || undefined });
      }
    }
  }

  const text = parts.join("\n\n").trim() || str(body.output_text).trim();
  return { text, citations };
}

const PER_M_INPUT = 1.25;
const PER_M_OUTPUT = 10;

function openAiCost(usage: Record<string, unknown> | null): number {
  const input = Number(usage?.input_tokens ?? 0);
  const output = Number(usage?.output_tokens ?? 0);
  return (input / 1_000_000) * PER_M_INPUT + (output / 1_000_000) * PER_M_OUTPUT;
}

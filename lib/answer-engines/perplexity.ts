import { arr, dedupeCitations, rec, str } from "./parse";
import { EngineShapeError, type AnswerEngineClient, type AskOptions, type EngineAnswer } from "./types";

const ENDPOINT = "https://api.perplexity.ai/chat/completions";
const MODEL = "sonar";

/**
 * Perplexity, which is a search product first and therefore the engine whose
 * citations are most complete.
 *
 * Its response shape has moved more than the others': citations arrived as a
 * top-level `citations: string[]`, then as `search_results: [{url, title}]`,
 * and both are still served depending on the model. Both are read here, in
 * that order of preference, because guessing wrong loses every source for the
 * capture while the answer text still looks fine — a silent failure of exactly
 * the kind this whole feature exists to stop.
 */
export function perplexityEngine(apiKey: string): AnswerEngineClient {
  return {
    engine: "PERPLEXITY",
    name: "Perplexity",
    async ask(prompt: string, opts: AskOptions = {}): Promise<EngineAnswer> {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: prompt }],
          max_tokens: opts.maxTokens ?? 2048,
        }),
        signal: opts.signal,
      });

      if (!res.ok) {
        throw new Error(`Perplexity API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }

      const body = rec(await res.json());
      if (!body) throw new EngineShapeError("PERPLEXITY", "response was not an object");

      const choice = rec(arr(body.choices)[0]);
      const text = str(rec(choice?.message)?.content);
      if (!text) {
        throw new EngineShapeError("PERPLEXITY", "no answer text in choices[0].message.content", body);
      }

      const raw: Array<{ url: string; title?: string }> = [];
      for (const entry of arr(body.search_results)) {
        const r = rec(entry);
        if (r && str(r.url)) raw.push({ url: str(r.url), title: str(r.title) || undefined });
      }
      if (raw.length === 0) {
        for (const entry of arr(body.citations)) {
          if (typeof entry === "string") raw.push({ url: entry });
          else {
            const r = rec(entry);
            if (r && str(r.url)) raw.push({ url: str(r.url), title: str(r.title) || undefined });
          }
        }
      }

      return {
        engine: "PERPLEXITY",
        model: str(body.model) || MODEL,
        text,
        citations: dedupeCitations(raw),
        costUsd: perplexityCost(rec(body.usage)),
      };
    },
  };
}

/**
 * Perplexity bills tokens plus a per-request search fee that is not in the
 * usage block. The token maths is exact; the request fee is a published flat
 * rate for the sonar tier, added so a workspace's cost line is not visibly
 * short. It is a small, declared approximation rather than a silent omission.
 */
const PER_M_INPUT = 1;
const PER_M_OUTPUT = 1;
const PER_REQUEST = 0.005;

function perplexityCost(usage: Record<string, unknown> | null): number {
  const input = Number(usage?.prompt_tokens ?? 0);
  const output = Number(usage?.completion_tokens ?? 0);
  return (input / 1_000_000) * PER_M_INPUT + (output / 1_000_000) * PER_M_OUTPUT + PER_REQUEST;
}

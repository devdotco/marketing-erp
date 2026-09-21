import { arr, dedupeCitations, hostOf, rec, str } from "./parse";
import { EngineShapeError, type AnswerEngineClient, type AskOptions, type EngineAnswer } from "./types";

const MODEL = "gemini-2.5-flash";
const ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

/**
 * Gemini, grounded with Google Search — the engine behind AI Overviews and the
 * Gemini app.
 *
 * One trap worth knowing: grounded Gemini does not hand back the source URL.
 * It hands back a Vertex redirect (vertexaisearch.cloud.google.com/
 * grounding-api-redirect/...) whose destination is only visible by following
 * it. The real publisher is in `web.title`, which for grounding chunks is the
 * bare domain. So the domain is taken from the title and the redirect is kept
 * as the URL — resolving thousands of redirects per capture would cost more
 * requests than the capture itself, and the domain is what every view groups
 * by.
 */
export function geminiEngine(apiKey: string): AnswerEngineClient {
  return {
    engine: "GEMINI",
    name: "Gemini",
    async ask(prompt: string, opts: AskOptions = {}): Promise<EngineAnswer> {
      const res = await fetch(ENDPOINT(MODEL), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: { maxOutputTokens: opts.maxTokens ?? 2048 },
        }),
        signal: opts.signal,
      });

      if (!res.ok) {
        throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }

      const body = rec(await res.json());
      if (!body) throw new EngineShapeError("GEMINI", "response was not an object");

      const candidate = rec(arr(body.candidates)[0]);
      if (!candidate) {
        throw new EngineShapeError("GEMINI", "no candidates — the prompt may have been blocked", body);
      }

      const text = arr(rec(candidate.content)?.parts)
        .map((p) => str(rec(p)?.text))
        .filter(Boolean)
        .join("\n\n")
        .trim();
      if (!text) throw new EngineShapeError("GEMINI", "candidate had no text parts", candidate);

      const raw: Array<{ url: string; title?: string }> = [];
      for (const chunk of arr(rec(candidate.groundingMetadata)?.groundingChunks)) {
        const web = rec(rec(chunk)?.web);
        if (!web) continue;
        const uri = str(web.uri);
        const title = str(web.title);
        if (uri) raw.push({ url: uri, title: title || undefined });
      }

      return {
        engine: "GEMINI",
        model: str(rec(body.modelVersion)) || str(body.modelVersion) || MODEL,
        text,
        citations: dedupeCitations(raw),
        costUsd: geminiCost(rec(body.usageMetadata)),
      };
    },
  };
}

/**
 * The publisher domain for a Gemini citation.
 *
 * Exported because the capture pipeline has to prefer the title over the URL
 * for this one engine, and that rule should live with the reason for it rather
 * than as an unexplained special case in the pipeline.
 */
export function geminiDomain(citation: { url: string; title?: string }): string | null {
  const title = citation.title?.trim().toLowerCase();
  if (title && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(title)) return title.replace(/^www\./, "");
  return hostOf(citation.url);
}

const PER_M_INPUT = 0.3;
const PER_M_OUTPUT = 2.5;

function geminiCost(usage: Record<string, unknown> | null): number {
  const input = Number(usage?.promptTokenCount ?? 0);
  const output = Number(usage?.candidatesTokenCount ?? 0);
  return (input / 1_000_000) * PER_M_INPUT + (output / 1_000_000) * PER_M_OUTPUT;
}

import { arr, dedupeCitations, hostOf, rec, str } from "./parse";
import { ENGINE_MODELS } from "./models";
import { askSignal, EngineShapeError, type AnswerEngineClient, type AskOptions, type EngineAnswer } from "./types";

const MODEL = ENGINE_MODELS.GEMINI;
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
        signal: askSignal(opts),
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

/** Hosts Google serves grounding redirects from. Never a publisher. */
const REDIRECT_HOSTS = ["vertexaisearch.cloud.google.com", "grounding-api-redirect.googleapis.com"];

/**
 * The publisher domain for a Gemini citation, or null when it cannot be known.
 *
 * Exported because the capture pipeline has to prefer the title over the URL
 * for this one engine, and that rule should live with the reason for it rather
 * than as an unexplained special case in the pipeline.
 *
 * The null case is the important one, and it was a live bug. Gemini's
 * groundingChunks usually label a source with its bare domain, but not always
 * — sometimes the label is the page headline. The first version fell back to
 * the URL host whenever the label was not domain-shaped, and for Gemini that
 * host is Google's own redirector. The result was
 * `vertexaisearch.cloud.google.com` recorded as a cited publisher, climbing
 * to the top of "What the answers cite" — a wrong figure wearing the
 * authority of a measured one, which is the exact defect this whole feature
 * exists to prevent.
 *
 * So: a redirect URL with no domain-shaped label yields null, and the caller
 * drops the citation. Losing one source is a smaller error than inventing one,
 * and the answer itself is still captured and still counted.
 */
export function geminiDomain(citation: { url: string; title?: string }): string | null {
  const title = citation.title?.trim().toLowerCase();
  if (title && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(title)) return title.replace(/^www\./, "");

  const host = hostOf(citation.url);
  if (host && REDIRECT_HOSTS.some((r) => host === r || host.endsWith(`.${r}`))) return null;
  return host;
}

const PER_M_INPUT = 0.3;
const PER_M_OUTPUT = 2.5;

function geminiCost(usage: Record<string, unknown> | null): number {
  const input = Number(usage?.promptTokenCount ?? 0);
  const output = Number(usage?.candidatesTokenCount ?? 0);
  return (input / 1_000_000) * PER_M_INPUT + (output / 1_000_000) * PER_M_OUTPUT;
}

import type Anthropic from "@anthropic-ai/sdk";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { createMessage } from "@/lib/ai/messages";
import { dedupeCitations } from "./parse";
import { ENGINE_TIMEOUT_MS, type AnswerEngineClient, type AskOptions, type EngineAnswer } from "./types";

/** The model id that answered, recorded per capture. See EngineAnswer.model. */
const MODEL = MODELS.standard;

/**
 * Claude, answering with live web search — the same tool the Blog Writer's
 * research stage uses (lib/content/research.ts), with no domain filters.
 *
 * Filters are deliberately absent here. Research wants authoritative sources;
 * a capture wants whatever Claude would actually have told a customer, and
 * steering it would measure our filter rather than the engine.
 */
export function claudeEngine(client: Anthropic): AnswerEngineClient {
  return {
    engine: "CLAUDE",
    name: "Claude",
    async ask(prompt: string, opts: AskOptions = {}): Promise<EngineAnswer> {
      // The same deadline the fetch-based engines get. createMessage streams,
      // so this bounds the whole stream rather than time-to-first-byte.
      const message = await createMessage(
        client,
        {
          model: MODEL,
          max_tokens: opts.maxTokens ?? 2048,
          messages: [{ role: "user", content: prompt }],
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
        },
        { timeout: ENGINE_TIMEOUT_MS, signal: opts.signal },
      );

      return {
        engine: "CLAUDE",
        model: MODEL,
        text: textFrom(message),
        citations: dedupeCitations(collectCitations(message)),
        // Web-search result blocks are billed as OUTPUT tokens and are already
        // inside message.usage, so this covers the searches as well as the
        // answer. The per-search surcharge is not visible to us here.
        costUsd: estimateCostUsd(MODEL, message.usage),
      };
    },
  };
}

/**
 * Citations live in two places and we want both: the `citations` array hung on
 * each text block (what the answer actually leaned on, in reading order) and
 * the `web_search_tool_result` blocks (everything the search returned). Reading
 * only the tool results would credit pages Claude looked at and then ignored.
 */
function collectCitations(message: Anthropic.Message): Array<{ url: string; title?: string }> {
  const out: Array<{ url: string; title?: string }> = [];

  for (const block of message.content) {
    if (block.type === "text") {
      const cites = (block as { citations?: unknown }).citations;
      if (Array.isArray(cites)) {
        for (const c of cites) {
          const url = (c as { url?: unknown })?.url;
          const title = (c as { title?: unknown })?.title;
          if (typeof url === "string") {
            out.push({ url, title: typeof title === "string" ? title : undefined });
          }
        }
      }
    }
  }

  // Anything the search surfaced that the prose did not cite explicitly, kept
  // after the in-text citations so ordering still reflects the answer.
  for (const block of message.content) {
    if ((block as { type?: string }).type !== "web_search_tool_result") continue;
    const content = (block as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      const url = (item as { url?: unknown })?.url;
      const title = (item as { title?: unknown })?.title;
      if (typeof url === "string") {
        out.push({ url, title: typeof title === "string" ? title : undefined });
      }
    }
  }

  return out;
}

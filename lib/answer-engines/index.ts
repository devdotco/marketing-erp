import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { resolveAnthropic } from "@/lib/ai/client";
import type { AnswerEngine, IntegrationProvider } from "@prisma/client";
import { claudeEngine } from "./claude";
import { openAiEngine } from "./openai";
import { geminiEngine } from "./gemini";
import { perplexityEngine } from "./perplexity";
import type { AnswerEngineClient } from "./types";

export * from "./types";
export { hostOf } from "./parse";
export { geminiDomain } from "./gemini";

/** Which stored integration carries each engine's key. */
const PROVIDER_FOR: Record<AnswerEngine, IntegrationProvider> = {
  CLAUDE: "ANTHROPIC",
  OPENAI: "OPENAI",
  GEMINI: "GOOGLE_GEMINI",
  PERPLEXITY: "PERPLEXITY",
};

export const ENGINE_NAMES: Record<AnswerEngine, string> = {
  CLAUDE: "Claude",
  OPENAI: "OpenAI (GPT)",
  GEMINI: "Gemini",
  PERPLEXITY: "Perplexity",
};

export const ALL_ENGINES: AnswerEngine[] = ["OPENAI", "GEMINI", "PERPLEXITY", "CLAUDE"];

/**
 * The engines this workspace can actually be measured on.
 *
 * Captures are bring-your-own-key like every other model call here, and for a
 * sharper reason than billing: an answer engine's output is the measurement,
 * so it has to come from a real, paid account rather than from a shared key
 * whose rate limits and history belong to someone else.
 *
 * A workspace with no engine keys gets an empty list and the caller refuses
 * legibly. It does NOT get a model's guess at what the engines might say —
 * that is the failure this whole feature exists to correct.
 */
export async function availableEngines(workspaceId: string): Promise<AnswerEngineClient[]> {
  const integrations = await prisma.integration.findMany({
    where: {
      workspaceId,
      provider: { in: Object.values(PROVIDER_FOR) },
    },
  });
  const byProvider = new Map(integrations.map((i) => [i.provider, i]));
  const clients: AnswerEngineClient[] = [];

  for (const engine of ALL_ENGINES) {
    const integration = byProvider.get(PROVIDER_FOR[engine]);

    if (engine === "CLAUDE") {
      // Anthropic resolves through the normal path so a workspace we operate
      // on the platform key (both gates, see lib/ai/client.ts) is measured too,
      // rather than being the one engine it cannot see.
      try {
        const { client } = await resolveAnthropic(workspaceId);
        clients.push(claudeEngine(client));
      } catch {
        // No key: not an error, just an engine we cannot measure.
      }
      continue;
    }

    if (!integration) continue;
    const creds = await decryptCredentials<{ apiKey?: string }>(integration.encryptedCredentials);
    const apiKey = creds.apiKey?.trim();
    if (!apiKey) continue;

    if (engine === "OPENAI") clients.push(openAiEngine(apiKey));
    if (engine === "GEMINI") clients.push(geminiEngine(apiKey));
    if (engine === "PERPLEXITY") clients.push(perplexityEngine(apiKey));
  }

  return clients;
}

/** Which engines are connected, for a page that needs to ask before running. */
export async function connectedEngines(workspaceId: string): Promise<AnswerEngine[]> {
  return (await availableEngines(workspaceId)).map((c) => c.engine);
}

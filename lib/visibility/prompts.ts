import type { TrackedPromptSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveAnthropic } from "@/lib/ai/client";
import { MODELS, estimateCostUsd } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { googleCredentials } from "@/lib/integrations/google";
import { resolvePropertyOverride } from "@/lib/integrations/google-resources";
import { resolveBrand } from "./brand";

export interface PromptSuggestion {
  text: string;
  topic: string;
  /** Why this prompt: the Search Console query behind it, when there was one. */
  basis?: string;
  source: TrackedPromptSource;
}

/**
 * Propose the questions worth tracking.
 *
 * Profound's equivalent reads a panel of 1.5B real AI conversations. We do not
 * have one and are not going to build one, so this uses the demand signal we
 * DO hold first-party: the workspace's own Search Console queries. A question
 * somebody typed into Google 400 times last quarter is a better guess at what
 * they ask an assistant than anything a model invents unprompted.
 *
 * Search Console is a proxy and is labelled as one — SEARCH_CONSOLE on the
 * prompt, so the prompt list shows which of its entries came from real demand
 * and which the model proposed. Without Search Console connected this degrades
 * to model suggestions, which is a weaker list and says so.
 */
export async function suggestPrompts(
  workspaceId: string,
  opts: { count?: number } = {},
): Promise<{ suggestions: PromptSuggestion[]; costUsd: number; groundedInSearchConsole: boolean }> {
  const count = Math.min(Math.max(opts.count ?? 20, 5), 50);
  const brand = await resolveBrand(workspaceId);
  if (!brand) {
    return { suggestions: [], costUsd: 0, groundedInSearchConsole: false };
  }

  const profile = await prisma.businessProfile.findUnique({ where: { workspaceId } });
  const queries = await topNonBrandedQueries(workspaceId, brand.terms);

  const { client } = await resolveAnthropic(workspaceId);

  const context = [
    `Business: ${brand.name}`,
    profile?.industry ? `Industry: ${profile.industry}` : "",
    profile?.targetAudience ? `Audience: ${profile.targetAudience}` : "",
    profile?.uniqueValueProp ? `What they do: ${profile.uniqueValueProp}` : "",
    brand.competitors.length > 0 ? `Competitors: ${brand.competitors.map((c) => c.name).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const demand =
    queries.length > 0
      ? `These are real Google searches this site already receives impressions for, highest first. Base as many prompts as you can on them — they are evidence of what this audience actually wants to know:\n${queries
          .map((q) => `- "${q.query}" (${q.impressions} impressions)`)
          .join("\n")}`
      : "There is no Search Console data for this workspace, so propose prompts from the business context alone and mark every one as SUGGESTED.";

  const message = await client.messages.create({
    model: MODELS.standard,
    max_tokens: 3000,
    system: [
      "You propose the questions a prospective customer would type into an AI assistant when they are looking for a product like this one.",
      "Write prompts the way a person talks to an assistant: a full question, not a keyword string.",
      "Do NOT include the brand's own name in a prompt. A prompt containing the brand name measures nothing — the answer names it because the question did.",
      "Cover the range of intent: category discovery, comparisons, alternatives, pricing, how-to, and problem-first questions.",
      "Return ONLY a JSON array. No markdown fences, no preamble.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: [
          context,
          "",
          demand,
          "",
          `Propose exactly ${count} prompts. Each entry:`,
          JSON.stringify([
            {
              text: "What's the best CRM for a small manufacturing business?",
              topic: "category discovery",
              basis: "the Search Console query this came from, or null",
              source: "SEARCH_CONSOLE or SUGGESTED",
            },
          ]),
        ].join("\n"),
      },
    ],
  });

  const raw = textFrom(message);
  const match = raw.match(/\[[\s\S]*\]/);
  let parsed: unknown = [];
  try {
    parsed = match ? JSON.parse(match[0]) : [];
  } catch {
    parsed = [];
  }

  const brandTerms = brand.terms;
  const suggestions: PromptSuggestion[] = (Array.isArray(parsed) ? parsed : [])
    .map((entry): PromptSuggestion | null => {
      const e = entry as Record<string, unknown>;
      const text = typeof e.text === "string" ? e.text.trim() : "";
      if (!text) return null;
      // Enforce the no-brand-name rule in code. The instruction is in the
      // prompt too, and a model that ignores it would otherwise hand back a
      // prompt guaranteed to score 100% visibility and mean nothing.
      const lowered = text.toLowerCase();
      if (brandTerms.some((t) => lowered.includes(t))) return null;
      return {
        text,
        topic: typeof e.topic === "string" && e.topic.trim() ? e.topic.trim() : "general",
        basis: typeof e.basis === "string" && e.basis.trim() ? e.basis.trim() : undefined,
        source: (e.source === "SEARCH_CONSOLE" && queries.length > 0
          ? "SEARCH_CONSOLE"
          : "SUGGESTED") as TrackedPromptSource,
      };
    })
    .filter((s): s is PromptSuggestion => s !== null);

  return {
    suggestions,
    costUsd: estimateCostUsd(MODELS.standard, message.usage),
    groundedInSearchConsole: queries.length > 0,
  };
}

/** Store prompts, keeping any that already exist rather than duplicating them. */
export async function addPrompts(
  workspaceId: string,
  entries: Array<{ text: string; topic?: string; source?: TrackedPromptSource }>,
  locale = "en-US",
): Promise<number> {
  let added = 0;
  for (const entry of entries) {
    const text = entry.text.trim();
    if (!text) continue;
    await prisma.trackedPrompt.upsert({
      where: { workspaceId_text_locale: { workspaceId, text, locale } },
      create: {
        workspaceId,
        text,
        locale,
        topic: entry.topic ?? null,
        source: entry.source ?? "MANUAL",
        active: true,
      },
      // Re-adding a prompt someone had deactivated turns it back on and keeps
      // its history, which is what "add this again" means to a person.
      update: { active: true, ...(entry.topic ? { topic: entry.topic } : {}) },
    });
    added += 1;
  }
  return added;
}

/**
 * The site's own highest-impression non-branded queries.
 *
 * Non-branded specifically: a branded query tells us people already know the
 * name, which is the opposite of what visibility measurement is for.
 */
async function topNonBrandedQueries(
  workspaceId: string,
  brandTerms: string[],
): Promise<Array<{ query: string; impressions: number }>> {
  const integration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId, provider: "GOOGLE_SEARCH_CONSOLE" } },
  });
  if (!integration) return [];

  try {
    const creds = await googleCredentials(integration);
    const property = await resolvePropertyOverride("GOOGLE_SEARCH_CONSOLE", creds, "");
    if (!property) return [];

    const end = new Date();
    end.setUTCDate(end.getUTCDate() - 1);
    const start = new Date(end);
    start.setUTCDate(end.getUTCDate() - 89);

    const res = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: start.toISOString().slice(0, 10),
          endDate: end.toISOString().slice(0, 10),
          dimensions: ["query"],
          rowLimit: 1000,
        }),
      },
    );
    if (!res.ok) return [];

    const data = (await res.json()) as { rows?: Array<{ keys: string[]; impressions: number }> };
    return (data.rows ?? [])
      .filter((r) => {
        const q = r.keys[0]?.toLowerCase() ?? "";
        return q && !brandTerms.some((t) => q.includes(t));
      })
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 60)
      .map((r) => ({ query: r.keys[0], impressions: r.impressions }));
  } catch {
    // Search Console being unreachable degrades the suggestions; it does not
    // fail the request. The caller reports groundedInSearchConsole: false.
    return [];
  }
}

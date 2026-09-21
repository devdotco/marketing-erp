import type { AgentHandler } from "./index";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { assertNotTruncated, jsonFrom, textFrom } from "@/lib/ai/extract";
import { bool, num, resolveInputs, str } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { AgentInputError } from "@/lib/ai/errors";
import { googleCredentials } from "@/lib/integrations/google";
import { resolvePropertyOverride } from "@/lib/integrations/google-resources";
import { bareDomain, fetchAhrefsOrganicKeywords, fetchSearchAtlasKeywordGap, fetchSemrushPhraseThis, resolveSeoLiveData } from "./seo-data-providers";

type GscQueryRow = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };

/**
 * The site's own queries from Search Console, last 90 days. Free, real, and
 * the best source of "already almost ranking" keywords — so a workspace with
 * GSC but no Ahrefs/Semrush still gets research anchored in actual demand.
 * Returns null when GSC isn't connected or has no property chosen.
 */
async function fetchGscQueries(workspaceId: string): Promise<{ property: string; rows: GscQueryRow[] } | null> {
  const integration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId, provider: "GOOGLE_SEARCH_CONSOLE" } },
  });
  if (!integration) return null;
  const creds = await googleCredentials(integration);
  const property = await resolvePropertyOverride("GOOGLE_SEARCH_CONSOLE", creds, "");
  if (!property) return null;

  const end = new Date();
  end.setDate(end.getDate() - 2); // GSC data lags ~2 days
  const start = new Date(end);
  start.setDate(end.getDate() - 89);
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
  if (!res.ok) throw new Error(`Search Console API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { rows?: GscQueryRow[] };
  return { property, rows: data.rows ?? [] };
}

export const keywordResearchHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  const seedKeywords = (config.seedKeywords as string) ?? "";
  const targetCountry = (config.targetCountry as string) ?? "US";
  const clusterMethod = (config.clusterMethod as string) ?? "Intent";
  const briefDepth = (config.briefDepth as string) ?? "Full";
  const maxKeywords = num(config, "maxKeywords", 100, { min: 10, max: 300 });
  const minVolume = num(config, "minVolume", 100, { min: 0 });
  const maxDifficulty = num(config, "maxDifficulty", 70, { min: 0, max: 100 });
  const intentFilter = str(config, "intentFilter", "all").toLowerCase();
  const includeQuestions = bool(config, "includeQuestions", true);

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });
  // The form field overrides; left blank, the Business Profile's industry is the better default.
  const industry = str(config, "industry") || businessProfile?.industry || "general";

  // --- Live API: Ahrefs → Semrush → SearchAtlas. Throws (not caught here) if
  // a connected provider fails — see resolveSeoLiveData for why that's not a
  // silent fallback to simulation anymore.
  let liveDataSection = "";
  const domain =
    businessProfile?.websiteUrl ? bareDomain(businessProfile.websiteUrl) : bareDomain(seedKeywords.split(/[\s,]+/)[0] ?? "");
  const firstKeyword = seedKeywords.split(/[\n,]+/)[0]?.trim() ?? "";
  const database = targetCountry.toLowerCase() === "us" ? "us" : targetCountry.toLowerCase();
  const competitorDomains = String(config.competitorDomains ?? "")
    .split(/[\n,]+/)
    .map(bareDomain)
    .filter(Boolean)
    .slice(0, 4);

  const liveResult = await resolveSeoLiveData(
    run.agentConfig.workspaceId,
    (data, provider) =>
      provider === "AHREFS"
        ? `\n\nLIVE AHREFS DATA for "${domain}":\n${JSON.stringify(data, null, 2)}\n\nUse this real keyword data (volume, difficulty, CPC) where available. Supplement with your own expertise for keywords not yet covered.`
        : provider === "SEMRUSH"
          ? `\n\nLIVE SEMRUSH DATA for "${firstKeyword}" (columns: Ph=keyword phrase, Nq=monthly searches, Cp=CPC, Co=competition):\n${data}\n\nUse this real data to anchor keyword metrics (volume, CPC, competition). Extend from these seeds to build the full cluster set.`
          : `\n\nLIVE SEARCHATLAS CONTENT GAP DATA — keywords ${competitorDomains.join(", ")} rank for that "${domain}" does not:\n${JSON.stringify(data, null, 2)}\n\nFold these directly into the keyword clusters as content-gap opportunities — they are real gaps, not estimates.`,
    {
      ahrefs: domain ? (apiKey) => fetchAhrefsOrganicKeywords(apiKey, domain) : undefined,
      semrush: firstKeyword ? (apiKey) => fetchSemrushPhraseThis(apiKey, firstKeyword, database) : undefined,
      searchAtlas: domain && competitorDomains.length > 0
        ? (apiKey) => fetchSearchAtlasKeywordGap(apiKey, domain, competitorDomains, database)
        : undefined,
    },
  );
  let source: string = liveResult.source;
  if (liveResult.source === "live") liveDataSection = liveResult.section;

  // Search Console is additive: it never replaces a paid provider, and a GSC
  // failure is reported in the output rather than failing research that can
  // still be done without it.
  let gscNote: string | undefined;
  try {
    const gsc = await fetchGscQueries(run.agentConfig.workspaceId);
    if (gsc && gsc.rows.length > 0) {
      const seedTerms = seedKeywords.toLowerCase().split(/[\s,]+/).filter((t) => t.length > 2);
      const byImpressions = [...gsc.rows].sort((a, b) => b.impressions - a.impressions);
      const related = seedTerms.length
        ? byImpressions.filter((r) => seedTerms.some((t) => r.keys[0].toLowerCase().includes(t)))
        : [];
      const picked = [...new Map([...related.slice(0, 150), ...byImpressions.slice(0, 100)].map((r) => [r.keys[0], r])).values()];
      const lines = picked
        .map((r) => `${r.keys[0]}\t${r.impressions}\t${r.clicks}\t${r.position.toFixed(1)}`)
        .join("\n");
      liveDataSection += `\n\nGOOGLE SEARCH CONSOLE DATA for ${gsc.property}, last 90 days (query, impressions, clicks, avg position):\n${lines}\n\nThese are the site's REAL queries. Build clusters around them: prioritise queries at positions 8-30 with meaningful impressions (striking distance), and use impressions as the demand signal. Impressions are not monthly search volume; still estimate volume, but keep it consistent with these impressions.`;
      source = source === "live" ? "live+gsc" : "gsc";
    } else if (gsc) {
      gscNote = `Search Console (${gsc.property}) returned no queries for the last 90 days.`;
    }
  } catch (err) {
    gscNote = `Search Console data could not be loaded: ${err instanceof Error ? err.message : String(err)}`;
  }
  // --- End live API ---

  const systemPrompt = `You are an expert SEO strategist and keyword researcher with 15+ years of experience. Your task is to expand seed keywords into comprehensive keyword clusters with article briefs.

Business context:
- Business: ${businessProfile?.businessName ?? "Unknown"}
- Industry: ${industry}
- Target Country: ${targetCountry}
- Description: ${businessProfile?.uniqueValueProp ?? "Not provided"}

Clustering method: ${clusterMethod}
Brief depth: ${briefDepth}
Max keywords: ${maxKeywords}

Return ONLY valid JSON with no markdown fencing or explanation. The JSON must follow this exact structure:
{
  "seeds": ["original seed keywords"],
  "clusters": [
    {
      "name": "cluster name",
      "intent": "informational|transactional|navigational|commercial",
      "funnelStage": "top|middle|bottom",
      "keywords": [
        {
          "keyword": "keyword phrase",
          "estimatedVolume": 1200,
          "difficulty": 45,
          "winnable": true,
          "cpc": 2.50,
          "serp": {
            "features": ["featured_snippet", "people_also_ask"],
            "topDomainDR": 72
          }
        }
      ],
      "brief": {
        "title": "article title",
        "targetKeyword": "primary keyword",
        "secondaryKeywords": ["kw1", "kw2"],
        "outline": ["H2: Section 1", "H2: Section 2", "H3: Subsection"],
        "wordCount": 1800,
        "contentType": "how-to|listicle|comparison|guide|pillar",
        "priorityScore": 87
      }
    }
  ],
  "summary": {
    "totalKeywords": 85,
    "highPriority": 12,
    "winnableKeywords": 34,
    "estimatedMonthlyTrafficPotential": 15000,
    "avgDifficulty": 42,
    "topOpportunity": "keyword with best potential"
  }
}`;

  const userPrompt = `Expand these seed keywords for a ${industry} business targeting ${targetCountry}:

Seeds: ${seedKeywords}
${liveDataSection}
Generate up to ${maxKeywords} keywords total, grouped into clusters using the ${clusterMethod} clustering method.
${briefDepth === "Full" ? "Provide full article briefs with detailed outlines (5+ H2s with sub-H3s) for each cluster." : "Provide basic briefs with title, target keyword, and top 3 sections only."}
Focus on realistic keyword metrics for the ${targetCountry} market.
Hard filters — exclude any keyword that fails them: monthly volume below ${minVolume}; keyword difficulty above ${maxDifficulty} (0-100 scale).
${intentFilter === "all" ? "Cover all search intents." : `Only include ${intentFilter}-intent keywords and clusters; exclude every other intent.`}
${includeQuestions ? "Include question-format queries (People Also Ask style: how, what, why, which...) alongside head and long-tail terms." : "Exclude question-format queries; keep to head and long-tail non-question terms."}
Prioritize commercially valuable, winnable keywords within those limits.
Aim for at least 4 distinct clusters${intentFilter === "all" ? " covering different buyer journey stages" : ""}.`;

  // Sonnet 5 thinks before answering, and thinking spends the same max_tokens.
  // At 8096 a run on 2026-09-17 spent every token thinking, returned no text at
  // all, and still went to AWAITING_APPROVAL as {"result": ""}. Streaming lets
  // the ceiling sit well clear of that without tripping the SDK's
  // non-streaming timeout guard.
  const message = await client.messages
    .stream({
      model: MODELS.standard,
      max_tokens: 64000,
      output_config: { effort: "medium" },
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    })
    .finalMessage();

  assertNotTruncated(message, "The keyword research");
  const parsed = jsonFrom<Record<string, unknown>>(textFrom(message));
  if (!parsed || !Array.isArray(parsed.clusters) || parsed.clusters.length === 0) {
    // Never hand a person an empty result to approve. AgentInputError (not a bare Error) so the
    // run page says what happened and what to do: describeRunError's fallback for an untyped
    // throw reads "a fault in the agent itself, not in anything you entered", which is exactly
    // wrong here — an empty answer is a transient model outcome, and re-running usually fixes it.
    // Both are equally non-retryable, so this changes the wording, never the billing.
    throw new AgentInputError(
      "The keyword research came back without any keyword clusters.",
      "Nothing was saved and the run can simply be started again. If it keeps coming back empty, narrow the seed keywords or lower \"Max Keywords\" — a very broad brief is the usual cause.",
      "keyword_research_empty",
    );
  }
  const output: Record<string, unknown> = parsed;

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;
  output.source = source;
  if (gscNote) output.gscNote = gscNote;
  if (source === "live" || source === "live+gsc") {
    delete output.simulationNote;
  } else if (source === "gsc") {
    output.simulationNote =
      "Queries, impressions and positions are real Search Console data. Search volume, difficulty and CPC are estimates — connect Ahrefs, Semrush, or SearchAtlas for measured values.";
  } else {
    output.simulationNote =
      "Connect Ahrefs, Semrush, or SearchAtlas in Settings to enable live search volume, keyword difficulty, and CPC data. Add competitor domains to also pull real content-gap keywords via SearchAtlas.";
  }

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  return { output, costUsd };
};

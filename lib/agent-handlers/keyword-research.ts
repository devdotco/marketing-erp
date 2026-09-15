import type { AgentHandler } from "./index";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { bool, num, resolveInputs, str } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { bareDomain, fetchAhrefsOrganicKeywords, fetchSearchAtlasKeywordGap, fetchSemrushPhraseThis, resolveSeoLiveData } from "./seo-data-providers";

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
  const source = liveResult.source;
  if (liveResult.source === "live") liveDataSection = liveResult.section;
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

  const message = await client.messages.create({
    model: MODELS.standard,
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = textFrom(message);
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { result: rawText };
  } catch {
    output = { result: rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;
  output.source = source;
  if (source === "live") {
    delete output.simulationNote;
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

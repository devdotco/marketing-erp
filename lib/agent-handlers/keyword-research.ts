import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const keywordResearchHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const seedKeywords = (config.seedKeywords as string) ?? "";
  const industry = (config.industry as string) ?? "general";
  const targetCountry = (config.targetCountry as string) ?? "US";
  const clusterMethod = (config.clusterMethod as string) ?? "Intent";
  const briefDepth = (config.briefDepth as string) ?? "Full";
  const maxKeywords = (config.maxKeywords as number) ?? 100;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

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

Generate up to ${maxKeywords} keywords total, grouped into clusters using the ${clusterMethod} clustering method.
${briefDepth === "Full" ? "Provide full article briefs with detailed outlines (5+ H2s with sub-H3s) for each cluster." : "Provide basic briefs with title, target keyword, and top 3 sections only."}
Focus on realistic keyword metrics for the ${targetCountry} market.
Prioritize commercially valuable, winnable keywords (difficulty < 60, volume > 100/mo).
Aim for at least 4 distinct clusters covering different buyer journey stages.`;

  const message = await client.messages.create({
    model: "claude-sonnet-5-20251015",
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { result: rawText };
  } catch {
    output = { result: rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;
  output.simulationNote =
    "Connect Ahrefs, Semrush, or Google Keyword Planner in Settings to enable live search volume, keyword difficulty, and CPC data";

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return { output, costUsd };
};

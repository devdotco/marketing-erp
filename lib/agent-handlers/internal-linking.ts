import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const internalLinkingHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const siteUrl = typeof config.siteUrl === "string" ? config.siteUrl : "https://example.com";
  const maxPagesToAnalyze = typeof config.maxPagesToAnalyze === "number" ? config.maxPagesToAnalyze : 200;
  const anchorDiversityMode = config.anchorDiversityMode !== false;
  const priorityPages = typeof config.priorityPages === "string" ? config.priorityPages : "";

  const businessProfile = await prisma.businessProfile.findFirst({ where: { workspaceId: run.agentConfig.workspaceId } });

  const systemPrompt = `You are a technical SEO specialist who builds and optimizes internal link graphs for large content sites. You identify orphaned pages (zero inbound internal links), link equity leaks (pages with many outbound links but few inbound), and high-value contextual linking opportunities. You enforce anchor text diversity to avoid over-optimization penalties — no anchor should appear more than 15% of the time for any given target page. You think in PageRank distribution, topical authority clustering, and crawl efficiency. Always return valid, minified JSON with no markdown fences.`;

  const userPrompt = `Analyze the internal link graph for ${siteUrl} and produce a complete linking strategy for up to ${maxPagesToAnalyze} pages.

Business context:
- Company: ${businessProfile?.businessName ?? "Unknown Company"}
- Industry: ${businessProfile?.industry ?? "General Business"}
- Description: ${businessProfile?.uniqueValueProp ?? "No description provided"}

Configuration:
- Site URL: ${siteUrl}
- Pages to analyze: ${maxPagesToAnalyze}
- Anchor diversity mode: ${anchorDiversityMode ? "ON — enforce <15% anchor reuse per target page" : "OFF — standard anchor suggestions"}

Priority pages that MUST receive strong internal link support (money pages):
${priorityPages || "Infer high-value pages from site structure (pricing, contact, main service pages)"}

Tasks:
1. Map the current internal link graph (pages, inbound links, outbound links, orphan status)
2. Identify all orphaned pages (0 inbound internal links)
3. Identify link equity leaks (high outbound, low inbound ratio)
4. Propose specific new internal links: source page URL, target page URL, exact anchor text, sentence insertion context
5. If anchor diversity mode is ON: for each target page list the anchor text distribution, flag over-used anchors, and suggest diverse alternatives
6. Propose a crawl priority ordering based on link depth

Return this exact JSON structure (no markdown, no code fences):
{
  "linkGraphSummary": {
    "siteUrl": "${siteUrl}",
    "totalPagesAnalyzed": 0,
    "totalInternalLinks": 0,
    "averageInboundLinksPerPage": 0,
    "averageOutboundLinksPerPage": 0,
    "averageLinkDepthFromHomepage": 0,
    "orphanedPageCount": 0,
    "linkEquityLeakCount": 0,
    "anchorDiversityModeEnabled": ${anchorDiversityMode},
    "overOptimizedAnchorsFound": 0
  },
  "pageInventory": [
    {
      "url": "",
      "pageTitle": "",
      "inboundInternalLinks": 0,
      "outboundInternalLinks": 0,
      "linkDepthFromHomepage": 0,
      "isOrphan": false,
      "isLinkEquityLeak": false,
      "isPriorityPage": false,
      "topicCategory": "",
      "pageAuthorityEstimate": 0
    }
  ],
  "orphanedPages": [
    {
      "url": "",
      "pageTitle": "",
      "topicCategory": "",
      "recommendedLinkSources": [
        {
          "sourceUrl": "",
          "sourcePageTitle": "",
          "suggestedAnchorText": "",
          "insertionContext": "",
          "relevanceScore": 0
        }
      ],
      "urgency": ""
    }
  ],
  "linkEquityLeaks": [
    {
      "url": "",
      "pageTitle": "",
      "inboundLinks": 0,
      "outboundLinks": 0,
      "leakRatio": 0,
      "recommendation": ""
    }
  ],
  "proposedLinks": [
    {
      "id": "",
      "sourceUrl": "",
      "sourcePageTitle": "",
      "targetUrl": "",
      "targetPageTitle": "",
      "anchorText": "",
      "insertionContext": "",
      "isPriorityPageTarget": false,
      "relevanceScore": 0,
      "expectedAuthorityTransfer": 0,
      "implementationDifficulty": ""
    }
  ],
  "anchorDiversityReport": [
    {
      "targetUrl": "",
      "currentAnchors": [
        {
          "anchorText": "",
          "useCount": 0,
          "percentageOfTotal": 0,
          "isOverOptimized": false
        }
      ],
      "recommendedDiverseAnchors": [],
      "anchorsToReplace": []
    }
  ],
  "crawlPriorityOrder": [],
  "implementationPlan": [
    {
      "phase": 1,
      "label": "",
      "linkIds": [],
      "estimatedImpact": "",
      "estimatedTimeHours": 0
    }
  ],
  "quickWinLinks": []
}`;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
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
    "Connect your site via the Crawler integration in Settings to enable live sitemap ingestion and real-time link graph mapping across all " + maxPagesToAnalyze + " pages. Live crawl data will replace the simulated page inventory with actual URLs, anchor text counts, and link depth measurements.";

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  return { output, costUsd };
};

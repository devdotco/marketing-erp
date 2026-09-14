import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { resolveInputs } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { listPublishedPosts, type PayloadCredentials, type PayloadPost } from "@/lib/integrations/payload";

export const internalLinkingHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);
  const workspaceId = run.agentConfig.workspaceId;

  // When Payload is connected, ground this in the workspace's real pages
  // instead of letting the model invent a plausible-looking site structure —
  // this is still a Claude-simulated link-graph analysis (no real inbound/
  // outbound counts or crawl are performed), just no longer working from
  // fabricated URLs. Best effort: a Payload hiccup falls back to the fully
  // simulated behaviour rather than failing this agent.
  const payloadIntegration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId, provider: "PAYLOAD" } },
  });
  let payloadPosts: PayloadPost[] = [];
  let payloadCreds: PayloadCredentials | null = null;
  if (payloadIntegration) {
    try {
      payloadCreds = await decryptCredentials<PayloadCredentials>(payloadIntegration.encryptedCredentials);
      payloadPosts = await listPublishedPosts(payloadCreds, 150);
    } catch {
      // Falls through to the simulated page inventory below.
    }
  }

  const siteUrl = typeof config.siteUrl === "string" && config.siteUrl
    ? config.siteUrl
    : payloadCreds?.siteUrl ?? "https://example.com";
  const maxPagesToAnalyze = typeof config.maxPagesToAnalyze === "number" ? config.maxPagesToAnalyze : 200;
  const anchorDiversityMode = config.anchorDiversityMode !== false;
  const priorityPages = typeof config.priorityPages === "string" ? config.priorityPages : "";

  const businessProfile = await prisma.businessProfile.findFirst({ where: { workspaceId } });

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
${payloadPosts.length > 0 ? `
ACTUAL PAGES on this site, read from the connected Payload CMS (title — URL). Use these exact URLs for every page they cover instead of inventing one; only infer a URL for a page genuinely absent from this list (e.g. the homepage or a pricing page not managed in Payload):
${payloadPosts.slice(0, 80).map((p) => `- ${p.title || "(untitled)"} — ${p.url}`).join("\n")}` : ""}

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
    model: MODELS.fast,
    max_tokens: 4096,
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
  output.workspaceId = workspaceId;
  output.payloadPostsUsed = payloadPosts.length;
  output.simulationNote = payloadPosts.length > 0
    ? `Page URLs and titles for ${payloadPosts.length} page(s) came from your connected Payload CMS. Inbound/outbound link counts, depth and the proposed link graph are still a Claude estimate, not a real crawl — there is no live sitemap crawler yet.`
    : "Connect Payload CMS (or another CMS) under Settings → Integrations to ground this in your site's actual pages instead of an inferred structure. Inbound/outbound link counts, depth and the proposed link graph are still a Claude estimate, not a real crawl — there is no live sitemap crawler yet.";

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

  return { output, costUsd };
};

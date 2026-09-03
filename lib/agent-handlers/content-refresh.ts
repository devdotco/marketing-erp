import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const contentRefreshHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const siteUrl = typeof config.siteUrl === "string" ? config.siteUrl : "https://example.com";
  const maxPagesPerRun = typeof config.maxPagesPerRun === "number" ? config.maxPagesPerRun : 10;
  const decayThresholdDays = typeof config.decayThresholdDays === "number" ? config.decayThresholdDays : 180;
  const refreshDepth = typeof config.refreshDepth === "string" ? config.refreshDepth : "Medium";
  const cmsTarget = typeof config.cmsTarget === "string" ? config.cmsTarget : "Draft";

  const businessProfile = await prisma.businessProfile.findFirst({ where: { workspaceId: run.agentConfig.workspaceId } });

  const systemPrompt = `You are a senior content strategist specializing in content decay analysis and SEO-driven rewrites. You identify pages with declining organic traffic, outdated information, thin content, and broken internal links. For each decaying page you produce targeted refresh recommendations: section-level rewrites, updated statistics, improved heading structure, new FAQs, and CTA upgrades. Your rewrites are conversion-aware and maintain the original URL's link equity. Always return valid, minified JSON with no markdown fences.`;

  const userPrompt = `Analyze content decay for ${siteUrl} and produce a refresh plan for up to ${maxPagesPerRun} pages.

Business context:
- Company: ${businessProfile?.businessName ?? "Unknown Company"}
- Industry: ${businessProfile?.industry ?? "General Business"}
- Description: ${businessProfile?.uniqueValueProp ?? "No description provided"}

Configuration:
- Site URL: ${siteUrl}
- Pages to process this run: ${maxPagesPerRun}
- Decay threshold: content not updated in ${decayThresholdDays}+ days is considered decaying
- Refresh depth: ${refreshDepth} (Light = metadata + stats only; Medium = section rewrites + new FAQ; Full = complete structural rewrite)
- CMS target for publishing: ${cmsTarget}

For each decaying page, provide:
1. URL and current title
2. Decay signals detected (traffic drop %, last modified date, thin content indicators, broken links count)
3. Priority score (1-100, where 100 = refresh immediately)
4. Decay categories present
5. Section-by-section refresh recommendations with actual rewritten copy
6. New FAQ block (3-5 questions)
7. Updated meta title and description
8. Internal linking additions
9. Estimated traffic recovery potential
10. CMS-specific publish instructions for ${cmsTarget}

Return this exact JSON structure (no markdown, no code fences):
{
  "refreshSummary": {
    "siteUrl": "${siteUrl}",
    "pagesAnalyzed": 0,
    "pagesRequiringRefresh": 0,
    "pagesScheduledThisRun": 0,
    "refreshDepth": "${refreshDepth}",
    "cmsTarget": "${cmsTarget}",
    "estimatedTotalTrafficRecoveryPercent": 0,
    "decayThresholdDays": ${decayThresholdDays}
  },
  "decaySignalBreakdown": {
    "trafficDrop": 0,
    "outdatedStatistics": 0,
    "thinContent": 0,
    "brokenInternalLinks": 0,
    "missingSchemaMarkup": 0,
    "poorCoreWebVitals": 0
  },
  "pages": [
    {
      "url": "",
      "currentTitle": "",
      "lastModifiedDate": "",
      "daysSinceUpdate": 0,
      "priorityScore": 0,
      "decayCategories": [],
      "trafficTrend": {
        "threeMonthChangePercent": 0,
        "sixMonthChangePercent": 0,
        "currentMonthlyVisits": 0
      },
      "currentIssues": {
        "wordCount": 0,
        "readabilityScore": 0,
        "brokenLinksCount": 0,
        "outdatedStatsCount": 0,
        "missingAltTags": 0,
        "coreWebVitalsStatus": ""
      },
      "refreshPlan": {
        "updatedMetaTitle": "",
        "updatedMetaDescription": "",
        "sectionRewrites": [
          {
            "sectionHeading": "",
            "currentContentSummary": "",
            "rewrittenContent": "",
            "changeRationale": ""
          }
        ],
        "newFaqBlock": [
          {
            "question": "",
            "answer": ""
          }
        ],
        "newInternalLinks": [
          {
            "anchorText": "",
            "targetUrl": "",
            "insertionContext": ""
          }
        ],
        "updatedStatistics": [
          {
            "oldStat": "",
            "newStat": "",
            "source": ""
          }
        ],
        "newCta": {
          "headline": "",
          "bodyText": "",
          "buttonLabel": "",
          "targetUrl": ""
        }
      },
      "cmsPublishInstructions": {
        "platform": "${cmsTarget}",
        "steps": [],
        "scheduledPublishDate": "",
        "preserveOriginalUrl": true
      },
      "estimatedTrafficRecoveryPercent": 0,
      "estimatedTimeToResultWeeks": 0
    }
  ],
  "deferredPages": [
    {
      "url": "",
      "reason": "",
      "revisitDate": ""
    }
  ],
  "globalRecommendations": []
}`;

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
    "Connect Google Search Console in Settings to pull real traffic decay signals, impressions, and click data per URL. Connect your CMS (WordPress/Storyblok/Webflow) to auto-publish refreshed content directly to the original URL without manual copy-paste.";

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return { output, costUsd };
};

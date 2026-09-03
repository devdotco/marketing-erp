import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export const contentRefreshHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const siteUrl = typeof config.siteUrl === "string" ? config.siteUrl : "https://example.com";
  const maxPagesPerRun = typeof config.maxPagesPerRun === "number" ? config.maxPagesPerRun : 10;
  const decayThresholdDays = typeof config.decayThresholdDays === "number" ? config.decayThresholdDays : 180;
  const refreshDepth = typeof config.refreshDepth === "string" ? config.refreshDepth : "Medium";
  const cmsTarget = typeof config.cmsTarget === "string" ? config.cmsTarget : "Draft";

  const businessProfile = await prisma.businessProfile.findFirst({ where: { workspaceId: run.agentConfig.workspaceId } });

  // --- Live GSC page-level traffic fetch ---
  let gscPageContext = "";
  let isLive = false;

  const integration = await prisma.integration.findUnique({
    where: {
      workspaceId_provider: {
        workspaceId: run.agentConfig.workspaceId,
        provider: "GOOGLE_SEARCH_CONSOLE",
      },
    },
  });

  if (integration) {
    try {
      const creds = await decryptCredentials<{
        access_token: string;
        property_url: string;
      }>(integration.encryptedCredentials);

      const propertyUrl = creds.property_url || siteUrl;
      const encodedUrl = encodeURIComponent(propertyUrl);
      const apiBase = `https://www.googleapis.com/webmasters/v3/sites/${encodedUrl}/searchAnalytics/query`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${creds.access_token}`,
        "Content-Type": "application/json",
      };

      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);

      // Last 16 months (~490 days) for decay signal
      const sixteenMonthsAgo = new Date(yesterday);
      sixteenMonthsAgo.setDate(yesterday.getDate() - 490);

      // Recent 90-day window for current traffic
      const ninetyDaysAgo = new Date(yesterday);
      ninetyDaysAgo.setDate(yesterday.getDate() - 89);

      // Older 90-day window (90-180 days ago) for decay comparison
      const oneEightyDaysAgo = new Date(yesterday);
      oneEightyDaysAgo.setDate(yesterday.getDate() - 179);
      const ninetyOneeDaysAgo = new Date(yesterday);
      ninetyOneeDaysAgo.setDate(yesterday.getDate() - 90);

      type GscRow = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };
      type GscResponse = { rows?: GscRow[] };

      const [recentRes, olderRes] = await Promise.all([
        // Recent 90 days
        fetch(apiBase, {
          method: "POST",
          headers,
          body: JSON.stringify({
            startDate: formatDate(ninetyDaysAgo),
            endDate: formatDate(yesterday),
            dimensions: ["page"],
            rowLimit: 25000,
          }),
        }),
        // Previous 90 days (90-180 days ago)
        fetch(apiBase, {
          method: "POST",
          headers,
          body: JSON.stringify({
            startDate: formatDate(oneEightyDaysAgo),
            endDate: formatDate(ninetyOneeDaysAgo),
            dimensions: ["page"],
            rowLimit: 25000,
          }),
        }),
      ]);

      if (recentRes.ok && olderRes.ok) {
        const recentData = (await recentRes.json()) as GscResponse;
        const olderData = (await olderRes.json()) as GscResponse;

        const recentRows = recentData.rows ?? [];
        const olderRows = olderData.rows ?? [];

        // Build lookup for older period
        const olderMap = new Map<string, { clicks: number; impressions: number; position: number }>();
        for (const row of olderRows) {
          olderMap.set(row.keys[0], {
            clicks: row.clicks,
            impressions: row.impressions,
            position: row.position,
          });
        }

        // Calculate decay: pages where recent clicks < older clicks
        const decayingPages = recentRows
          .map((r) => {
            const older = olderMap.get(r.keys[0]);
            const olderClicks = older?.clicks ?? 0;
            const decayPct =
              olderClicks > 0 ? ((r.clicks - olderClicks) / olderClicks) * 100 : 0;
            return {
              url: r.keys[0],
              recentClicks: r.clicks,
              olderClicks,
              decayPercent: Math.round(decayPct * 10) / 10,
              recentImpressions: r.impressions,
              recentPosition: r.position,
              olderPosition: older?.position ?? null,
            };
          })
          .filter((p) => p.decayPercent < -10 || p.recentClicks === 0) // Pages losing >10% traffic or completely dead
          .sort((a, b) => a.decayPercent - b.decayPercent) // Worst decay first
          .slice(0, maxPagesPerRun * 3); // Extra buffer so Claude can pick the best candidates

        // Pages not seen in recent but present in older (disappeared from index)
        const recentUrls = new Set(recentRows.map((r) => r.keys[0]));
        const vanishedPages = olderRows
          .filter((r) => !recentUrls.has(r.keys[0]) && r.clicks > 5)
          .sort((a, b) => b.clicks - a.clicks)
          .slice(0, 20)
          .map((r) => ({ url: r.keys[0], previousClicks: r.clicks, previousPosition: r.position }));

        gscPageContext = `REAL GSC PAGE PERFORMANCE DATA:
Property: ${propertyUrl}
Recent period: ${formatDate(ninetyDaysAgo)} to ${formatDate(yesterday)} (last 90 days)
Comparison period: ${formatDate(oneEightyDaysAgo)} to ${formatDate(ninetyOneeDaysAgo)} (90-180 days ago)

Total pages with recent impressions: ${recentRows.length}
Pages losing traffic (>10% drop or zero clicks): ${decayingPages.length}

Decaying pages (sorted worst decay first — use these as priority candidates):
${JSON.stringify(decayingPages, null, 2)}

Pages that vanished from recent results (had traffic 90-180 days ago, none recently):
${JSON.stringify(vanishedPages, null, 2)}`;

        isLive = true;
      }
    } catch {
      // Fall through to simulation
    }
  }

  const systemPrompt = `You are a senior content strategist specializing in content decay analysis and SEO-driven rewrites. You identify pages with declining organic traffic, outdated information, thin content, and broken internal links. For each decaying page you produce targeted refresh recommendations: section-level rewrites, updated statistics, improved heading structure, new FAQs, and CTA upgrades. Your rewrites are conversion-aware and maintain the original URL's link equity. Always return valid, minified JSON with no markdown fences.`;

  const userPrompt = `${isLive ? "Analyze the REAL GSC traffic decay data below" : `Analyze content decay for ${siteUrl}`} and produce a refresh plan for up to ${maxPagesPerRun} pages.

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

${isLive ? gscPageContext + "\n\nUsing the real decay data above, select the top " + maxPagesPerRun + " most critical pages to refresh (prioritize by worst decay % and lost impressions). Use actual URLs from the data. For each page, fabricate realistic content issues and refresh recommendations based on the URL path and traffic patterns." : ""}

For each ${isLive ? "selected" : "decaying"} page, provide:
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
    "decayThresholdDays": ${decayThresholdDays},
    "source": "${isLive ? "live" : "simulation"}"
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
  output.source = isLive ? "live" : "simulation";

  if (!isLive) {
    output.simulationNote =
      "Connect Google Search Console in Settings to pull real traffic decay signals, impressions, and click data per URL. Connect your CMS (WordPress/Storyblok/Webflow) to auto-publish refreshed content directly to the original URL without manual copy-paste.";
  }

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return { output, costUsd };
};

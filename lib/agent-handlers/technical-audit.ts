import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export const technicalAuditHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const crawlDepth = Number(config.crawlDepth ?? 3);
  const gscProperty = String(config.gscProperty ?? "");
  const focusArea = String(config.focusArea ?? "Full audit");
  const includePerformance = config.includePerformance !== false;
  const maxPages = Number(config.maxPages ?? 500);

  // Fetch business profile for website URL and context
  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const websiteUrl = String(config.websiteUrl ?? businessProfile?.websiteUrl ?? "");
  const industry = businessProfile?.industry ?? "general";
  const businessName = businessProfile?.businessName ?? "this website";

  // --- Live GSC indexability signal ---
  let gscIndexabilityContext = "";
  let isGscLive = false;

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

      const propertyUrl = creds.property_url || gscProperty;
      const encodedUrl = encodeURIComponent(propertyUrl);
      const apiBase = `https://www.googleapis.com/webmasters/v3/sites/${encodedUrl}/searchAnalytics/query`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${creds.access_token}`,
        "Content-Type": "application/json",
      };

      // Last 90 days, page-level data for indexability signal
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      const ninetyDaysAgo = new Date(yesterday);
      ninetyDaysAgo.setDate(yesterday.getDate() - 89);

      type GscRow = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };
      type GscResponse = { rows?: GscRow[] };

      const res = await fetch(apiBase, {
        method: "POST",
        headers,
        body: JSON.stringify({
          startDate: formatDate(ninetyDaysAgo),
          endDate: formatDate(yesterday),
          dimensions: ["page"],
          rowLimit: 25000,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as GscResponse;
        const rows = data.rows ?? [];

        // Sort pages: zero-click pages first (indexability risk), then by clicks desc
        const zeroClickPages = rows
          .filter((r) => r.clicks === 0 && r.impressions > 0)
          .sort((a, b) => b.impressions - a.impressions)
          .slice(0, 50);

        const topPages = rows
          .filter((r) => r.clicks > 0)
          .sort((a, b) => b.clicks - a.clicks)
          .slice(0, 100);

        const totalIndexedPages = rows.length;
        const totalClicks = rows.reduce((s, r) => s + r.clicks, 0);
        const totalImpressions = rows.reduce((s, r) => s + r.impressions, 0);
        const pagesWithNoClicks = rows.filter((r) => r.clicks === 0).length;

        gscIndexabilityContext = `REAL GSC INDEXABILITY SIGNAL (last 90 days, ${formatDate(ninetyDaysAgo)} to ${formatDate(yesterday)}):
Property: ${propertyUrl}
Total pages with impressions in GSC: ${totalIndexedPages}
Pages receiving clicks: ${totalIndexedPages - pagesWithNoClicks}
Pages with impressions but zero clicks (CTR issues): ${pagesWithNoClicks}
Total site clicks (90d): ${totalClicks}
Total site impressions (90d): ${totalImpressions}

Pages with impressions but ZERO clicks (potential indexability/CTR issues — top 50 by impressions):
${JSON.stringify(zeroClickPages.map((r) => ({ url: r.keys[0], impressions: r.impressions, position: r.position })), null, 2)}

Top performing pages by clicks (top 100):
${JSON.stringify(topPages.map((r) => ({ url: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })), null, 2)}`;

        isGscLive = true;
      }
    } catch {
      // Fall through — crawl simulation still runs
    }
  }

  const systemPrompt = [
    "You are a senior technical SEO specialist with 10+ years of experience auditing enterprise and SMB websites.",
    "You produce structured, actionable audit reports that prioritize findings by revenue impact.",
    "Every issue you report includes: what it is, why it matters for SEO, and exactly how to fix it.",
    "Return ONLY valid JSON — no markdown fences, no preamble.",
  ].join("\n");

  const auditScope = focusArea === "Full audit"
    ? "indexability, crawl efficiency, page speed, Core Web Vitals, structured data, internal linking, mobile usability, HTTPS/security headers, URL structure, duplicate content, canonical tags, hreflang (if multilingual), XML sitemap, robots.txt"
    : focusArea;

  const userPrompt = [
    `Generate a comprehensive technical SEO audit report for ${websiteUrl ? `"${websiteUrl}"` : businessName}.`,
    `Industry: ${industry}`,
    `Crawl configuration: depth ${crawlDepth}, max ${maxPages} pages`,
    gscProperty || isGscLive
      ? `Google Search Console property: ${gscProperty || "Connected"}`
      : "GSC: not connected — note this as a setup recommendation",
    `Audit scope: ${auditScope}`,
    includePerformance ? "Include Core Web Vitals and page speed analysis." : "",
    "",
    isGscLive
      ? `IMPORTANT: Use the real GSC indexability data below to inform your audit findings. Identify actual pages with CTR problems, flag zero-click pages with high impressions as indexability/metadata candidates, and reference real URLs in your criticalIssues and warnings.

${gscIndexabilityContext}`
      : "",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      summary: "3-4 sentence executive summary of the site's technical SEO health",
      overallScore: 72,
      crawledPages: maxPages,
      auditDate: new Date().toISOString().split("T")[0],
      gscSource: isGscLive ? "live" : "simulation",
      criticalIssues: [
        {
          title: "Issue title",
          description: "What is wrong and why it hurts rankings",
          priority: "CRITICAL",
          effort: "LOW",
          impact: "HIGH",
          affectedPages: 0,
          exampleUrls: ["https://example.com/page"],
          fix: "Step-by-step instructions to fix this issue",
        },
      ],
      warnings: [
        {
          title: "Warning title",
          description: "What is suboptimal and why",
          priority: "MEDIUM",
          effort: "MEDIUM",
          impact: "MEDIUM",
          recommendation: "Specific action to take",
        },
      ],
      passed: ["Check that passed"],
      performanceMetrics: {
        lcpSeconds: 2.4,
        fidMs: 45,
        cls: 0.08,
        ttfbMs: 380,
        mobileSpeedScore: 68,
        desktopSpeedScore: 85,
      },
      quickWins: [
        { action: "Specific quick action", estimatedImpact: "Expected SEO improvement" },
      ],
      setupRecommendations: gscProperty || isGscLive ? [] : ["Connect Google Search Console to enable position tracking and click data"],
    }),
  ].filter(Boolean).join("\n");

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
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { report: rawText };
  } catch {
    output = { report: rawText };
  }

  output.websiteUrl = websiteUrl;
  output.generatedAt = new Date().toISOString();
  output.source = isGscLive ? "live" : "simulation";
  output.note = isGscLive
    ? "GSC indexability data is live. Crawl analysis is simulated — connect a real crawler integration for full crawl data."
    : "This is a simulated audit. Connect Google Search Console and enable real crawling for live data.";

  // Haiku 4.5 pricing: $0.80/M input, $4/M output
  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  return { output, costUsd };
};

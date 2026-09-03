import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

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
    gscProperty ? `Google Search Console property: ${gscProperty}` : "GSC: not connected — note this as a setup recommendation",
    `Audit scope: ${auditScope}`,
    includePerformance ? "Include Core Web Vitals and page speed analysis." : "",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      summary: "3-4 sentence executive summary of the site's technical SEO health",
      overallScore: 72,
      crawledPages: maxPages,
      auditDate: new Date().toISOString().split("T")[0],
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
      setupRecommendations: gscProperty ? [] : ["Connect Google Search Console to enable position tracking and click data"],
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
  output.note = "This is a simulated audit. Connect Google Search Console and enable real crawling for live data.";

  // Haiku 4.5 pricing: $0.80/M input, $4/M output
  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  return { output, costUsd };
};

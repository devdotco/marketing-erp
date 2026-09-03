import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const backlinkMonitorHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const monitoredDomain = String(config.monitoredDomain ?? "");
  const alertOnLost = config.alertOnLost !== false;
  const toxicThreshold = String(config.toxicThreshold ?? "Standard");
  const disavowAutoUpdate = config.disavowAutoUpdate === true;
  const competitorDomains = String(config.competitorDomains ?? "");

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business: ${businessProfile.businessName}` : "",
        businessProfile.websiteUrl ? `Website: ${businessProfile.websiteUrl}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.goals ? `SEO goals: ${JSON.stringify(businessProfile.goals)}` : "",
      ].filter(Boolean).join("\n")
    : "";

  const toxicThresholdGuidance: Record<string, string> = {
    Strict:
      "Flag any link with spam score above 20%, from sites with thin content, or from sites in unrelated mass niches.",
    Standard:
      "Flag links with spam score above 40%, clear PBN patterns, or link farms. Ignore minor issues.",
    Permissive:
      "Only flag links with very high spam scores (70%+) or from sites that are clearly penalised or deindexed.",
  };
  const toxicGuidance = toxicThresholdGuidance[toxicThreshold] ?? toxicThresholdGuidance.Standard;

  const systemPrompt = [
    "You are a link profile analyst specialising in backlink monitoring and toxic link identification.",
    "Distinguish between link loss due to page removal (permanent) vs noindex/no-crawl (potentially recoverable) vs the referring page being removed (not your problem).",
    "Toxic link identification should use multiple signals — not just spam score alone. Consider: site relevance, link velocity, anchor text distribution, site-wide links, footer links, and patterns suggesting paid link schemes.",
    `Toxicity threshold: ${toxicGuidance}`,
    "Return ONLY valid JSON — no markdown fences, no preamble.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ].filter(Boolean).join("\n");

  const competitorList = competitorDomains
    .split(/[\n,]/)
    .map((d) => d.trim())
    .filter(Boolean);

  const reportDate = new Date().toISOString().split("T")[0];
  const effectiveDomain = monitoredDomain || businessProfile?.websiteUrl?.replace(/^https?:\/\//, "").replace(/\/$/, "") || "yourdomain.com";

  const userPrompt = [
    `Generate a backlink monitoring report for: ${effectiveDomain}`,
    `Report date: ${reportDate}`,
    `Alert on lost links: ${alertOnLost}`,
    `Toxic link threshold: ${toxicThreshold}`,
    `Auto-update disavow file: ${disavowAutoUpdate}`,
    competitorList.length > 0 ? `Competitor domains to compare: ${competitorList.join(", ")}` : "",
    "",
    "Simulate a realistic monitoring report with plausible backlink data for this domain and industry.",
    "Include a mix of new links (editorially earned, some paid-looking), lost links with varied reasons, and a small number of toxic links.",
    "For lostLinks, diagnose each loss reason specifically: '404 on referring page', 'link removed from existing page', 'page moved to noindex', 'domain expired', etc.",
    disavowAutoUpdate
      ? "Since disavowAutoUpdate is enabled, include a disavowFile field with a formatted Google disavow file content for the toxic domains."
      : "Set disavowFile to null (disavow auto-update is off).",
    competitorList.length > 0
      ? `Include a competitorComparison entry for each of: ${competitorList.join(", ")}`
      : "Set competitorComparison to an empty array.",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      reportDate,
      domain: effectiveDomain,
      summary: {
        totalBacklinks: 0,
        newThisPeriod: 0,
        lostThisPeriod: 0,
        toxicFlagged: 0,
        drTrend: "+2 vs last period",
      },
      newLinks: [
        {
          source: "referring-domain.com",
          targetPage: `https://${effectiveDomain}/page`,
          anchorText: "anchor text",
          dr: 0,
          dofollow: true,
          significance: "high",
        },
      ],
      lostLinks: [
        {
          source: "referring-domain.com",
          targetPage: `https://${effectiveDomain}/page`,
          lastSeen: reportDate,
          lossReason: "Specific reason for link loss",
          recoverable: false,
        },
      ],
      toxicLinks: [
        {
          source: "spammy-domain.com",
          toxicityScore: 0,
          reason: "Specific reason why this link is flagged",
          recommendation: "disavow",
        },
      ],
      disavowFile: disavowAutoUpdate
        ? "# Disavow file generated by marketing-erp\n# Date: " + reportDate + "\ndomain:spammy-domain.com"
        : null,
      competitorComparison:
        competitorList.length > 0
          ? competitorList.map((c) => ({
              competitor: c,
              newLinks: 0,
              lostLinks: 0,
              drChange: "+0",
            }))
          : [],
      simulationNote:
        "Connect Ahrefs in Settings to monitor your real backlink profile. This report is AI-generated based on your domain profile.",
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
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { rawText };
  } catch {
    output = { rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  // Haiku 4.5 pricing: $0.80/M input, $4/M output
  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};

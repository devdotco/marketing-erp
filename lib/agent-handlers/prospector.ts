import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

export const prospectorHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const targetTopics = String(config.targetTopics ?? "");
  const domainRatingMin = Number(config.domainRatingMin ?? 30);
  const trafficMin = Number(config.trafficMin ?? 1000);
  const prospectCount = Number(config.prospectCount ?? 30);
  const excludeDomains = String(config.excludeDomains ?? "");
  const linkType = String(config.linkType ?? "Any");

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business: ${businessProfile.businessName}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.websiteUrl ? `Website: ${businessProfile.websiteUrl}` : "",
        businessProfile.targetAudience ? `Target audience: ${businessProfile.targetAudience}` : "",
        businessProfile.uniqueValueProp ? `Unique value proposition: ${businessProfile.uniqueValueProp}` : "",
        businessProfile.competitors.length > 0 ? `Competitors: ${businessProfile.competitors.join(", ")}` : "",
      ].filter(Boolean).join("\n")
    : "";

  // --- Live API: Ahrefs → Semrush ---
  // Use competitor domains from business profile as backlink targets to surface real prospects
  let liveDataSection = "";
  let source: "live" | "simulation" = "simulation";

  const competitorTargets = businessProfile?.competitors ?? [];

  const ahrefsIntegration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "AHREFS" } },
  });

  if (ahrefsIntegration?.encryptedCredentials && competitorTargets.length > 0) {
    try {
      const creds = await decryptCredentials<{ apiKey: string }>(ahrefsIntegration.encryptedCredentials);
      const results: Record<string, unknown>[] = [];
      for (const competitor of competitorTargets.slice(0, 2)) {
        const domain = competitor.replace(/^https?:\/\//, "").replace(/\/$/, "");
        const url = `https://apiv2.ahrefs.com/v3/site-explorer/backlinks?target=${encodeURIComponent(domain)}&token=${encodeURIComponent(creds.apiKey)}&limit=100`;
        const res = await fetch(url, { headers: { "Accept": "application/json" } });
        if (res.ok) {
          const data = await res.json() as unknown;
          results.push({ competitor: domain, backlinks: data });
        }
      }
      if (results.length > 0) {
        liveDataSection = `\n\nLIVE AHREFS BACKLINK DATA for competitor domains:\n${JSON.stringify(results, null, 2)}\n\nThe domains linking to our competitors are prime link prospects. Include the highest-DR, most topically relevant referring domains from this data as your top prospects. Use the real DR values and domains from this data wherever possible.`;
        source = "live";
      }
    } catch {
      // fall through to Semrush
    }
  }

  if (source === "simulation") {
    const semrushIntegration = await prisma.integration.findUnique({
      where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "SEMRUSH" } },
    });
    if (semrushIntegration?.encryptedCredentials && competitorTargets.length > 0) {
      try {
        const creds = await decryptCredentials<{ apiKey: string }>(semrushIntegration.encryptedCredentials);
        const results: { domain: string; data: string }[] = [];
        for (const competitor of competitorTargets.slice(0, 2)) {
          const domain = competitor.replace(/^https?:\/\//, "").replace(/\/$/, "");
          const url = `https://api.semrush.com/?type=domain_organic&domain=${encodeURIComponent(domain)}&key=${encodeURIComponent(creds.apiKey)}&export_columns=Ph,Po,Nq,Cp&database=us`;
          const res = await fetch(url);
          if (res.ok) {
            const text = await res.text();
            results.push({ domain, data: text });
          }
        }
        if (results.length > 0) {
          liveDataSection = `\n\nLIVE SEMRUSH COMPETITOR ORGANIC DATA (columns: Ph=keyword, Po=position, Nq=monthly searches, Cp=CPC):\n${JSON.stringify(results, null, 2)}\n\nUse this data to identify topically relevant domains and realistic traffic/DR estimates for link prospects in this niche.`;
          source = "live";
        }
      } catch {
        // fall through to simulation
      }
    }
  }
  // --- End live API ---

  const systemPrompt = [
    "You are a link building prospector specialising in finding high-quality, topically relevant link opportunities.",
    "Quality over quantity. A domain with DR 40 and 5k monthly traffic in the exact niche beats a DR 70 site with 200k traffic in an unrelated niche.",
    "Flag any site that looks like a PBN, link farm, or guest post mill.",
    "Return ONLY valid JSON — no markdown fences, no preamble.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ].filter(Boolean).join("\n");

  const userPrompt = [
    `Generate ${prospectCount} link building prospects for the following criteria.`,
    liveDataSection,
    targetTopics ? `Target topics / niche: ${targetTopics}` : "",
    `Minimum estimated Domain Rating: ${domainRatingMin}`,
    `Minimum estimated monthly traffic: ${trafficMin}`,
    `Preferred link type: ${linkType}`,
    excludeDomains ? `Exclude these domains (and any close variants): ${excludeDomains}` : "",
    "",
    "For each prospect, identify a specific page and placement opportunity. Estimate DR and monthly traffic realistically based on the site's niche and typical metrics.",
    "Mark topical relevance honestly — only use 'high' for sites where the niche match is very tight.",
    "If a site pattern suggests a PBN or link farm, include it in excludedCount and do not list it as a prospect.",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      totalFound: 0,
      prospects: [
        {
          domain: "example.com",
          pageUrl: "https://example.com/relevant-page",
          pageTitle: "Page title",
          estimatedDR: 0,
          estimatedMonthlyTraffic: 0,
          linkType: "Editorial",
          topicalRelevance: "high",
          contactEmail: null,
          contactName: null,
          outreachAngle: "Why this site would benefit from linking to you",
          linkPlacementOpportunity: "Specific sentence or section where the link fits naturally",
        },
      ],
      qualityScore: 0,
      excludedCount: 0,
      simulationNote:
        "Connect Ahrefs or Semrush in Settings to pull real domain metrics. These prospects are AI-generated based on your niche.",
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
  output.source = source;
  if (source === "live") {
    delete output.simulationNote;
  }

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

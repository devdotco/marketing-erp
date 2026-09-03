import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

export const competitorWatchHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const competitorDomains = String(config.competitorDomains ?? "");
  const trackNewPages = config.trackNewPages !== false;
  const trackKeywords = config.trackKeywords !== false;
  const trackLinks = config.trackLinks !== false;
  const responseFormat = String(config.responseFormat ?? "Both");

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Our business: ${businessProfile.businessName}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.targetAudience ? `Our target audience: ${businessProfile.targetAudience}` : "",
        businessProfile.uniqueValueProp ? `Our UVP: ${businessProfile.uniqueValueProp}` : "",
        businessProfile.competitors.length > 0 ? `Known competitors: ${businessProfile.competitors.join(", ")}` : "",
        businessProfile.goals ? `Our goals: ${JSON.stringify(businessProfile.goals)}` : "",
      ].filter(Boolean).join("\n")
    : "";

  const domains = competitorDomains
    .split(/[\n,]+/)
    .map((d) => d.trim())
    .filter(Boolean);

  // --- Live API: Ahrefs → Semrush ---
  let liveDataSection = "";
  let source: "live" | "simulation" = "simulation";

  const ahrefsIntegration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "AHREFS" } },
  });

  if (ahrefsIntegration?.encryptedCredentials && domains.length > 0) {
    try {
      const creds = await decryptCredentials<{ apiKey: string }>(ahrefsIntegration.encryptedCredentials);
      const results: Record<string, unknown>[] = [];
      for (const domain of domains.slice(0, 3)) {
        const url = `https://apiv2.ahrefs.com/v3/site-explorer/keywords?target=${encodeURIComponent(domain)}&token=${encodeURIComponent(creds.apiKey)}&limit=100`;
        const res = await fetch(url, { headers: { "Accept": "application/json" } });
        if (res.ok) {
          const data = await res.json() as unknown;
          results.push({ domain, data });
        }
      }
      if (results.length > 0) {
        liveDataSection = `\n\nLIVE AHREFS KEYWORD DATA per competitor:\n${JSON.stringify(results, null, 2)}\n\nUse this real keyword data to identify what each competitor is actually ranking for. Base estimatedNewKeywords on this data.`;
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
    if (semrushIntegration?.encryptedCredentials && domains.length > 0) {
      try {
        const creds = await decryptCredentials<{ apiKey: string }>(semrushIntegration.encryptedCredentials);
        const results: { domain: string; data: string }[] = [];
        for (const domain of domains.slice(0, 3)) {
          const url = `https://api.semrush.com/?type=domain_organic&domain=${encodeURIComponent(domain)}&key=${encodeURIComponent(creds.apiKey)}&export_columns=Ph,Po,Nq,Cp&database=us`;
          const res = await fetch(url);
          if (res.ok) {
            const text = await res.text();
            results.push({ domain, data: text });
          }
        }
        if (results.length > 0) {
          liveDataSection = `\n\nLIVE SEMRUSH DOMAIN ORGANIC DATA per competitor (columns: Ph=keyword, Po=position, Nq=monthly searches, Cp=CPC):\n${JSON.stringify(results, null, 2)}\n\nBase estimatedNewKeywords and keyword intent analysis on this real organic keyword data.`;
          source = "live";
        }
      } catch {
        // fall through to simulation
      }
    }
  }
  // --- End live API ---

  const systemPrompt = [
    "You are a competitive intelligence analyst for SEO and content strategy.",
    "Focus on actionable findings — what should the client DO differently based on competitor moves?",
    "Prioritise insights by strategic importance, not volume of data.",
    "Be specific: name content types, keyword intents, and link source categories.",
    "Return ONLY valid JSON — no markdown fences, no preamble.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ].filter(Boolean).join("\n");

  const trackingScope = [
    trackNewPages ? "new pages and content" : "",
    trackKeywords ? "keyword opportunities" : "",
    trackLinks ? "link-building activity" : "",
  ].filter(Boolean).join(", ");

  const userPrompt = [
    `Produce a competitive intelligence report for these domains: ${domains.join(", ")}`,
    `Tracking scope: ${trackingScope}`,
    `Report format: ${responseFormat}`,
    liveDataSection,
    "",
    "For each competitor, analyse:",
    trackNewPages
      ? "- New or recently updated pages (blog posts, landing pages, product pages, resource pages)"
      : "",
    trackNewPages ? "- Significant content changes or repositioning" : "",
    trackKeywords
      ? "- Keywords they appear to be targeting based on content patterns"
      : "",
    trackLinks
      ? "- Link-building patterns (guest posts, press, directory submissions, partnerships)"
      : "",
    "",
    responseFormat !== "Action Items"
      ? "- Strategic implications for each finding"
      : "",
    responseFormat !== "Analysis"
      ? "- Recommended response actions with priority level"
      : "",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      reportDate: new Date().toISOString().split("T")[0],
      competitors: [
        {
          domain: "competitor.com",
          newPages: [
            {
              url: "https://competitor.com/new-page",
              title: "Page title",
              estimatedTopic: "Main topic of the page",
              contentType: "blog post | landing page | resource | product page",
            },
          ],
          contentChanges: [
            {
              url: "https://competitor.com/existing-page",
              changeType: "Type of change (expanded, rewritten, new section added)",
              implication: "What this signals about their strategy",
            },
          ],
          estimatedNewKeywords: [
            {
              keyword: "target keyword phrase",
              intent: "informational | navigational | commercial | transactional",
              difficulty: "low | medium | high",
            },
          ],
          linkActivity: [
            {
              source: "Source domain or type",
              type: "guest post | press mention | directory | partnership",
              significance: "Why this link matters strategically",
            },
          ],
        },
      ],
      strategicInsights: [
        {
          competitor: "competitor.com",
          finding: "Specific strategic finding...",
          recommendedResponse: "Concrete action the client should take...",
          priority: "high",
        },
      ],
      simulationNote:
        "Connect Ahrefs or Semrush in Settings to pull real competitor data. This report uses AI analysis of your competitor profile.",
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

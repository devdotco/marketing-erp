import type { AgentHandler } from "./index";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { resolveInputs } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { bareDomain, fetchAhrefsOrganicKeywords, fetchSearchAtlasKeywordGap, fetchSemrushDomainOrganic, resolveSeoLiveData } from "./seo-data-providers";

export const competitorWatchHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);

  const config = resolveInputs(run);
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
    .map(bareDomain)
    .filter(Boolean)
    .slice(0, 3);

  // --- Live API: Ahrefs → Semrush → SearchAtlas ---
  const primaryDomain = bareDomain(businessProfile?.websiteUrl ?? "");
  let liveDataSection = "";
  const liveResult = domains.length === 0
    ? ({ source: "simulation" } as const)
    : await resolveSeoLiveData(
        run.agentConfig.workspaceId,
        (data, provider) =>
          provider === "AHREFS"
            ? `\n\nLIVE AHREFS KEYWORD DATA per competitor:\n${JSON.stringify(data, null, 2)}\n\nUse this real keyword data to identify what each competitor is actually ranking for. Base estimatedNewKeywords on this data.`
            : provider === "SEMRUSH"
              ? `\n\nLIVE SEMRUSH DOMAIN ORGANIC DATA per competitor (columns: Ph=keyword, Po=position, Nq=monthly searches, Cp=CPC):\n${JSON.stringify(data, null, 2)}\n\nBase estimatedNewKeywords and keyword intent analysis on this real organic keyword data.`
              : `\n\nLIVE SEARCHATLAS KEYWORD GAP DATA — keywords these competitors rank for that ${primaryDomain} does not:\n${JSON.stringify(data, null, 2)}\n\nBase estimatedNewKeywords directly on this real content-gap data; these are keywords the client is provably missing, not estimates.`,
        {
          ahrefs: async (apiKey) =>
            Promise.all(domains.map(async (domain) => ({ domain, data: await fetchAhrefsOrganicKeywords(apiKey, domain) }))),
          semrush: async (apiKey) =>
            Promise.all(domains.map(async (domain) => ({ domain, data: await fetchSemrushDomainOrganic(apiKey, domain) })))
              .then((r) => JSON.stringify(r)),
          searchAtlas: primaryDomain
            ? (apiKey) => fetchSearchAtlasKeywordGap(apiKey, primaryDomain, domains)
            : undefined,
        },
      );
  const source = liveResult.source;
  if (liveResult.source === "live") liveDataSection = liveResult.section;
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
        "Connect Ahrefs, Semrush, or SearchAtlas in Settings to pull real competitor data. This report uses AI analysis of your competitor profile.",
    }),
  ].filter(Boolean).join("\n");

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
  // Priced from lib/ai/models.ts — Haiku 4.5 is $1/M input, $5/M output.
  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};

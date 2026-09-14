import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { googleCredentials, liveCallFailed } from "@/lib/integrations/google";
import { resolvePropertyOverride } from "@/lib/integrations/google-resources";
import { AgentInputError } from "@/lib/ai/errors";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { resolveInputs } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export const aiSearchVisibilityHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);

  const config = resolveInputs(run);
  const testQueries = String(config.testQueries ?? "");
  const competitors = String(config.competitors ?? "");
  const generateLlmsTxt = config.generateLlmsTxt !== false;
  const reportFormat = String(config.reportFormat ?? "Dashboard");
  const siteUrl = String(config.siteUrl ?? "");

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business: ${businessProfile.businessName}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.targetAudience ? `Target audience: ${businessProfile.targetAudience}` : "",
        businessProfile.uniqueValueProp ? `Unique value: ${businessProfile.uniqueValueProp}` : "",
        businessProfile.websiteUrl ? `Website: ${siteUrl || businessProfile.websiteUrl}` : "",
        businessProfile.competitors.length > 0
          ? `Known competitors: ${competitors || businessProfile.competitors.join(", ")}`
          : competitors
            ? `Competitors to track: ${competitors}`
            : "",
      ].filter(Boolean).join("\n")
    : "";

  const resolvedSiteUrl = siteUrl || businessProfile?.websiteUrl || "";

  // --- Live GSC branded query fetch ---
  let gscBrandedContext = "";
  let isLive = false;

  const integration = await prisma.integration.findUnique({
    where: {
      workspaceId_provider: {
        workspaceId: run.agentConfig.workspaceId,
        provider: "GOOGLE_SEARCH_CONSOLE",
      },
    },
  });

  // Not connected → simulating below is fine. Connected but the call fails →
  // fail the run rather than quietly ship simulated data as "live".
  if (integration) {
    try {
      // Refreshes the hour-long access token first.
      const creds = await googleCredentials(integration);

      // Only the explicit "siteUrl" dropdown value is validated against the
      // grant here — resolvedSiteUrl's Business Profile fallback is not
      // something the user chose, so it's used only if nothing else resolves.
      const propertyUrl = (await resolvePropertyOverride("GOOGLE_SEARCH_CONSOLE", creds, siteUrl)) || resolvedSiteUrl;
      if (!propertyUrl) {
        throw new AgentInputError(
          "Google Search Console is connected, but no property has been selected.",
          "Open Integrations → Google Search Console and choose a property.",
          "integration_not_configured",
        );
      }
      const encodedUrl = encodeURIComponent(propertyUrl);
      const apiBase = `https://www.googleapis.com/webmasters/v3/sites/${encodedUrl}/searchAnalytics/query`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${creds.access_token}`,
        "Content-Type": "application/json",
      };

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
          dimensions: ["query"],
          rowLimit: 25000,
        }),
      });
      if (!res.ok) {
        throw new Error(`Search Console API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }

      const data = (await res.json()) as GscResponse;
      const rows = data.rows ?? [];

      // Build brand name tokens for matching (business name + domain parts)
      const brandTokens: string[] = [];
      if (businessProfile?.businessName) {
        // Break the name into words, filter short words
        brandTokens.push(
          ...businessProfile.businessName
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length > 3)
        );
      }
      if (resolvedSiteUrl) {
        // Extract domain without TLD
        const domainMatch = resolvedSiteUrl.match(/(?:https?:\/\/)?(?:www\.)?([^./]+)/);
        if (domainMatch?.[1]) brandTokens.push(domainMatch[1].toLowerCase());
      }

      // Separate branded vs non-branded queries
      const isBranded = (query: string): boolean => {
        if (brandTokens.length === 0) return false;
        const q = query.toLowerCase();
        return brandTokens.some((t) => q.includes(t));
      };

      const brandedRows = rows
        .filter((r) => isBranded(r.keys[0]))
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 200);

      const nonBrandedHighImpression = rows
        .filter((r) => !isBranded(r.keys[0]))
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 100);

      const totalBrandedImpressions = brandedRows.reduce((s, r) => s + r.impressions, 0);
      const totalBrandedClicks = brandedRows.reduce((s, r) => s + r.clicks, 0);
      const avgBrandedPosition =
        brandedRows.length > 0
          ? brandedRows.reduce((s, r) => s + r.position, 0) / brandedRows.length
          : 0;

      const totalNonBrandedImpressions = nonBrandedHighImpression.reduce((s, r) => s + r.impressions, 0);
      const totalNonBrandedClicks = nonBrandedHighImpression.reduce((s, r) => s + r.clicks, 0);

      gscBrandedContext = `REAL GSC BRANDED + QUERY DATA (last 90 days, ${formatDate(ninetyDaysAgo)} to ${formatDate(yesterday)}):
Property: ${propertyUrl}
Total queries with data: ${rows.length}
Brand tokens used for matching: ${brandTokens.join(", ") || "none (no business name configured)"}

BRANDED QUERIES (${brandedRows.length} matched):
- Total branded impressions: ${totalBrandedImpressions}
- Total branded clicks: ${totalBrandedClicks}
- Avg branded position: ${avgBrandedPosition.toFixed(2)}
Top branded queries:
${JSON.stringify(brandedRows.map((r) => ({ query: r.keys[0], impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, position: r.position })), null, 2)}

TOP NON-BRANDED HIGH-IMPRESSION QUERIES (relevant for AI citation gap analysis):
- Total impressions: ${totalNonBrandedImpressions}
- Total clicks: ${totalNonBrandedClicks}
Top queries:
${JSON.stringify(nonBrandedHighImpression.map((r) => ({ query: r.keys[0], impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, position: r.position })), null, 2)}`;

      isLive = true;
    } catch (err) {
      if (err instanceof AgentInputError) throw err;
      throw liveCallFailed("Google Search Console", err instanceof Error ? err.message : String(err));
    }
  }

  const systemPrompt = [
    "You are an AI search visibility specialist.",
    "Citation in LLM responses depends on: topical authority, schema markup, brand mention frequency, and content that directly answers user questions.",
    "Focus recommendations on these levers — not vanity metrics.",
    "Be specific about which content gaps or authority gaps explain low citation probability.",
    "Return ONLY valid JSON — no markdown fences, no preamble.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ].filter(Boolean).join("\n");

  const queries = testQueries
    .split(/[\n,]+/)
    .map((q) => q.trim())
    .filter(Boolean);

  const competitorList = competitors
    .split(/[\n,]+/)
    .map((c) => c.trim())
    .filter(Boolean);

  const userPrompt = [
    `Analyse AI search visibility for: ${resolvedSiteUrl || "the client website"}`,
    "",
    `Test queries (${queries.length}):`,
    queries.map((q, i) => `${i + 1}. ${q}`).join("\n"),
    "",
    competitorList.length > 0
      ? `Competing domains to track in AI citations: ${competitorList.join(", ")}`
      : "",
    "",
    isLive
      ? `REAL GSC DATA to inform your analysis:
${gscBrandedContext}

Use this real data to:
- Assess brand authority strength from actual branded query volume and position
- Identify topical gaps where non-branded high-impression queries have poor CTR (position > 10) — these are areas where AI engines likely cite competitors instead
- Reference actual query volumes when explaining citation probability
`
      : "",
    "For each test query, simulate how each major AI engine would likely respond:",
    "- Would the client's site be cited?",
    "- If yes, at what position?",
    "- Which competitors would more likely be cited, and why?",
    "- What specific changes would increase citation probability?",
    "",
    "Scoring: citationSharePct = percentage of AI engines that would cite the client for this query (0-100)",
    "overallCitationShare = average across all queries",
    "",
    generateLlmsTxt
      ? `Generate an llms.txt file for ${resolvedSiteUrl || "the client site"} following the llms.txt spec (machine-readable site summary for AI crawlers).`
      : "Set llmsTxt to null.",
    "",
    `Report format requested: ${reportFormat}`,
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      siteUrl: resolvedSiteUrl,
      testDate: new Date().toISOString().split("T")[0],
      source: isLive ? "live" : "simulation",
      gscSummary: isLive
        ? {
            note: "Populated from real GSC data — see gscBrandedData field",
          }
        : null,
      queryResults: [
        {
          query: "example test query",
          aiEngines: [
            {
              engine: "ChatGPT",
              wasCited: false,
              citationPosition: null,
              competitorsCited: ["competitor.com"],
              responseExcerpt:
                "Summary of how this AI engine would answer the query and who it would cite...",
            },
            {
              engine: "Perplexity",
              wasCited: true,
              citationPosition: 2,
              competitorsCited: ["competitor.com"],
              responseExcerpt: "Summary of Perplexity's likely response...",
            },
            {
              engine: "Gemini",
              wasCited: false,
              citationPosition: null,
              competitorsCited: ["competitor.com"],
              responseExcerpt: "Summary of Gemini's likely response...",
            },
            {
              engine: "Claude",
              wasCited: false,
              citationPosition: null,
              competitorsCited: ["competitor.com"],
              responseExcerpt: "Summary of Claude's likely response...",
            },
          ],
          citationSharePct: 25,
          recommendation:
            "Specific action to improve citation probability for this query...",
        },
      ],
      overallCitationShare: 25,
      llmsTxt: generateLlmsTxt
        ? `# ${businessProfile?.businessName ?? "Site Name"}\n\n> One-line site description\n\n## About\n...\n\n## Key Pages\n...\n\n## Products/Services\n...`
        : null,
      improvementOpportunities: [
        {
          area: "Topical Authority | Schema Markup | Brand Mentions | Content Gaps",
          action: "Specific action to take...",
          expectedImpact: "Expected improvement in citation probability...",
        },
      ],
      simulationNote: isLive
        ? null
        : "These are AI-simulated citation predictions. Real citation testing requires querying each AI engine directly.",
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
  output.source = isLive ? "live" : "simulation";
  // Priced from lib/ai/models.ts — Haiku 4.5 is $1/M input, $5/M output.
  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};

import type { AgentHandler } from "./index";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { lines, num, resolveInputs, str } from "@/lib/agents/inputs";
import { googleCredentials, liveCallFailed } from "@/lib/integrations/google";
import { resolvePropertyOverride } from "@/lib/integrations/google-resources";
import { AgentInputError } from "@/lib/ai/errors";
import { applyRenamedInputs } from "./renamed-inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { bareDomain, fetchAhrefsOrganicKeywords, fetchSearchAtlasTopicalMap, fetchSemrushDomainOrganic, resolveSeoLiveData } from "./seo-data-providers";
import { completeMessage } from "@/lib/ai/messages";
import { jsonFrom } from "@/lib/ai/extract";
import { addReview } from "@/lib/agents/integrity";
import { withProvenance, type EvidenceRecord } from "@/lib/agents/provenance";
import { allowedFormats, checkTopicPlan, toCsv, weekStartDates, type NearRankRow } from "@/lib/agents/topic-plan";

export const topicPlannerHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  // Renamed to the Run form's keys on 2026-09-14; the old names still work from a saved config
  // (a saved calendarPeriod like "4 weeks" coerces to 4).
  applyRenamedInputs(run, config, { competitorDomains: "competitorUrls", planningHorizonWeeks: "calendarPeriod" });

  const planningHorizonWeeks = num(config, "planningHorizonWeeks", 4, { min: 1, max: 12 });
  const postsPerWeek = num(config, "postsPerWeek", 2, { min: 1, max: 7 });
  // Derived from the two form fields rather than asked for separately.
  const numberOfTopics = planningHorizonWeeks * postsPerWeek;
  const calendarPeriod = `${planningHorizonWeeks} week${planningHorizonWeeks === 1 ? "" : "s"}`;
  const competitorUrls = str(config, "competitorDomains");
  const focusKeywords = str(config, "focusKeywords");
  const seoTool = str(config, "seoTool", "Auto");
  const contentFormats = str(config, "contentFormats", "Blog posts only");
  const excludedTopics = lines(config, "excludedTopics", 50);
  const gscProperty = str(config, "gscProperty");

  const businessProfile = await prisma.businessProfile.findFirst({ where: { workspaceId: run.agentConfig.workspaceId } });
  const siteUrl = str(config, "siteUrl") || businessProfile?.websiteUrl || "";
  const targetAudience = businessProfile?.targetAudience || "marketing professionals";

  // --- Live API: Ahrefs → Semrush ---
  // Pull keyword data for competitor URLs to ground content gap analysis in real data
  let liveDataSection = "";
  const competitorDomains = competitorUrls
    .split(/[\n,]+/)
    .map(bareDomain)
    .filter(Boolean)
    .slice(0, 3);

  // What was actually read — the output's dataSources and provenance are built from
  // these, never from the model, so they can't claim a source that wasn't called.
  let nearRankRows: NearRankRow[] | undefined;
  let gscLabel: string | undefined;
  let seoToolLabel: string | undefined;

  const liveResult = competitorDomains.length === 0 || seoTool === "None"
    ? ({ source: "simulation" } as const)
    : await resolveSeoLiveData(
        run.agentConfig.workspaceId,
        (data, provider) =>
          provider === "AHREFS"
            ? `\n\nLIVE AHREFS COMPETITOR KEYWORD DATA:\n${JSON.stringify(data, null, 2)}\n\nUse this real data to:\n- Identify topics competitors dominate (topicsTheyDominateWeAreWeak)\n- Find keyword gaps they have missed (topicsTheyMissedThatWeCanWin)\n- Set realistic keywordDifficulty and volumeBracket values based on actual Ahrefs metrics`
            : `\n\nLIVE SEMRUSH COMPETITOR ORGANIC DATA (columns: Ph=keyword, Po=position, Nq=monthly searches, Cp=CPC):\n${JSON.stringify(data, null, 2)}\n\nUse this real data to:\n- Identify topics competitors dominate (topicsTheyDominateWeAreWeak)\n- Find keyword gaps they have missed (topicsTheyMissedThatWeCanWin)\n- Set realistic keywordDifficulty and volumeBracket values based on actual Semrush metrics`,
        {
          // "Auto" tries Ahrefs, then Semrush — whichever is connected. A named tool uses only that one.
          ...(seoTool !== "Semrush"
            ? {
                ahrefs: async (apiKey: string) =>
                  Promise.all(competitorDomains.map(async (domain) => ({ domain, keywords: await fetchAhrefsOrganicKeywords(apiKey, domain) }))),
              }
            : {}),
          ...(seoTool !== "Ahrefs"
            ? {
                semrush: async (apiKey: string) =>
                  Promise.all(competitorDomains.map(async (domain) => ({ domain, data: await fetchSemrushDomainOrganic(apiKey, domain) })))
                    .then((r) => JSON.stringify(r)),
              }
            : {}),
        },
      );
  let source = liveResult.source;
  if (liveResult.source === "live") {
    liveDataSection = liveResult.section;
    seoToolLabel = liveResult.provider === "AHREFS" ? "Ahrefs" : liveResult.provider === "SEMRUSH" ? "Semrush" : "SearchAtlas";
  }
  // --- End live API ---

  // --- Live GSC: near-rank queries ---
  // Not connected → the plan is built without them. Connected with no property
  // chosen anywhere → skipped with a note (this agent never read GSC before, so
  // an unconfigured grant shouldn't start failing runs). Connected and the call
  // fails → fail the run rather than pass estimates off as Search Console data.
  let gscNote: string | undefined;
  const gscIntegration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "GOOGLE_SEARCH_CONSOLE" } },
  });
  if (gscIntegration) {
    try {
      const creds = await googleCredentials(gscIntegration);
      const propertyUrl = await resolvePropertyOverride("GOOGLE_SEARCH_CONSOLE", creds, gscProperty);
      if (!propertyUrl) {
        gscNote = "Google Search Console is connected but no property is selected, so near-rank queries weren't used. Choose one under Integrations → Google Search Console, or pick a GSC Property on this agent.";
      } else {
        const end = new Date();
        end.setDate(end.getDate() - 1);
        const start = new Date(end);
        start.setDate(end.getDate() - 89);
        const res = await fetch(
          `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(propertyUrl)}/searchAnalytics/query`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${creds.access_token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              startDate: start.toISOString().slice(0, 10),
              endDate: end.toISOString().slice(0, 10),
              dimensions: ["query", "page"],
              rowLimit: 5000,
            }),
          },
        );
        if (!res.ok) throw new Error(`Search Console API ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const data = (await res.json()) as { rows?: Array<{ keys: string[]; clicks: number; impressions: number; position: number }> };
        const nearRank: NearRankRow[] = (data.rows ?? [])
          .filter((r) => r.position >= 4 && r.position <= 20 && r.impressions >= 10)
          .sort((a, b) => b.impressions - a.impressions)
          .slice(0, 60)
          .map((r) => ({
            query: r.keys[0],
            page: r.keys[1],
            position: Math.round(r.position * 10) / 10,
            impressions: r.impressions,
            clicks: r.clicks,
          }));
        nearRankRows = nearRank;
        gscLabel = `Google Search Console (${propertyUrl}, 90 days)`;
        liveDataSection += `\n\nLIVE GOOGLE SEARCH CONSOLE NEAR-RANK QUERIES for ${propertyUrl} (last 90 days, average position 4–20):\n${JSON.stringify(nearRank, null, 2)}\n\nThese queries already rank close to the top of page one or just off it. Prefer topics that would win them (a dedicated piece, or a refresh of the ranking page), and weight winnability accordingly. For a refresh or consolidate topic, existingUrl must be copied verbatim from the "page" field of a row above.`;
        source = "live";
      }
    } catch (err) {
      if (err instanceof AgentInputError) throw err;
      throw liveCallFailed("Google Search Console", err instanceof Error ? err.message : String(err));
    }
  }
  // --- End live GSC ---

  // --- Live API: SearchAtlas topic ideas ---
  // Separate from the competitor-gap call above — SearchAtlas's Topical
  // Authority Map takes a seed topic, not a competitor domain, and returns
  // clustered keyword + article-title suggestions, which is a genuinely
  // different (and better-fitting) input for topic ideation than the
  // organic-keyword pulls above.
  const contentTopic =
    focusKeywords.split(/[\n,]+/)[0]?.trim()
    || businessProfile?.industry
    || targetAudience
    || "content marketing";
  const topicIdeasResult = await resolveSeoLiveData(
    run.agentConfig.workspaceId,
    (data) =>
      `\n\nLIVE SEARCHATLAS TOPICAL AUTHORITY MAP for "${contentTopic}":\n${JSON.stringify(data, null, 2)}\n\nUse these real keyword clusters and article title suggestions as the backbone of the weekly calendar topics — prefer them over invented titles.`,
    { searchAtlas: (apiKey) => fetchSearchAtlasTopicalMap(apiKey, contentTopic) },
  );
  if (topicIdeasResult.source === "live") {
    liveDataSection += topicIdeasResult.section;
    source = "live";
    const atlas = "SearchAtlas";
    if (!seoToolLabel) seoToolLabel = atlas;
    else if (seoToolLabel !== atlas) seoToolLabel += ` + ${atlas}`;
  }
  // --- End live API ---

  const today = new Date();
  const currentYear = today.getUTCFullYear();
  const weekStarts = weekStartDates(today, planningHorizonWeeks);
  const formats = allowedFormats(contentFormats);
  const seoToolRead = Boolean(seoToolLabel);

  const systemPrompt = `You are a senior content strategist and SEO specialist who builds data-driven content calendars. You analyze competitor content gaps, near-ranking keyword opportunities, and audience search intent to surface the highest-impact topics. You score every topic by "winnability" — a composite of estimated search volume, keyword difficulty, business relevance, topical authority, and time-to-rank estimate. You think in clusters, not individual posts. Always return valid, minified JSON with no markdown fences.`;

  const userPrompt = `Build a ${calendarPeriod} rolling content calendar with exactly ${numberOfTopics} topics.

Business context:
- Company: ${businessProfile?.businessName ?? "Unknown Company"}
- Industry: ${businessProfile?.industry ?? "General Business"}
- Description: ${businessProfile?.uniqueValueProp ?? "No description provided"}
- Website: ${siteUrl || "Not specified"}

Target audience: ${targetAudience || "Marketing and growth professionals"}

Focus keywords (seed list):
${focusKeywords || "Infer best keywords from business context and industry"}

Competitor URLs to analyze for content gaps:
${competitorUrls || "Infer typical competitors from the industry"}
${liveDataSection}
Calendar period: ${calendarPeriod} (${postsPerWeek} post${postsPerWeek === 1 ? "" : "s"} per week)

Content formats allowed: every topic's contentFormat must be exactly one of: ${formats.join(", ")}. A case study is about one named customer engagement; a benchmark report needs original data; pick the format the title actually describes.
Weeks start on: ${weekStarts.map((d, i) => `week ${i + 1} = ${d}`).join(", ")}.
${excludedTopics.length > 0 ? `\nExcluded topics and keywords — never include a topic built on any of these, regardless of score:\n${excludedTopics.join("\n")}\n` : ""}
Instructions:
- Group topics by week with a weekly theme tying each week together, ${postsPerWeek} topic${postsPerWeek === 1 ? "" : "s"} per week
- For each topic include: primary keyword, up to 4 LSI keywords, search intent, monthly search volume bracket, competition level, winnability score (1-100), content format, recommended word count, publish week, and a strategic rationale
- Identify quick wins (winnability >= 75) and long-game topics (high volume, higher competition)
- Provide competitor gap insights based on the competitor URLs
- Titles: never put a year in a title unless it is ${currentYear} or later
- Every topic has an action: "new", "refresh" or "consolidate". existingUrl is null for new; for refresh or consolidate it must be a page URL copied verbatim from the Search Console rows above. Consolidate also needs mergeUrls (the pages to merge and 301). Never fold several city or location pages into one post whose primary keyword names only one of them.
- projectedMonthlyClicks is a whole number per topic. projectionBasis is "GSC: <n> impressions at position <p>" when the topic targets a near-rank Search Console query (use that row's numbers), otherwise "estimate".
${seoToolRead ? "- keywordDifficulty and estimatedMonthlyTraffic must come from the live SEO data above; use null where it has no figure" : "- No live SEO-tool data was read: set keywordDifficulty and every estimatedMonthlyTraffic to null. Never estimate them."}
- requires lists assets or data that must be built or sourced before publishing (a calculator, a dataset, customer permission); empty if none. A benchmark report needs data the business may not have, so list it. callToAction may only point at the business's normal conversion (contact or consultation) unless the asset is in requires, and must read as the business pitching itself, not a directory ("find an expert near you").
- Winnability: weight business relevance to the Business Profile (description and industry) explicitly; a topic off the business's offer scores low however big its volume. Keep volumeBracket consistent with GSC impressions when a row exists. Zero clicks at position ~8 points to a title/snippet or intent mismatch, not untapped traffic: say which in the rationale.
- Output size: minified JSON, at most 4 lsiKeywords, rationale at most 2 sentences. quickWins, longGameTopics, prioritizationMatrix and the cluster ids are topic ids only, not copies of topics.

Return this exact JSON structure (no markdown, no code fences):
{
  "calendarOverview": {
    "period": "${calendarPeriod}",
    "totalTopics": ${numberOfTopics},
    "averageWinnabilityScore": 0,
    "dominantIntent": "",
    "contentMix": {
      "pillarPages": 0,
      "clusterPosts": 0,
      "listicles": 0,
      "comparisons": 0,
      "tutorials": 0,
      "caseStudies": 0
    },
    "topKeywordThemes": []
  },
  "competitorGapInsights": [
    {
      "competitorUrl": "",
      "estimatedMonthlyTraffic": null,
      "topicsTheyDominateWeAreWeak": [],
      "topicsTheyMissedThatWeCanWin": [],
      "overallGapScore": 0
    }
  ],
  "weeklyCalendar": [
    {
      "week": 1,
      "weekStarting": "",
      "weekLabel": "",
      "weekTheme": "",
      "strategicFocus": "",
      "topics": [
        {
          "id": "",
          "title": "",
          "primaryKeyword": "",
          "lsiKeywords": [],
          "intent": "",
          "volumeBracket": "",
          "competition": "",
          "action": "new",
          "existingUrl": null,
          "mergeUrls": [],
          "keywordDifficulty": null,
          "winnabilityScore": 0,
          "contentFormat": "",
          "recommendedWordCount": 0,
          "internalLinkingOpportunities": [],
          "publishWeek": 0,
          "estimatedTimeToRankDays": 0,
          "rationale": "",
          "projectedMonthlyClicks": 0,
          "projectionBasis": "",
          "requires": [],
          "callToAction": ""
        }
      ]
    }
  ],
  "quickWins": [],
  "longGameTopics": [],
  "topicClusters": [
    {
      "clusterName": "",
      "pillarTopicId": "",
      "supportingTopicIds": [],
      "estimatedClusterAuthority": 0
    }
  ],
  "prioritizationMatrix": {
    "doFirst": [],
    "doSoon": [],
    "doPlan": [],
    "doLater": []
  }
}`;

  const message = await completeMessage(client, {
    model: MODELS.standard,
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = textFrom(message);
  const parsed = jsonFrom(rawText);
  const output: Record<string, unknown> = parsed ?? { result: rawText };

  // Only a parsed plan is checked; the platform gate catches the raw-text fallback.
  if (parsed) {
    const warnings = checkTopicPlan(output, {
      gscPages: (nearRankRows ?? []).map((r) => r.page),
      seoToolRead,
      formats,
      currentYear,
      weekStarts,
    });
    if (warnings.length) addReview(output, { warnings });
    // Built here, not by the model, so it can't list a source that wasn't read.
    output.dataSources = [gscLabel, seoToolLabel].filter(Boolean);
  }
  if (nearRankRows) {
    output.nearRankOpportunities = nearRankRows;
    output.nearRankCsv = toCsv(nearRankRows);
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;
  output.source = source;
  if (gscNote) output.gscNote = gscNote;
  if (source === "live") {
    delete output.simulationNote;
  } else {
    output.simulationNote =
      "Connect Google Search Console in Settings to pull real near-ranking queries, impressions, and CTR data. Connect Ahrefs or Semrush to get live keyword difficulty and volume instead of estimates, or SearchAtlas for real AI-generated topic ideas and clustered keywords instead of invented ones.";
  }

  const evidence: EvidenceRecord[] = [];
  if (gscLabel) evidence.push({ source: "GSC", detail: gscLabel, rows: nearRankRows?.length });
  if (seoToolLabel) evidence.push({ source: "SEO_API", detail: seoToolLabel });
  withProvenance(output, "topic-planner", evidence);

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  return { output, costUsd };
};

import type { AgentHandler } from "./index";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { resolveInputs } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { bareDomain, fetchAhrefsOrganicKeywords, fetchSearchAtlasTopicalMap, fetchSemrushDomainOrganic, resolveSeoLiveData } from "./seo-data-providers";

export const topicPlannerHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  const numberOfTopics = typeof config.numberOfTopics === "number" ? config.numberOfTopics : 20;
  const targetAudience = typeof config.targetAudience === "string" ? config.targetAudience : "marketing professionals";
  const competitorUrls = typeof config.competitorUrls === "string" ? config.competitorUrls : "";
  const focusKeywords = typeof config.focusKeywords === "string" ? config.focusKeywords : "";
  const calendarPeriod = typeof config.calendarPeriod === "string" ? config.calendarPeriod : "4 weeks";

  const businessProfile = await prisma.businessProfile.findFirst({ where: { workspaceId: run.agentConfig.workspaceId } });

  // --- Live API: Ahrefs → Semrush ---
  // Pull keyword data for competitor URLs to ground content gap analysis in real data
  let liveDataSection = "";
  const competitorDomains = competitorUrls
    .split(/[\n,]+/)
    .map(bareDomain)
    .filter(Boolean)
    .slice(0, 3);

  const liveResult = competitorDomains.length === 0
    ? ({ source: "simulation" } as const)
    : await resolveSeoLiveData(
        run.agentConfig.workspaceId,
        (data, provider) =>
          provider === "AHREFS"
            ? `\n\nLIVE AHREFS COMPETITOR KEYWORD DATA:\n${JSON.stringify(data, null, 2)}\n\nUse this real data to:\n- Identify topics competitors dominate (topicsTheyDominateWeAreWeak)\n- Find keyword gaps they have missed (topicsTheyMissedThatWeCanWin)\n- Set realistic keywordDifficulty and volumeBracket values based on actual Ahrefs metrics`
            : `\n\nLIVE SEMRUSH COMPETITOR ORGANIC DATA (columns: Ph=keyword, Po=position, Nq=monthly searches, Cp=CPC):\n${JSON.stringify(data, null, 2)}\n\nUse this real data to:\n- Identify topics competitors dominate (topicsTheyDominateWeAreWeak)\n- Find keyword gaps they have missed (topicsTheyMissedThatWeCanWin)\n- Set realistic keywordDifficulty and volumeBracket values based on actual Semrush metrics`,
        {
          ahrefs: async (apiKey) =>
            Promise.all(competitorDomains.map(async (domain) => ({ domain, keywords: await fetchAhrefsOrganicKeywords(apiKey, domain) }))),
          semrush: async (apiKey) =>
            Promise.all(competitorDomains.map(async (domain) => ({ domain, data: await fetchSemrushDomainOrganic(apiKey, domain) })))
              .then((r) => JSON.stringify(r)),
        },
      );
  let source = liveResult.source;
  if (liveResult.source === "live") liveDataSection = liveResult.section;
  // --- End live API ---

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
  }
  // --- End live API ---

  const systemPrompt = `You are a senior content strategist and SEO specialist who builds data-driven content calendars. You analyze competitor content gaps, near-ranking keyword opportunities, and audience search intent to surface the highest-impact topics. You score every topic by "winnability" — a composite of estimated search volume, keyword difficulty, business relevance, topical authority, and time-to-rank estimate. You think in clusters, not individual posts. Always return valid, minified JSON with no markdown fences.`;

  const userPrompt = `Build a ${calendarPeriod} rolling content calendar with exactly ${numberOfTopics} topics.

Business context:
- Company: ${businessProfile?.businessName ?? "Unknown Company"}
- Industry: ${businessProfile?.industry ?? "General Business"}
- Description: ${businessProfile?.uniqueValueProp ?? "No description provided"}
- Website: ${businessProfile?.websiteUrl ?? "Not specified"}

Target audience: ${targetAudience || "Marketing and growth professionals"}

Focus keywords (seed list):
${focusKeywords || "Infer best keywords from business context and industry"}

Competitor URLs to analyze for content gaps:
${competitorUrls || "Infer typical competitors from the industry"}
${liveDataSection}
Calendar period: ${calendarPeriod}

Instructions:
- Group topics by week with a weekly theme tying each week together
- For each topic include: primary keyword, 3-5 LSI keywords, search intent, monthly search volume bracket, competition level, winnability score (1-100), content format, recommended word count, publish week, and a 1-2 sentence strategic rationale
- Identify quick wins (winnability >= 75) and long-game topics (high volume, higher competition)
- Provide competitor gap insights based on the competitor URLs

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
    "estimatedOrganicLiftPercent": 0,
    "topKeywordThemes": []
  },
  "competitorGapInsights": [
    {
      "competitorUrl": "",
      "estimatedMonthlyTraffic": "",
      "topicsTheyDominateWeAreWeak": [],
      "topicsTheyMissedThatWeCanWin": [],
      "overallGapScore": 0
    }
  ],
  "weeklyCalendar": [
    {
      "week": 1,
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
          "keywordDifficulty": 0,
          "winnabilityScore": 0,
          "contentFormat": "",
          "recommendedWordCount": 0,
          "internalLinkingOpportunities": [],
          "publishWeek": 0,
          "estimatedTimeToRankDays": 0,
          "rationale": "",
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

  const message = await client.messages.create({
    model: MODELS.standard,
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = textFrom(message);
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let output: Record<string, unknown>;
  try {
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { result: rawText };
  } catch {
    output = { result: rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;
  output.source = source;
  if (source === "live") {
    delete output.simulationNote;
  } else {
    output.simulationNote =
      "Connect Google Search Console in Settings to pull real near-ranking queries, impressions, and CTR data. Connect Ahrefs or Semrush to get live keyword difficulty and volume instead of estimates, or SearchAtlas for real AI-generated topic ideas and clustered keywords instead of invented ones.";
  }

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  return { output, costUsd };
};

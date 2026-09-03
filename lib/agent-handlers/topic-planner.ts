import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const topicPlannerHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const numberOfTopics = typeof config.numberOfTopics === "number" ? config.numberOfTopics : 20;
  const targetAudience = typeof config.targetAudience === "string" ? config.targetAudience : "marketing professionals";
  const competitorUrls = typeof config.competitorUrls === "string" ? config.competitorUrls : "";
  const focusKeywords = typeof config.focusKeywords === "string" ? config.focusKeywords : "";
  const calendarPeriod = typeof config.calendarPeriod === "string" ? config.calendarPeriod : "4 weeks";

  const businessProfile = await prisma.businessProfile.findFirst({ where: { workspaceId: run.agentConfig.workspaceId } });

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
  output.simulationNote =
    "Connect Google Search Console in Settings to pull real near-ranking queries, impressions, and CTR data. Connect Ahrefs or Semrush to get live keyword difficulty and volume instead of estimates.";

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return { output, costUsd };
};

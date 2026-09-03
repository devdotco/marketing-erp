import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const leadEnrichmentHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const leadEmail = (config.leadEmail as string) ?? "";
  const leadName = (config.leadName as string) ?? "";
  const leadCompany = (config.leadCompany as string) ?? "";
  const icpCriteria = (config.icpCriteria as string) ?? "";
  const flagHighPriority = (config.flagHighPriority as boolean) ?? true;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const systemPrompt = `You are an expert B2B lead intelligence analyst. Given minimal lead information, you produce rich enrichment profiles including company firmographics, likely tech stack, role inference, ICP fit scoring, and prioritisation signals. Your output powers sales teams to personalise outreach and route leads efficiently. Always respond with valid JSON only — no markdown fences, no text outside the JSON object.`;

  const userPrompt = `Enrich the following inbound lead and score their ICP fit.

Lead Information Provided:
- Email: ${leadEmail}
- Name: ${leadName || "(not provided)"}
- Company: ${leadCompany || "(infer from email domain)"}

Our Business Context:
- Company: ${businessProfile?.businessName ?? "our company"}
- Industry: ${businessProfile?.industry ?? "SaaS"}
- Target Market: ${businessProfile?.targetAudience ?? "mid-market B2B"}
- Value Proposition: ${businessProfile?.uniqueValueProp ?? "AI-driven marketing automation"}

ICP Criteria (from config):
${icpCriteria || "Company size 50-500 employees, SaaS or tech sector, decision-maker or influencer role, English-speaking market, growth-stage company with marketing budget."}

Flag as High Priority: ${flagHighPriority}

Produce a full enrichment report. Simulate realistic data based on the email domain and company name. Return JSON matching this exact shape:

{
  "lead": {
    "email": "${leadEmail}",
    "name": "<inferred or provided name>",
    "inferredFirstName": "<first name>",
    "inferredLastName": "<last name>",
    "linkedinUrl": "<simulated LinkedIn profile URL>",
    "avatarInitials": "<2-char initials>"
  },
  "role": {
    "inferredTitle": "<most likely job title>",
    "seniority": "C-Suite|VP|Director|Manager|IC|Unknown",
    "department": "<department>",
    "isBuyer": true,
    "isInfluencer": true,
    "isEndUser": false,
    "decisionMakingPower": "high|medium|low",
    "confidenceScore": 0.0
  },
  "company": {
    "name": "<company name>",
    "domain": "<domain>",
    "industry": "<industry>",
    "subIndustry": "<sub-industry>",
    "employeeRange": "<e.g. 51-200>",
    "estimatedEmployees": 0,
    "revenueRange": "<e.g. $10M-$50M>",
    "fundingStage": "<Bootstrap|Seed|Series A|Series B|Series C|Public|Unknown>",
    "totalFundingUsd": 0,
    "foundedYear": 0,
    "hqCountry": "<country>",
    "hqCity": "<city>",
    "websiteUrl": "<url>",
    "linkedinCompanyUrl": "<url>",
    "description": "<1-sentence company description>",
    "growth": {
      "headcountGrowth12m": "<pct>",
      "jobPostingsTrend": "increasing|stable|decreasing",
      "techInvestmentSignals": ["<signal>"]
    }
  },
  "techStack": {
    "confirmed": [
      { "tool": "<tool name>", "category": "<category>", "source": "DNS|Job Posting|Public Data" }
    ],
    "inferred": [
      { "tool": "<tool name>", "category": "<category>", "confidence": "high|medium|low" }
    ],
    "relevantToUs": [
      { "tool": "<competitor or complement>", "implication": "<what this means for our pitch>" }
    ]
  },
  "icpScoring": {
    "overallScore": 0,
    "maxScore": 100,
    "grade": "A|B|C|D",
    "breakdown": [
      { "criterion": "<criterion name>", "weight": 0, "score": 0, "maxScore": 0, "reasoning": "<why>" }
    ],
    "icpTier": "Tier 1|Tier 2|Tier 3|Disqualified",
    "fitSummary": "<2-sentence fit summary>",
    "disqualifiers": ["<disqualifier if any>"]
  },
  "intent": {
    "signals": [
      { "signal": "<intent signal>", "strength": "strong|moderate|weak", "source": "<source>" }
    ],
    "inferredPainPoints": ["<pain point>"],
    "inferredBuyingStage": "Awareness|Consideration|Decision|Unknown",
    "estimatedTimelineToDecision": "<timeframe>"
  },
  "prioritisation": {
    "isHighPriority": ${flagHighPriority},
    "priorityReason": "<reason for priority flag>",
    "recommendedNextAction": "<specific next action for SDR>",
    "suggestedOwner": "AE|SDR|Marketing Nurture|No Action",
    "outreachPersonalisation": {
      "openingHook": "<personalised conversation opener>",
      "valuePropAngle": "<which value prop to lead with>",
      "avoidTopics": ["<topic to avoid>"]
    }
  },
  "enrichmentMeta": {
    "sourcesConsulted": ["<source>"],
    "confidenceLevel": "high|medium|low",
    "lastEnrichedAt": "<ISO timestamp>",
    "enrichmentVersion": "1.0"
  },
  "simulationNote": "Connect Clay, Apollo, or Clearbit in Settings to enable live company data, real tech-stack detection, and verified contact details."
}`;

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
    output = jsonMatch ? JSON.parse(jsonMatch[0]) : { result: rawText };
  } catch {
    output = { result: rawText };
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  return { output, costUsd };
};

import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";

const client = new Anthropic();

export const emailMarketingHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const campaignType = (config.campaignType as string) ?? "Broadcast";
  const segmentCondition = (config.segmentCondition as string) ?? "";
  const numberOfEmails = (config.numberOfEmails as number) ?? 5;
  const espTarget = (config.espTarget as string) ?? "Draft";
  const ctaUrl = (config.ctaUrl as string) ?? "";
  const rewriteUnderperformers = (config.rewriteUnderperformers as boolean) ?? false;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const systemPrompt = `You are an expert email marketing strategist specialising in behavioural segmentation, ESP automation, and revenue-driven copy. You craft multi-email sequences for B2B SaaS companies that balance personalisation with deliverability. You produce detailed, production-ready campaign blueprints. Always respond with valid JSON only — no markdown fences, no commentary outside the JSON object.`;

  const underperformerSection = rewriteUnderperformers
    ? `"underperformerRewritePlan": {
        "openRateThreshold": "<threshold>",
        "clickRateThreshold": "<threshold>",
        "rewriteConditions": [
          { "metric": "open_rate", "operator": "lt", "value": 0.20, "action": "rewrite_subject_and_preview" },
          { "metric": "click_rate", "operator": "lt", "value": 0.03, "action": "rewrite_cta_and_body" }
        ],
        "rewriteStrategy": "<strategy>",
        "autoScheduleRewrite": true
      }`
    : `"underperformerRewritePlan": null`;

  const userPrompt = `Design a complete ${campaignType} email campaign for the following business.

Business Context:
- Name: ${businessProfile?.businessName ?? "the business"}
- Industry: ${businessProfile?.industry ?? "SaaS"}
- Target Audience: ${businessProfile?.targetAudience ?? "B2B decision-makers"}
- Value Proposition: ${businessProfile?.uniqueValueProp ?? "productivity and growth"}
- Brand Voice: ${businessProfile?.brandVoice ?? "Professional yet approachable"}
- Website: ${businessProfile?.websiteUrl ?? ""}

Campaign Configuration:
- Campaign Type: ${campaignType}
- Number of Emails in Sequence: ${numberOfEmails}
- Segment Condition: ${segmentCondition || "All active subscribers"}
- ESP Target: ${espTarget}
- Primary CTA URL: ${ctaUrl || "https://example.com/get-started"}
- Rewrite Underperformers: ${rewriteUnderperformers}

Produce a comprehensive campaign blueprint. Each email must have complete, copy-ready body text (minimum 150 words of HTML body). Return JSON matching this exact shape:

{
  "campaignName": "<descriptive campaign name>",
  "campaignType": "${campaignType}",
  "espTarget": "${espTarget}",
  "summary": "<2-sentence campaign overview>",
  "segmentation": {
    "primaryCondition": "<plain-English description>",
    "estimatedAudienceSize": 0,
    "segments": [
      { "name": "<segment name>", "condition": "<ESP filter logic>", "estimatedSize": 0, "priority": "high|medium|low" }
    ],
    "exclusions": ["<exclusion rule>"]
  },
  "emailSequence": [
    {
      "emailNumber": 1,
      "sendDelay": "<e.g. Immediately / Day 3 / Day 7>",
      "subjectLine": "<subject>",
      "previewText": "<preview>",
      "bodyHtml": "<full HTML email body with personalization tokens>",
      "cta": { "text": "<CTA label>", "url": "<url>", "buttonColor": "#hex" },
      "goal": "<specific conversion goal for this email>",
      "tags": ["<tag>"],
      "abVariants": [
        { "variant": "A", "subjectLine": "<A subject>", "hypothesis": "<what you are testing>" },
        { "variant": "B", "subjectLine": "<B subject>", "hypothesis": "<what you are testing>" }
      ]
    }
  ],
  "automationFlow": {
    "trigger": "<trigger event>",
    "entryCondition": "<entry filter>",
    "branches": [
      {
        "step": 1,
        "condition": "<IF this behaviour>",
        "action": "<THEN do this>",
        "waitPeriod": "<time>",
        "nextStep": "<step description or EXIT>"
      }
    ],
    "exitConditions": ["<exit rule>"],
    "goalTracking": { "primaryGoal": "<goal>", "kpiEvents": ["<event>"] }
  },
  "deliverabilityChecklist": [
    { "item": "<check>", "status": "recommended|required", "notes": "<note>" }
  ],
  "benchmarks": {
    "targetOpenRate": "<pct>",
    "targetClickRate": "<pct>",
    "targetConversionRate": "<pct>",
    "expectedRevenueLift": "<estimate>",
    "measurementWindow": "<days>"
  },
  ${underperformerSection}
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

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return { output, costUsd };
};

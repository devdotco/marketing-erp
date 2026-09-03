import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

interface GbpReview {
  reviewId: string;
  comment?: string;
  starRating: string;
  createTime: string;
  reviewer: { displayName: string };
  reviewReply?: unknown;
}

// Maps GBP's string star ratings to numeric values for display
const starRatingMap: Record<string, number> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

export const reviewEngineHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const reviewPlatforms = (config.reviewPlatforms as string) ?? "All";
  const requestTrigger = (config.requestTrigger as string) ?? "Post-purchase";
  const responseStyle = (config.responseStyle as string) ?? "Professional";
  const negativeEscalation = (config.negativeEscalation as boolean) ?? true;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  // --- Live GBP integration ---
  const integration = await prisma.integration.findUnique({
    where: {
      workspaceId_provider: {
        workspaceId: run.agentConfig.workspaceId,
        provider: "GOOGLE_BUSINESS_PROFILE",
      },
    },
  });

  let unansweredReviews: GbpReview[] = [];
  let isLive = false;

  if (integration) {
    try {
      const gbpCreds = await decryptCredentials<{
        access_token: string;
        account_id: string;
        location_id: string;
      }>(integration.encryptedCredentials);

      const url = `https://mybusiness.googleapis.com/v4/accounts/${gbpCreds.account_id}/locations/${gbpCreds.location_id}/reviews`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${gbpCreds.access_token}` },
      });

      if (res.ok) {
        const data = (await res.json()) as { reviews?: GbpReview[] };
        unansweredReviews = (data.reviews ?? []).filter((r) => !r.reviewReply);
        isLive = true;
      }
    } catch {
      // decryption or network error — fall back to simulation
      unansweredReviews = [];
      isLive = false;
    }
  }
  // --- end live GBP setup ---

  const systemPrompt = `You are a reputation management specialist who helps businesses build social proof through ethical review generation and thoughtful public responses. You craft review request sequences that trigger at peak satisfaction moments, and draft authentic, on-brand responses to every review — positive, neutral, and negative. Negative responses always de-escalate without being defensive. Always respond with valid JSON only — no markdown fences, no text outside the JSON object.`;

  const platformList =
    reviewPlatforms === "All"
      ? ["Google Business Profile", "Trustpilot", "G2"]
      : [reviewPlatforms];

  // Build live reviews context for the prompt
  const liveReviewsSection =
    isLive && unansweredReviews.length > 0
      ? [
          "",
          `LIVE DATA — ${unansweredReviews.length} unanswered review(s) fetched from Google Business Profile:`,
          ...unansweredReviews.map((r, i) => {
            const stars = starRatingMap[r.starRating] ?? "?";
            return `Review ${i + 1}: ${stars}/5 stars — by ${r.reviewer.displayName} on ${r.createTime}\n"${r.comment ?? "(no comment)"}"`;
          }),
          "",
          `For each of the ${unansweredReviews.length} live review(s) above, generate a personalised reply in the liveReviewDrafts array below.`,
        ].join("\n")
      : "";

  const liveReviewDraftsShape =
    isLive && unansweredReviews.length > 0
      ? `,
  "liveReviewDrafts": [
    {
      "reviewId": "<GBP reviewId>",
      "reviewerName": "<reviewer display name>",
      "rating": 0,
      "originalComment": "<original review text>",
      "suggestedReply": "<personalised reply that acknowledges the specific feedback — not a template>"
    }
  ]`
      : "";

  const userPrompt = `Generate a complete Review Engine playbook for the following business.

Business Context:
- Name: ${businessProfile?.businessName ?? "the business"}
- Industry: ${businessProfile?.industry ?? "SaaS"}
- Target Audience: ${businessProfile?.targetAudience ?? "B2B professionals"}
- Brand Voice: ${businessProfile?.brandVoice ?? "Professional"}
- Website: ${businessProfile?.websiteUrl ?? "https://example.com"}

Review Engine Configuration:
- Review Platforms: ${platformList.join(", ")}
- Request Trigger: ${requestTrigger}
- Response Style: ${responseStyle}
- Negative Review Escalation: ${negativeEscalation}
${liveReviewsSection}
Produce:
1. Review request messages for each platform (email + optional SMS) triggered at ${requestTrigger}
2. Response templates for positive reviews (4-5 stars)
3. Response templates for neutral reviews (3 stars)
4. Response templates for negative reviews (1-2 stars) with de-escalation
5. ${negativeEscalation ? "An escalation playbook for severe negative reviews" : "Standard handling only"}
6. Simulated current review snapshot per platform${isLive ? " (mark as simulated since live snapshot is provided separately)" : ""}

Return JSON matching this exact shape:

{
  "playbookName": "<descriptive name>",
  "requestTrigger": "${requestTrigger}",
  "platforms": [
    {
      "platform": "<platform name>",
      "profileUrl": "<simulated profile URL>",
      "currentRating": 0.0,
      "totalReviews": 0,
      "reviewRequests": {
        "email": {
          "subject": "<email subject>",
          "previewText": "<preview>",
          "bodyHtml": "<full HTML email body with personalisation tokens {{name}}, {{product}}>",
          "sendDelay": "<e.g. 2 hours after trigger>",
          "followUpEmail": {
            "subject": "<follow-up subject if no action in 5 days>",
            "bodyHtml": "<follow-up body>"
          }
        },
        "sms": {
          "message": "<SMS text under 160 chars with review link>",
          "sendDelay": "<send timing>"
        }
      },
      "automationTriggerDetails": {
        "event": "<specific event name in CRM/ESP>",
        "entryFilter": "<filter condition>",
        "suppressionList": ["<do not send if>"]
      }
    }
  ],
  "responseTemplates": {
    "positive": [
      {
        "starRange": "4-5",
        "scenario": "<scenario description>",
        "template": "<full response text with {{reviewer_name}}, {{business_name}} tokens>",
        "tone": "<tone descriptor>",
        "maxLength": 0
      }
    ],
    "neutral": [
      {
        "starRange": "3",
        "scenario": "<scenario>",
        "template": "<full response>",
        "actionableOffer": "<what to offer to improve satisfaction>"
      }
    ],
    "negative": [
      {
        "starRange": "1-2",
        "scenario": "<scenario e.g. delivery issue, product defect, support failure>",
        "template": "<full de-escalation response — empathetic, solution-focused, never defensive>",
        "privateOutreachScript": "<what to say when taking the conversation offline>",
        "resolutionOffer": "<concrete offer to resolve>"
      }
    ]
  },
  "escalationPlaybook": ${
    negativeEscalation
      ? `{
    "triggerConditions": [
      { "condition": "<when to escalate>", "severity": "critical|high|medium" }
    ],
    "escalationPath": [
      { "step": 1, "action": "<immediate action within X hours>", "owner": "<role>" },
      { "step": 2, "action": "<follow-up action>", "owner": "<role>" },
      { "step": 3, "action": "<resolution action>", "owner": "<role>" }
    ],
    "legalReviewTriggers": ["<when to involve legal>"],
    "publicStatementTemplate": "<if review goes viral or media picks it up>"
  }`
      : "null"
  },
  "reviewSnapshot": [
    {
      "platform": "<platform>",
      "simulatedRecentReviews": [
        {
          "reviewer": "<first name + last initial>",
          "rating": 0,
          "date": "<ISO date>",
          "excerpt": "<review text excerpt>",
          "responded": true,
          "responseSnippet": "<our response snippet>"
        }
      ]
    }
  ],
  "kpis": {
    "targetAverageRating": 0.0,
    "targetMonthlyNewReviews": 0,
    "responseTimeTarget": "<e.g. within 24 hours>",
    "currentResponseRate": "<pct>"
  }${
    isLive
      ? liveReviewDraftsShape
      : `,
  "simulationNote": "Connect Google Business Profile, Trustpilot, and G2 APIs in Settings to enable live review ingestion, automatic response posting, and real-time alerts."`
  }
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

  // Mark source and clean up simulationNote when live
  if (isLive) {
    output.source = "live";
    output.unansweredReviewCount = unansweredReviews.length;
    delete output.simulationNote;
  } else {
    output.source = "simulation";
  }

  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  // Reviews always require approval — never auto-submit replies
  const requireApproval = true;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  return { output, costUsd };
};

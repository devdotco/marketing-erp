import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

// --- Mailchimp helpers ---
function mailchimpAuthHeader(apiKey: string): string {
  return "Basic " + Buffer.from(`anystring:${apiKey}`).toString("base64");
}

async function fetchMailchimpCampaigns(apiKey: string, server: string): Promise<unknown[]> {
  const res = await fetch(
    `https://${server}.api.mailchimp.com/3.0/campaigns?count=10&status=sent`,
    { headers: { Authorization: mailchimpAuthHeader(apiKey) } }
  );
  if (!res.ok) throw new Error(`Mailchimp campaigns error: ${res.status}`);
  const data = (await res.json()) as { campaigns?: unknown[] };
  return data.campaigns ?? [];
}

async function fetchMailchimpAudiences(apiKey: string, server: string): Promise<unknown[]> {
  const res = await fetch(
    `https://${server}.api.mailchimp.com/3.0/lists`,
    { headers: { Authorization: mailchimpAuthHeader(apiKey) } }
  );
  if (!res.ok) throw new Error(`Mailchimp lists error: ${res.status}`);
  const data = (await res.json()) as { lists?: unknown[] };
  return data.lists ?? [];
}

async function createMailchimpDraft(
  apiKey: string,
  server: string,
  listId: string,
  subjectLine: string,
  title: string,
  fromName: string,
  replyTo: string
): Promise<string> {
  const res = await fetch(`https://${server}.api.mailchimp.com/3.0/campaigns`, {
    method: "POST",
    headers: {
      Authorization: mailchimpAuthHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "regular",
      recipients: { list_id: listId },
      settings: { subject_line: subjectLine, title, from_name: fromName, reply_to: replyTo },
    }),
  });
  if (!res.ok) throw new Error(`Mailchimp create draft error: ${res.status}`);
  const data = (await res.json()) as { id?: string };
  return data.id ?? "";
}

// --- Klaviyo helpers ---
function klaviyoHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: "2024-10-15",
    "Content-Type": "application/json",
  };
}

async function fetchKlaviyoCampaigns(apiKey: string): Promise<unknown[]> {
  const res = await fetch(
    `https://a.klaviyo.com/api/campaigns/?filter=equals(messages.channel,'email')`,
    { headers: klaviyoHeaders(apiKey) }
  );
  if (!res.ok) throw new Error(`Klaviyo campaigns error: ${res.status}`);
  const data = (await res.json()) as { data?: unknown[] };
  return data.data ?? [];
}

async function createKlaviyoDraft(apiKey: string, name: string): Promise<string> {
  const res = await fetch(`https://a.klaviyo.com/api/campaigns/`, {
    method: "POST",
    headers: klaviyoHeaders(apiKey),
    body: JSON.stringify({
      data: {
        type: "campaign",
        attributes: {
          name,
          audiences: { included: [] },
          send_strategy: { method: "static" },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Klaviyo create draft error: ${res.status}`);
  const data = (await res.json()) as { data?: { id?: string } };
  return data.data?.id ?? "";
}

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

  // --- Live ESP data ---
  let liveContext = "";
  let source = "simulation";
  let espProvider: "MAILCHIMP" | "KLAVIYO" | null = null;
  let mailchimpCreds: { apiKey: string; server: string } | null = null;
  let klaviyoCreds: { apiKey: string } | null = null;
  let mailchimpAudienceId = "";

  try {
    const mailchimpIntegration = await prisma.integration.findUnique({
      where: {
        workspaceId_provider: {
          workspaceId: run.agentConfig.workspaceId,
          provider: "MAILCHIMP",
        },
      },
    });

    if (mailchimpIntegration?.encryptedCredentials) {
      mailchimpCreds = await decryptCredentials<{ apiKey: string; server: string }>(
        mailchimpIntegration.encryptedCredentials
      );
      const [campaigns, audiences] = await Promise.all([
        fetchMailchimpCampaigns(mailchimpCreds.apiKey, mailchimpCreds.server),
        fetchMailchimpAudiences(mailchimpCreds.apiKey, mailchimpCreds.server),
      ]);
      if (audiences.length > 0) {
        mailchimpAudienceId = ((audiences[0] as Record<string, unknown>).id as string) ?? "";
      }
      liveContext = `\nMailchimp Account Data:\nAudience lists: ${JSON.stringify(
        audiences.slice(0, 5),
        null,
        2
      )}\nRecent sent campaigns (with performance stats): ${JSON.stringify(
        campaigns.slice(0, 5),
        null,
        2
      )}`;
      source = "live";
      espProvider = "MAILCHIMP";
    } else {
      const klaviyoIntegration = await prisma.integration.findUnique({
        where: {
          workspaceId_provider: {
            workspaceId: run.agentConfig.workspaceId,
            provider: "KLAVIYO",
          },
        },
      });

      if (klaviyoIntegration?.encryptedCredentials) {
        klaviyoCreds = await decryptCredentials<{ apiKey: string }>(
          klaviyoIntegration.encryptedCredentials
        );
        const campaigns = await fetchKlaviyoCampaigns(klaviyoCreds.apiKey);
        liveContext = `\nKlaviyo Account Data:\nRecent email campaigns: ${JSON.stringify(
          campaigns.slice(0, 5),
          null,
          2
        )}`;
        source = "live";
        espProvider = "KLAVIYO";
      }
    }
  } catch {
    liveContext = "";
    source = "simulation";
  }

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
${liveContext ? `\nReal ESP Account Data (use this to inform targeting recommendations and benchmark performance against existing campaigns):\n${liveContext}` : ""}

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

  // --- Create draft in ESP ---
  if (espProvider === "MAILCHIMP" && mailchimpCreds && mailchimpAudienceId) {
    try {
      const campaignName =
        typeof output.campaignName === "string" ? output.campaignName : "AI Campaign";
      const firstEmail =
        Array.isArray(output.emailSequence) && output.emailSequence.length > 0
          ? (output.emailSequence[0] as Record<string, unknown>)
          : null;
      const subjectLine =
        typeof firstEmail?.subjectLine === "string" ? firstEmail.subjectLine : campaignName;
      const fromName = businessProfile?.businessName ?? "Marketing";
      const hostname = businessProfile?.websiteUrl
        ? (() => {
            try {
              return new URL(businessProfile.websiteUrl).hostname;
            } catch {
              return "example.com";
            }
          })()
        : "example.com";
      const replyTo = `hello@${hostname}`;

      const draftId = await createMailchimpDraft(
        mailchimpCreds.apiKey,
        mailchimpCreds.server,
        mailchimpAudienceId,
        subjectLine,
        campaignName,
        fromName,
        replyTo
      );
      output.espDraftId = draftId;
      output.espDraftProvider = "MAILCHIMP";
    } catch {
      // Non-fatal — keep generated content
    }
  } else if (espProvider === "KLAVIYO" && klaviyoCreds) {
    try {
      const campaignName =
        typeof output.campaignName === "string" ? output.campaignName : "AI Campaign";
      const draftId = await createKlaviyoDraft(klaviyoCreds.apiKey, campaignName);
      output.espDraftId = draftId;
      output.espDraftProvider = "KLAVIYO";
    } catch {
      // Non-fatal — keep generated content
    }
  }

  output.source = source;
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

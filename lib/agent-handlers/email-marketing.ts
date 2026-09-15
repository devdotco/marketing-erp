import type { AgentHandler } from "./index";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { bool, num, resolveInputs, str } from "@/lib/agents/inputs";
import { applyRenamedInputs } from "./renamed-inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { AgentInputError } from "@/lib/ai/errors";
import { createKlaviyoDraft, createMailchimpDraft, resolveEspLiveData } from "./esp-providers";
import { emailSequenceToSteps, parseAudienceEmails, stageInstantlyCampaign, stageApolloSequence, stageCrmSequence } from "./email-marketing-channels";
import { resolveCrmConnection, type CrmConnection } from "@/lib/integrations/crm-connection";
import type { CreateInstantlyCampaignInput } from "@/lib/integrations/instantly";

type InstantlySendDay = NonNullable<CreateInstantlyCampaignInput["sendDayOfWeek"]>;
const INSTANTLY_SEND_DAYS: readonly InstantlySendDay[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
function coerceInstantlySendDay(value: unknown): InstantlySendDay | undefined {
  return INSTANTLY_SEND_DAYS.find((day) => day === value);
}

export const emailMarketingHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  // Old names from before the form and handler were reconciled — see renamed-inputs.ts.
  applyRenamedInputs(run, config, { campaignGoal: "campaignType" });
  const campaignType = str(config, "campaignGoal", "Nurture");
  const segmentCondition = str(config, "segmentCondition");
  const numberOfEmails = Math.round(num(config, "numberOfEmails", 5, { min: 1, max: 10 }));
  const offerOrCta = str(config, "offerOrCta");
  const brandVoiceNotes = str(config, "brandVoice");
  const segmentByLifecycle = bool(config, "segmentByLifecycle", true);
  const abTestSubjectLines = bool(config, "abTestSubjectLines", true);
  // The metadata field is "platform" (required: Mailchimp, Klaviyo, Instantly, Apollo, or erp.io
  // CRM) — this handler used to read a field named "espTarget" that doesn't exist on this agent's
  // config schema at all, so it silently always fell back to its "Draft" default and never
  // actually pinned which platform to use.
  const platform = (config.platform as string) ?? "";
  const platformUpper = platform.toUpperCase().replace(/[^A-Z]/g, "_");
  const preferredProvider =
    platformUpper === "KLAVIYO" ? "KLAVIYO" as const
    : platformUpper === "MAILCHIMP" ? "MAILCHIMP" as const
    : platformUpper === "INSTANTLY" ? "INSTANTLY" as const
    : platformUpper === "APOLLO" || platformUpper === "APOLLO_IO" ? "APOLLO" as const
    : platformUpper.includes("CRM") ? "CRM_ERP_IO" as const
    : undefined;
  const espTarget = platform || "Draft";
  const configuredAudienceId = (config.audienceId as string) ?? "";
  const senderAccountId = (config.senderAccountId as string) ?? "";
  const ctaUrl = str(config, "ctaUrl");
  const rewriteUnderperformers = bool(config, "rewriteUnderperformers", false);

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  let preferredIntegration: Awaited<ReturnType<typeof prisma.integration.findUnique>> = null;
  let crmConnection: Extract<CrmConnection, { ok: true }> | null = null;
  if (preferredProvider === "CRM_ERP_IO") {
    // No pasted key: a workspace tied to an erp.io organization reaches that org's CRM workspace
    // with a signed service assertion. See lib/integrations/crm-connection.ts.
    const connection = await resolveCrmConnection(run.agentConfig.workspaceId);
    if (!connection.ok) {
      throw new AgentInputError(
        `erp.io CRM is selected as the Email Platform, but ${connection.reason}`,
        connection.code === "no_org"
          ? "Open Marketing from app.erp.io so this workspace is tied to your organization, or change the Email Platform field."
          : "Ask an administrator to set MARKETING_SERVICE_PRIVATE_KEY on this server, or change the Email Platform field.",
        "crm_not_linked",
      );
    }
    crmConnection = connection;
  } else if (preferredProvider) {
    preferredIntegration = await prisma.integration.findUnique({
      where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: preferredProvider } },
    });
    if (!preferredIntegration) {
      throw new AgentInputError(
        `${platform} is selected as the Email Platform, but it isn't connected for this workspace.`,
        `Connect ${platform} under Settings → Integrations, or change the Email Platform field.`,
        "esp_not_connected",
      );
    }
  }

  // --- Live ESP data. Only Mailchimp/Klaviyo have a "recent campaign performance" concept to
  // ground the prompt in — Instantly/Apollo/erp.io CRM are staged from scratch below instead. A
  // connected-but-broken ESP doesn't silently look identical to no ESP — see esp-providers.ts.
  const isNewerChannel = preferredProvider === "INSTANTLY" || preferredProvider === "APOLLO" || preferredProvider === "CRM_ERP_IO";
  const espPreferredProvider = preferredProvider === "MAILCHIMP" || preferredProvider === "KLAVIYO" ? preferredProvider : undefined;
  const espResult = isNewerChannel
    ? ({ source: "simulation", error: undefined } as const)
    : await resolveEspLiveData(run.agentConfig.workspaceId, 5, espPreferredProvider);
  const liveContext = espResult.source === "live" ? espResult.liveContext : "";
  const source = espResult.source;
  const espProvider = espResult.source === "live" ? espResult.provider : null;
  const mailchimpCreds = espResult.source === "live" && espResult.provider === "MAILCHIMP" ? espResult.mailchimpCreds : null;
  const klaviyoCreds = espResult.source === "live" && espResult.provider === "KLAVIYO" ? espResult.klaviyoCreds : null;
  // Prefer the Audience/List ID the customer configured; fall back to the
  // account's first list only when they didn't set one.
  const mailchimpAudienceId = configuredAudienceId ||
    (espResult.source === "live" && espResult.provider === "MAILCHIMP" ? espResult.mailchimpAudienceId : "");
  const espReadError = espResult.source === "simulation" ? espResult.error : undefined;

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
- Brand Voice: ${brandVoiceNotes || (businessProfile?.brandVoice ?? "Professional yet approachable")}
- Website: ${businessProfile?.websiteUrl ?? ""}

Campaign Configuration:
- Campaign Goal: ${campaignType}
- Number of Emails in Sequence: ${numberOfEmails}
- Segment Condition: ${segmentCondition || "All active subscribers"}
- ESP Target: ${espTarget}
- Offer / Call to Action: ${offerOrCta || "Choose the most natural next step for this goal"}
- Primary CTA URL: ${ctaUrl || "https://example.com/get-started"}
- Segment by Lifecycle Stage: ${segmentByLifecycle ? "yes — define segments by lifecycle stage (cold, nurturing, active, at-risk, lapsed) and tailor each email's copy to the stage it targets" : "no — one audience, one version of each email"}
- A/B Test Subject Lines: ${abTestSubjectLines ? "yes — two subject-line variants per email" : "no — leave abVariants as an empty array"}
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
    } catch (err) {
      // Non-fatal — the campaign copy above is genuine either way, but don't
      // pretend a draft exists in Mailchimp when the create call failed.
      output.espDraftError = `Mailchimp: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else if (espProvider === "KLAVIYO" && klaviyoCreds) {
    try {
      const campaignName =
        typeof output.campaignName === "string" ? output.campaignName : "AI Campaign";
      const draftId = await createKlaviyoDraft(klaviyoCreds.apiKey, campaignName, configuredAudienceId || undefined);
      output.espDraftId = draftId;
      output.espDraftProvider = "KLAVIYO";
      if (!configuredAudienceId) {
        output.espDraftWarning = "Created with no audience attached — set Audience or List ID, or assign one in Klaviyo before sending.";
      }
    } catch (err) {
      output.espDraftError = `Klaviyo: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else if (preferredProvider === "INSTANTLY" || preferredProvider === "APOLLO" || preferredProvider === "CRM_ERP_IO") {
    // --- Instantly / Apollo / erp.io CRM: stage a paused campaign/sequence now; a human
    // approving this run (app/api/runs/[runId]/approve/route.ts, via
    // lib/agent-handlers/on-approve.ts) is what adds the audience and makes it live. A staging
    // failure is recorded on `channelDelivery`, NOT thrown: the campaign copy above is genuine
    // either way, and an uncaught throw here would have the worker replace this run's whole
    // `output` with just the error (see workers/agent-worker.ts), discarding it.
    const campaignName = typeof output.campaignName === "string" ? output.campaignName : "AI Campaign";
    const steps = emailSequenceToSteps(output.emailSequence);
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
    const fromAddress = `hello@${hostname}`;
    try {
      if (preferredProvider === "INSTANTLY") {
        // Guaranteed non-null: the check above already threw AgentInputError if this platform was
        // selected but not connected.
        const creds = await decryptCredentials<{ apiKey: string }>(preferredIntegration!.encryptedCredentials);
        const channel = await stageInstantlyCampaign(creds.apiKey, {
          campaignName,
          steps,
          listId: configuredAudienceId,
          sendDayOfWeek: coerceInstantlySendDay(config.sendDayOfWeek),
        });
        output.channelDelivery = { platform: "INSTANTLY", status: "staged", instantly: channel };
      } else if (preferredProvider === "APOLLO") {
        const creds = await decryptCredentials<{ apiKey: string }>(preferredIntegration!.encryptedCredentials);
        const channel = await stageApolloSequence(creds.apiKey, {
          sequenceName: campaignName,
          steps: steps.map((s) => ({ subject: s.subject, bodyHtml: s.body, waitDays: s.delayDays })),
          audienceEmails: parseAudienceEmails(configuredAudienceId),
          senderAccountId,
        });
        output.channelDelivery = { platform: "APOLLO", status: "staged", apollo: channel };
      } else {
        // Resolved (and refused if unusable) before any tokens were spent, above.
        const channel = await stageCrmSequence(crmConnection!.target, {
          name: campaignName,
          fromAddress,
          fromName,
          steps,
          segmentId: configuredAudienceId,
        });
        output.channelDelivery = { platform: "CRM_ERP_IO", status: "staged", crm: channel };
      }
    } catch (err) {
      const isInputError = err instanceof AgentInputError;
      output.channelDelivery = {
        platform: preferredProvider,
        status: "error",
        error: {
          message: isInputError ? err.message : err instanceof Error ? err.message : String(err),
          hint: isInputError ? err.hint : undefined,
          code: isInputError ? err.code : "channel_stage_failed",
        },
      };
    }
  }

  output.source = source;
  if (espReadError) output.espReadError = espReadError;
  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  return { output, costUsd };
};

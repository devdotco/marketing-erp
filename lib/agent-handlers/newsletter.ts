import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

// --- Mailchimp helpers ---
function mailchimpAuthHeader(apiKey: string): string {
  return "Basic " + Buffer.from(`anystring:${apiKey}`).toString("base64");
}

async function fetchMailchimpSentCampaigns(apiKey: string, server: string): Promise<unknown[]> {
  const res = await fetch(
    `https://${server}.api.mailchimp.com/3.0/campaigns?count=5&status=sent`,
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

async function fetchKlaviyoSentCampaigns(apiKey: string): Promise<unknown[]> {
  const res = await fetch(
    `https://a.klaviyo.com/api/campaigns/?filter=equals(messages.channel,'email')`,
    { headers: klaviyoHeaders(apiKey) }
  );
  if (!res.ok) throw new Error(`Klaviyo campaigns error: ${res.status}`);
  const data = (await res.json()) as { data?: unknown[] };
  // Return first 5
  return (data.data ?? []).slice(0, 5);
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

export const newsletterHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const newsletterName =
    typeof config.newsletterName === "string" ? config.newsletterName : "The Newsletter";
  const cadence =
    typeof config.cadence === "string" ? config.cadence : "Weekly";
  const issueTheme =
    typeof config.issueTheme === "string" ? config.issueTheme : "";
  const numberOfStories =
    typeof config.numberOfStories === "number" ? config.numberOfStories : 4;
  const ctaText =
    typeof config.cta === "string" ? config.cta : "";
  const espTarget =
    typeof config.espTarget === "string" ? config.espTarget : "Draft";

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandVoiceStr =
    businessProfile?.brandVoice != null
      ? String(businessProfile.brandVoice)
      : "";

  const goalsStr =
    businessProfile?.goals != null
      ? String(businessProfile.goals)
      : "";

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business: ${businessProfile.businessName}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        brandVoiceStr ? `Brand voice: ${brandVoiceStr}` : "",
        businessProfile.targetAudience ? `Target audience: ${businessProfile.targetAudience}` : "",
        goalsStr ? `Business goals: ${goalsStr}` : "",
        businessProfile.websiteUrl ? `Website: ${businessProfile.websiteUrl}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

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
        fetchMailchimpSentCampaigns(mailchimpCreds.apiKey, mailchimpCreds.server),
        fetchMailchimpAudiences(mailchimpCreds.apiKey, mailchimpCreds.server),
      ]);
      if (audiences.length > 0) {
        mailchimpAudienceId = ((audiences[0] as Record<string, unknown>).id as string) ?? "";
      }
      liveContext = `\nMailchimp — last 5 sent campaigns (use open/click rates to understand what subject lines and content styles perform well for this audience):\n${JSON.stringify(
        campaigns,
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
        const campaigns = await fetchKlaviyoSentCampaigns(klaviyoCreds.apiKey);
        liveContext = `\nKlaviyo — last 5 email campaigns (use performance data to understand what resonates with this audience):\n${JSON.stringify(
          campaigns,
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

  const systemPrompt = [
    "You are a senior newsletter editor who writes with a strong editorial voice and through-line.",
    "Each issue has a unifying theme that ties all stories together — rather than being a disconnected list of links.",
    "Your editorial notes feel personal and human, as if written by a trusted expert sharing their genuine perspective.",
    "You write for engaged readers who value insight over information dumping.",
    "Stories have real narrative structure: a tension, a development, and a takeaway.",
    "Subject lines are specific and curiosity-driven — never clickbait, always true.",
    "Return ONLY valid JSON — no markdown fences, no preamble, no trailing commentary.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const espFormatNote: Record<string, string> = {
    Mailchimp: "Format body fields as standard HTML compatible with Mailchimp's template builder.",
    Klaviyo: "Format body fields as HTML compatible with Klaviyo's drag-and-drop editor blocks.",
    Beehiiv: "Format body fields as clean prose HTML — Beehiiv renders from its own editor.",
    Draft: "Format body fields as clean, readable HTML suitable for any ESP.",
  };
  const espNote = espFormatNote[espTarget] ?? espFormatNote["Draft"];

  const userPrompt = [
    `Write a complete ${cadence.toLowerCase()} issue of "${newsletterName}".`,
    issueTheme ? `Issue theme: ${issueTheme}` : "",
    `Include exactly ${numberOfStories} stories, each connected by the editorial through-line of the issue theme.`,
    ctaText ? `Primary CTA for this issue: ${ctaText}` : "",
    espNote,
    liveContext
      ? `\nReal ESP performance data — use these past campaign results to inform your subject line style, story angles, and content tone:\n${liveContext}`
      : "",
    "",
    "Requirements:",
    "- The editorial note should reference the theme personally and set up why it matters right now.",
    "- Each story must have a full body (3–5 paragraphs), not just a summary sentence.",
    "- Read time should be calculated at 200 words per minute.",
    "- sourceUrl should be a plausible URL if no real URL is known (mark as null if invented).",
    "- The footer should include an unsubscribe placeholder and the newsletter name.",
    "- wordCount is the total word count of all body text combined (editorial note + all story bodies + cta body).",
    "- issueNumber and sponsorSlot should be null — these are filled in by the platform.",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      issueNumber: null,
      subjectLine: "Specific, curiosity-driven subject line",
      previewText: "Preview text shown in inbox — 90 characters max",
      fromName: newsletterName,
      editorialNote:
        "Personal 2–3 paragraph editor's note that frames the issue theme and sets up the stories",
      stories: [
        {
          headline: "Story headline",
          summary: "One sentence summary (used as card subtitle in some ESPs)",
          body: "Full story body in HTML — 3 to 5 paragraphs",
          sourceUrl: "https://example.com/source-article or null",
          readTime: 3,
        },
      ],
      sponsorSlot: null,
      cta: {
        headline: "CTA section headline",
        body: "1–2 sentence CTA body copy",
        buttonText: "CTA button label",
        url: "[[CTA_URL]]",
      },
      footer:
        "Footer text with unsubscribe placeholder [[UNSUBSCRIBE_URL]] and newsletter name",
      espTarget: espTarget,
      wordCount: 0,
    }),
  ]
    .filter(Boolean)
    .join("\n");

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
      const issueTitle =
        typeof output.subjectLine === "string"
          ? output.subjectLine
          : `${newsletterName} — New Issue`;
      const fromName =
        typeof output.fromName === "string" ? output.fromName : newsletterName;
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
        issueTitle,
        issueTitle,
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
      const issueTitle =
        typeof output.subjectLine === "string"
          ? output.subjectLine
          : `${newsletterName} — New Issue`;
      const draftId = await createKlaviyoDraft(klaviyoCreds.apiKey, issueTitle);
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

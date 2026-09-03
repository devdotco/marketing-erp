import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

const client = new Anthropic();

// Encode RFC 2822 email string as base64url for Gmail API
function toBase64Url(str: string): string {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Build a minimal RFC 2822 email string
function buildRfc2822(to: string, subject: string, body: string): string {
  return [
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    "",
    body,
  ].join("\r\n");
}

export const outreachHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const pitchAngle = String(config.pitchAngle ?? "");
  const sequenceLength = Number(config.sequenceLength ?? 3);
  const followUpDays = Number(config.followUpDays ?? 3);
  const dailyLimit = Number(config.dailyLimit ?? 20);
  const emailAccount = String(config.emailAccount ?? "Gmail");
  const personalisation = String(config.personalisation ?? "High");

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const brandContext = businessProfile
    ? [
        businessProfile.businessName ? `Business: ${businessProfile.businessName}` : "",
        businessProfile.websiteUrl ? `Website: ${businessProfile.websiteUrl}` : "",
        businessProfile.industry ? `Industry: ${businessProfile.industry}` : "",
        businessProfile.targetAudience ? `Target audience: ${businessProfile.targetAudience}` : "",
        businessProfile.brandVoice ? `Brand voice: ${businessProfile.brandVoice}` : "",
        businessProfile.uniqueValueProp ? `Unique value proposition: ${businessProfile.uniqueValueProp}` : "",
      ].filter(Boolean).join("\n")
    : "";

  // --- Live email integration: fetch sent-email context for personalization ---
  let emailContextSummary = "";
  let liveProvider: string | null = null;
  let accessToken: string | null = null;
  let emailSource = "simulation";

  const gmailIntegration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "GMAIL" } },
  });
  const m365Integration = !gmailIntegration
    ? await prisma.integration.findUnique({
        where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "MICROSOFT_365" } },
      })
    : null;

  if (gmailIntegration) {
    try {
      const creds = await decryptCredentials<{ access_token: string }>(gmailIntegration.encryptedCredentials);
      accessToken = creds.access_token;
      liveProvider = "GMAIL";

      // Fetch recent sent emails for bounce/reply pattern context
      const sentRes = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:sent&maxResults=20",
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (sentRes.ok) {
        const sentData = (await sentRes.json()) as { messages?: { id: string }[] };
        const snippets: string[] = [];
        for (const msg of (sentData.messages ?? []).slice(0, 5)) {
          const detailRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          if (detailRes.ok) {
            const detail = (await detailRes.json()) as {
              snippet?: string;
              payload?: { headers?: { name: string; value: string }[] };
            };
            const subject = detail.payload?.headers?.find((h) => h.name === "Subject")?.value ?? "(no subject)";
            snippets.push(`Subject: "${subject}" — ${(detail.snippet ?? "").slice(0, 80)}`);
          }
        }
        emailContextSummary = `Recent sent emails (${sentData.messages?.length ?? 0} total):\n${snippets.join("\n")}`;
        emailSource = "live";
      }
    } catch {
      // Fall through to simulation
    }
  } else if (m365Integration) {
    try {
      const creds = await decryptCredentials<{ access_token: string }>(m365Integration.encryptedCredentials);
      accessToken = creds.access_token;
      liveProvider = "MICROSOFT_365";

      const sentRes = await fetch(
        "https://graph.microsoft.com/v1.0/me/mailFolders/SentItems/messages?$top=20&$select=subject,bodyPreview",
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (sentRes.ok) {
        const sentData = (await sentRes.json()) as { value?: { subject: string; bodyPreview: string }[] };
        const snippets = (sentData.value ?? []).slice(0, 5).map(
          (m) => `Subject: "${m.subject}" — ${(m.bodyPreview ?? "").slice(0, 80)}`
        );
        emailContextSummary = `Recent sent emails (${sentData.value?.length ?? 0} fetched):\n${snippets.join("\n")}`;
        emailSource = "live";
      }
    } catch {
      // Fall through to simulation
    }
  }

  // --- Claude: generate outreach sequences ---
  const systemPrompt = [
    "You are a link building outreach specialist who writes cold emails that actually get replies.",
    "Emails must be short (under 100 words for the initial pitch), specific (reference something real about the prospect), and genuine (no fake compliments).",
    "Subject lines are intriguing, not clickbait. Follow-ups add value — they don't just ask 'did you see my last email?'",
    "Return ONLY valid JSON — no markdown fences, no preamble.",
    brandContext ? `\nClient context:\n${brandContext}` : "",
  ].filter(Boolean).join("\n");

  const sendDelayLabel = (step: number) =>
    step === 1 ? "Send immediately" : `+${(step - 1) * followUpDays} day${(step - 1) * followUpDays === 1 ? "" : "s"}`;

  const exampleSequence = Array.from({ length: sequenceLength }, (_, i) => ({
    sequenceStep: i + 1,
    sendDelay: sendDelayLabel(i + 1),
    subject: i === 0 ? "Initial subject line" : `Follow-up ${i} subject line`,
    body: "Email body text",
    wordCount: 0,
    personalisationNotes: "What was personalised and why",
  }));

  const userPrompt = [
    `Write link building outreach email sequences for ${dailyLimit} prospects per day.`,
    `Sequence length: ${sequenceLength} emails per prospect, with ${followUpDays}-day gaps between follow-ups.`,
    `Personalisation level: ${personalisation}`,
    `Sending account: ${emailAccount}`,
    pitchAngle ? `Pitch angle / value offer: ${pitchAngle}` : "",
    emailContextSummary
      ? `\nContext from live sent emails (calibrate tone; avoid patterns already used):\n${emailContextSummary}`
      : "",
    "",
    "Generate sequences for at least 5 representative prospects across different site types (blog, resource page, news site, directory, niche community).",
    "Each email body must be plain text — no HTML, no excessive formatting. Initial emails must be under 100 words.",
    "Follow-up emails should acknowledge the previous email briefly and add a new angle or piece of value.",
    "Include a prospectEmail field on each sequence (use a realistic address for the domain).",
    "",
    "Return this exact JSON structure:",
    JSON.stringify({
      sequences: [
        {
          prospectDomain: "example.com",
          prospectEmail: "contact@example.com",
          prospectName: null,
          emails: exampleSequence,
          pitchAngle: "The specific angle used for this prospect",
        },
      ],
      dailyVolume: dailyLimit,
    }),
  ].filter(Boolean).join("\n");

  const message = await client.messages.create({
    model: "claude-sonnet-5-20251015",
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = rawText.match(/\{[\s\S]+\}/);
  let claudeOutput: Record<string, unknown>;
  try {
    claudeOutput = jsonMatch ? JSON.parse(jsonMatch[0]) : { rawText };
  } catch {
    claudeOutput = { rawText };
  }

  // --- Create drafts (step-1 only) in Gmail or M365 — never auto-send ---
  interface DraftRecord {
    to: string;
    subject: string;
    body: string;
    provider: string;
    draftId?: string;
    sequenceStep: number;
    prospectDomain: string;
  }

  const drafts: DraftRecord[] = [];

  const sequences = (claudeOutput.sequences as Array<{
    prospectDomain: string;
    prospectEmail?: string;
    emails: Array<{ subject: string; body: string; sequenceStep: number }>;
  }>) ?? [];

  if (liveProvider && accessToken && sequences.length > 0) {
    for (const seq of sequences.slice(0, 3)) {
      const firstEmail = seq.emails[0];
      if (!firstEmail) continue;

      const toAddress = seq.prospectEmail ?? `contact@${seq.prospectDomain}`;
      let draftId: string | undefined;

      if (liveProvider === "GMAIL") {
        const raw = toBase64Url(buildRfc2822(toAddress, firstEmail.subject, firstEmail.body));
        const draftRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ message: { raw } }),
        });
        if (draftRes.ok) {
          const draftData = (await draftRes.json()) as { id: string };
          draftId = draftData.id;
        }
      } else if (liveProvider === "MICROSOFT_365") {
        const draftRes = await fetch("https://graph.microsoft.com/v1.0/me/messages", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            subject: firstEmail.subject,
            body: { contentType: "Text", content: firstEmail.body },
            toRecipients: [{ emailAddress: { address: toAddress } }],
          }),
        });
        if (draftRes.ok) {
          const draftData = (await draftRes.json()) as { id: string };
          draftId = draftData.id;
        }
      }

      drafts.push({
        to: toAddress,
        subject: firstEmail.subject,
        body: firstEmail.body,
        provider: liveProvider,
        draftId,
        sequenceStep: firstEmail.sequenceStep,
        prospectDomain: seq.prospectDomain,
      });
    }
  }

  const output: Record<string, unknown> = {
    ...claudeOutput,
    drafts,
    source: emailSource,
    generatedAt: new Date().toISOString(),
    workspaceId: run.agentConfig.workspaceId,
  };

  if (emailSource === "simulation") {
    output.simulationNote =
      "Connect Gmail or Microsoft 365 in Settings to send these sequences directly. All follow-ups pause automatically on reply.";
  }

  // Sonnet 5 pricing: $3/M input, $15/M output
  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  return { output, costUsd };
};

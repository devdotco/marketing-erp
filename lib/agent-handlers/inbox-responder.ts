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

// Extract bare email address from "Name <email@domain>" or plain address
function extractEmailAddress(from: string): string {
  const angleMatch = from.match(/<([^>]+)>/);
  if (angleMatch) return angleMatch[1];
  const plainMatch = from.match(/\S+@\S+/);
  return plainMatch ? plainMatch[0] : from;
}

export const inboxResponderHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");
  const config = (run.agentConfig.config ?? {}) as Record<string, unknown>;

  const emailAccount = (config.emailAccount as string) ?? "Gmail";
  const autoCategories = (config.autoCategories as string) ?? "All";
  const draftReplyStyle = (config.draftReplyStyle as string) ?? "Professional";
  const flagKeywords = (config.flagKeywords as string) ?? "Not specified";
  const dailyBatchSize = (config.dailyBatchSize as number) ?? 20;

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  // --- Live email integration: fetch unread inbox messages ---
  interface InboxMessage {
    id: string;
    subject: string;
    from: string;
  }

  let liveMessages: InboxMessage[] = [];
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

      const listRes = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=20",
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (listRes.ok) {
        const listData = (await listRes.json()) as { messages?: { id: string }[] };
        // Fetch metadata only (subject + from header) — full body never fetched for privacy
        for (const msg of (listData.messages ?? []).slice(0, 20)) {
          const detailRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          if (detailRes.ok) {
            const detail = (await detailRes.json()) as {
              payload?: { headers?: { name: string; value: string }[] };
            };
            const headers = detail.payload?.headers ?? [];
            const subject = headers.find((h) => h.name === "Subject")?.value ?? "(no subject)";
            const from = headers.find((h) => h.name === "From")?.value ?? "(unknown sender)";
            liveMessages.push({ id: msg.id, subject, from });
          }
        }
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

      const listRes = await fetch(
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=20&$filter=isRead eq false&$select=id,subject,from",
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (listRes.ok) {
        const listData = (await listRes.json()) as {
          value?: {
            id: string;
            subject: string;
            from: { emailAddress: { name: string; address: string } };
          }[];
        };
        liveMessages = (listData.value ?? []).map((m) => ({
          id: m.id,
          subject: m.subject,
          from: `${m.from.emailAddress.name} <${m.from.emailAddress.address}>`,
        }));
        emailSource = "live";
      }
    } catch {
      // Fall through to simulation
    }
  }

  // --- Claude: triage or simulate ---
  const systemPrompt = `You are an executive email assistant. Distinguish genuine business inquiries from mass outreach. Never draft a reply to an obvious pitch. Flag emails that might be time-sensitive even if they seem routine (finance, legal, from existing clients). All drafted replies stay as drafts — never send autonomously.

Respond ONLY with a valid JSON object. No markdown, no explanations outside the JSON.`;

  let userPrompt: string;

  if (emailSource === "live" && liveMessages.length > 0) {
    const messageList = liveMessages
      .map((m, i) => `${i + 1}. id:${m.id} | From: ${m.from} | Subject: ${m.subject}`)
      .join("\n");

    userPrompt = `Triage this real inbox batch for:

Business: ${businessProfile?.businessName ?? "The client"}
Industry: ${businessProfile?.industry ?? "General"}
Website: ${businessProfile?.websiteUrl ?? "Not specified"}
Draft Reply Style: ${draftReplyStyle}
Flag Keywords: ${flagKeywords}

Unread messages (subject + sender only — full message body is not available; do not infer content beyond what is shown):
${messageList}

Categorize each message as genuine_inquiry, pitch, newsletter, or spam.
Draft replies ONLY for genuine_inquiry items. All replies are drafts — never instruct sending.
Include the message id field on each entry so replies can be threaded.

Return a JSON object with this exact structure:
{
  "processed": number,
  "categories": {
    "genuineInquiries": [
      {
        "messageId": string,
        "subject": string,
        "from": string,
        "summary": string,
        "urgency": "high" | "medium" | "low",
        "category": string,
        "draftReply": string,
        "requiresHumanReview": boolean,
        "suggestedAction": string
      }
    ],
    "pitches": [
      {
        "messageId": string,
        "subject": string,
        "from": string,
        "summary": string,
        "recommendation": "ignore" | "decline" | "consider"
      }
    ],
    "flagged": [
      {
        "messageId": string,
        "subject": string,
        "from": string,
        "reason": string,
        "suggestedAction": string
      }
    ],
    "newsletters": number,
    "automated": number
  },
  "draftsCreated": number
}`;
  } else {
    userPrompt = `Simulate processing an inbox batch for:

Business: ${businessProfile?.businessName ?? "The client"}
Industry: ${businessProfile?.industry ?? "General"}
Website: ${businessProfile?.websiteUrl ?? "Not specified"}
Target Audience: ${businessProfile?.targetAudience ?? "Not specified"}
Brand Voice: ${businessProfile?.brandVoice ?? "Not specified"}
Goals: ${businessProfile?.goals ? JSON.stringify(businessProfile.goals) : "Not specified"}

Inbox Configuration:
- Email Account: ${emailAccount}
- Categories to Process: ${autoCategories}
- Draft Reply Style: ${draftReplyStyle}
- Flag Keywords: ${flagKeywords}
- Daily Batch Size: ${dailyBatchSize}

Since no live inbox is connected, simulate a realistic batch of ${dailyBatchSize} emails for this business type. Generate a realistic mix of genuine inquiries, pitches, flagged emails, newsletters, and automated messages. Draft replies only for genuineInquiries where requiresHumanReview is false.

Return a JSON object with this exact structure:
{
  "processed": number,
  "categories": {
    "genuineInquiries": [
      {
        "subject": string,
        "from": string,
        "summary": string,
        "urgency": "high" | "medium" | "low",
        "category": string,
        "draftReply": string,
        "requiresHumanReview": boolean,
        "suggestedAction": string
      }
    ],
    "pitches": [
      {
        "subject": string,
        "from": string,
        "summary": string,
        "recommendation": "ignore" | "decline" | "consider"
      }
    ],
    "flagged": [
      {
        "subject": string,
        "from": string,
        "reason": string,
        "suggestedAction": string
      }
    ],
    "newsletters": number,
    "automated": number
  },
  "draftsCreated": number
}`;
  }

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

  // --- Create reply drafts in Gmail or M365 for genuine_inquiry items — never auto-send ---
  if (emailSource === "live" && liveProvider && accessToken) {
    const categories = (output.categories as Record<string, unknown>) ?? {};
    const genuineInquiries = (categories.genuineInquiries as Array<{
      messageId?: string;
      from: string;
      subject: string;
      draftReply?: string;
      requiresHumanReview?: boolean;
    }>) ?? [];

    let draftsCreated = 0;
    for (const inquiry of genuineInquiries) {
      if (!inquiry.draftReply) continue;

      const replyToAddress = extractEmailAddress(inquiry.from);
      const replySubject = inquiry.subject.startsWith("Re:") ? inquiry.subject : `Re: ${inquiry.subject}`;

      if (liveProvider === "GMAIL") {
        const raw = toBase64Url(buildRfc2822(replyToAddress, replySubject, inquiry.draftReply));
        const draftRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ message: { raw } }),
        });
        if (draftRes.ok) draftsCreated++;
      } else if (liveProvider === "MICROSOFT_365") {
        const draftRes = await fetch("https://graph.microsoft.com/v1.0/me/messages", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            subject: replySubject,
            body: { contentType: "Text", content: inquiry.draftReply },
            toRecipients: [{ emailAddress: { address: replyToAddress } }],
          }),
        });
        if (draftRes.ok) draftsCreated++;
      }
    }

    if (draftsCreated > 0) {
      output.draftsCreated = draftsCreated;
    }
  }

  output.source = emailSource;
  output.generatedAt = new Date().toISOString();
  output.workspaceId = run.agentConfig.workspaceId;

  if (emailSource === "simulation") {
    output.simulationNote =
      "Connect Gmail or Microsoft 365 in Settings to process real inbox messages. All drafts require your review before sending.";
  }

  const requireApproval = config.requireApproval !== false;
  if (requireApproval) {
    await updateStatus("AWAITING_APPROVAL", output);
  }

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const costUsd = (inputTokens * 0.8 + outputTokens * 4) / 1_000_000;

  return { output, costUsd };
};

import type { AgentHandler } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { textFrom } from "@/lib/ai/extract";
import { lines, num, resolveInputs, str } from "@/lib/agents/inputs";
import { AgentInputError } from "@/lib/ai/errors";
import { applyRenamedInputs } from "./renamed-inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { googleCredentials } from "@/lib/integrations/google";
import { microsoftCredentials } from "@/lib/integrations/microsoft";

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

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  // Old names from before the form and handler were reconciled — see renamed-inputs.ts.
  applyRenamedInputs(run, config, {
    emailProvider: "emailAccount",
    replyTone: "draftReplyStyle",
  });
  const emailAccount = str(config, "emailProvider", "Gmail");
  const inboxLabel = str(config, "inboxLabel");
  const knowledgeBaseUrl = str(config, "knowledgeBaseUrl");
  const highPriorityDomains = lines(config, "highPriorityDomains", 50).map((d) => d.replace(/^@/, "").toLowerCase());
  const excludeCategory = str(config, "excludeCategories", "None");
  const autoCategories = excludeCategory === "None" ? "All" : `All except ${excludeCategory}`;
  const draftReplyStyle = str(config, "replyTone", "Professional");
  const flagKeywords = lines(config, "flagKeywords", 50).join(", ") || "Not specified";
  const dailyBatchSize = Math.round(num(config, "dailyBatchSize", 20, { min: 1, max: 50 }));

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

  // The selected Email Provider is tried first; the other one only when the selected one isn't
  // connected, so a workspace with a single connected inbox keeps working either way.
  const findIntegration = (provider: "GMAIL" | "MICROSOFT_365") =>
    prisma.integration.findUnique({
      where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider } },
    });
  let gmailIntegration: Awaited<ReturnType<typeof findIntegration>> = null;
  let m365Integration: Awaited<ReturnType<typeof findIntegration>> = null;
  if (emailAccount === "Microsoft 365") {
    m365Integration = await findIntegration("MICROSOFT_365");
    if (!m365Integration) gmailIntegration = await findIntegration("GMAIL");
  } else {
    gmailIntegration = await findIntegration("GMAIL");
    if (!gmailIntegration) m365Integration = await findIntegration("MICROSOFT_365");
  }

  // Only "not connected" falls back to simulation. Once an integration row
  // exists, a failed call is a real failure and must surface as one — it used
  // to be swallowed here and silently relabelled "simulation", which reads to
  // a user as "nothing is connected" when the truth is closer to "your Gmail
  // grant was revoked". googleCredentials()/microsoftCredentials() already
  // throw a legible, non-retryable message for an expired refresh token or a
  // revoked grant; API-call failures below throw the same way.
  if (gmailIntegration) {
    const creds = await googleCredentials(gmailIntegration);
    accessToken = creds.access_token;
    liveProvider = "GMAIL";

    // Inbox Label narrows the unread query to one Gmail label (quoted, so labels with spaces work).
    const gmailQuery = inboxLabel ? `is:unread label:"${inboxLabel.replace(/"/g, "")}"` : "is:unread";
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(gmailQuery)}&maxResults=${dailyBatchSize}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!listRes.ok) {
      throw new Error(
        `Gmail is connected but messages.list failed (HTTP ${listRes.status}): ${(await listRes.text()).slice(0, 300)} — reconnect Gmail on the Integrations page if this persists.`
      );
    }
    const listData = (await listRes.json()) as { messages?: { id: string }[] };
    // Fetch metadata only (subject + from header) — full body never fetched for privacy.
    // A single message's metadata failing to load doesn't invalidate the batch —
    // it's skipped and processing continues with what did load.
    for (const msg of (listData.messages ?? []).slice(0, dailyBatchSize)) {
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
  } else if (m365Integration) {
    const creds = await microsoftCredentials(m365Integration);
    accessToken = creds.access_token;
    liveProvider = "MICROSOFT_365";

    // Inbox Label names a mail folder; blank (or "Inbox") is the well-known inbox folder.
    let folderId = "inbox";
    if (inboxLabel && inboxLabel.toLowerCase() !== "inbox") {
      const folderRes = await fetch(
        `https://graph.microsoft.com/v1.0/me/mailFolders?$filter=${encodeURIComponent(`displayName eq '${inboxLabel.replace(/'/g, "''")}'`)}&$select=id`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!folderRes.ok) {
        throw new Error(
          `Microsoft 365 is connected but looking up the folder "${inboxLabel}" failed (Graph HTTP ${folderRes.status}): ${(await folderRes.text()).slice(0, 300)} — reconnect Microsoft 365 on the Integrations page if this persists.`
        );
      }
      const folders = (await folderRes.json()) as { value?: { id: string }[] };
      if (!folders.value?.[0]?.id) {
        throw new AgentInputError(
          `No top-level Microsoft 365 mail folder is named "${inboxLabel}".`,
          "Check the Inbox Label or Folder field against the folder name in Outlook, or leave it blank to process the inbox.",
          "m365_folder_not_found",
        );
      }
      folderId = folders.value[0].id;
    }
    const listRes = await fetch(
      `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(folderId)}/messages?$top=${dailyBatchSize}&$filter=isRead eq false&$select=id,subject,from`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!listRes.ok) {
      throw new Error(
        `Microsoft 365 is connected but listing inbox messages failed (Graph HTTP ${listRes.status}): ${(await listRes.text()).slice(0, 300)} — reconnect Microsoft 365 on the Integrations page if this persists.`
      );
    }
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

  // --- Claude: triage or simulate ---
  const systemPrompt = `You are an executive email assistant. Distinguish genuine business inquiries from mass outreach. Never draft a reply to an obvious pitch. Flag emails that might be time-sensitive even if they seem routine (finance, legal, from existing clients). All drafted replies stay as drafts — never send autonomously.

Respond ONLY with a valid JSON object. No markdown, no explanations outside the JSON.`;

  const triageRules = [
    highPriorityDomains.length > 0
      ? `High-priority sender domains: ${highPriorityDomains.join(", ")} — any message from these domains goes in genuineInquiries with urgency "high" (or in flagged), never in pitches, newsletters, or automated.`
      : "",
    excludeCategory !== "None"
      ? `Skip ${excludeCategory.toLowerCase()} entirely: don't list, summarise, or draft for them — count them only.`
      : "",
    knowledgeBaseUrl
      ? `Our help docs live at ${knowledgeBaseUrl}. In replies to support or how-to questions, point the sender there rather than answering specifics you weren't given.`
      : "",
  ].filter(Boolean).join("\n");

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
${triageRules}

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
${triageRules}

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
    model: MODELS.fast,
    max_tokens: 4096,
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
    // A draft that fails to create doesn't invalidate the (already real)
    // triage above — but it must show up as a failure, not vanish. The old
    // code just dropped it: draftsCreated stayed accurate but silent, so a
    // 0-for-3 batch looked identical to "nothing needed a reply".
    const draftErrors: Array<{ messageId?: string; subject: string; error: string }> = [];
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
        if (draftRes.ok) {
          draftsCreated++;
        } else {
          draftErrors.push({
            messageId: inquiry.messageId,
            subject: inquiry.subject,
            error: `Gmail drafts.create HTTP ${draftRes.status}: ${(await draftRes.text()).slice(0, 200)}`,
          });
        }
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
        if (draftRes.ok) {
          draftsCreated++;
        } else {
          draftErrors.push({
            messageId: inquiry.messageId,
            subject: inquiry.subject,
            error: `Graph messages.create HTTP ${draftRes.status}: ${(await draftRes.text()).slice(0, 200)}`,
          });
        }
      }
    }

    if (draftsCreated > 0) {
      output.draftsCreated = draftsCreated;
    }
    if (draftErrors.length > 0) {
      output.draftErrors = draftErrors;
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

  const costUsd = estimateCostUsd(MODELS.fast, message.usage);

  return { output, costUsd };
};

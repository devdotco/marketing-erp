import type { AgentHandler } from "./index";
import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { estimateCostUsd, MODELS } from "@/lib/ai/models";
import { createMessage } from "@/lib/ai/messages";
import { resolveInputs, str, num, lines } from "@/lib/agents/inputs";
import { resolveAnthropic } from "@/lib/ai/client";
import { AgentInputError } from "@/lib/ai/errors";
import { strictSchema, asArray } from "@/lib/content/article";
import { listAimfoxAccounts, listAimfoxCampaigns } from "@/lib/integrations/aimfox";
import { enforceDailyCap, type EngagementAction, type LinkedinEngagerDelivery } from "./linkedin-engager-delivery";

/**
 * What Aimfox's API actually supports (see lib/integrations/aimfox.ts for the endpoint inventory
 * and sourcing): a connection request with a note, sent by adding a profile to a Campaign's
 * audience, and a direct message into a new or existing conversation. NOTHING for reading, liking,
 * or commenting on a LinkedIn post — that surface doesn't exist in Aimfox's API. So this agent
 * only ever automates connectionNote and message actions; a drafted comment is staged for
 * one-click MANUAL posting (copy the text, open the post) and is never sent by anything in this
 * codebase. The agent page's "never fully automated to avoid TOS risk" promise is enforced by
 * there being no auto-approve path at all — see the on-approve hook (linkedinEngagerOnApprove in
 * lib/agent-handlers/on-approve.ts), which is the only thing that ever calls Aimfox, and only
 * after a workspace admin approves the staged run. That mirrors Outbound LinkedIn, Outbound Email,
 * and Outbound Revenue — see lib/agent-handlers/outbound-linkedin.ts — none of which has a
 * `requireApproval` escape hatch either.
 *
 * Neither Aimfox nor any other connected integration can fetch an arbitrary person's LinkedIn
 * profile or an arbitrary post's content — there is no "read a target profile" or "read a post"
 * call anywhere in this codebase (Aimfox's API has no such endpoint; see lib/integrations/aimfox.ts).
 * So the raw material for a draft has to come from the person running the agent: a name and a
 * profile URL per target, or a post URL and a one-line description of what it says. Claude drafts
 * against that, never against live-fetched LinkedIn content.
 */

const SUBMIT_ENGAGEMENT_TOOL_NAME = "submit_engagement_queue";

export const SUBMIT_ENGAGEMENT_TOOL: Anthropic.Tool = {
  name: SUBMIT_ENGAGEMENT_TOOL_NAME,
  strict: true,
  description:
    "Submit the drafted LinkedIn engagement queue: one action per target you were given, each carrying the exact target identifier you were handed so it can be matched back up.",
  input_schema: strictSchema({
    type: "object",
    required: ["actions", "strategyNote"],
    properties: {
      actions: {
        type: "array",
        description: "One entry per target. Skip a target only if there is genuinely nothing worth saying.",
        minItems: 1,
        items: {
          type: "object",
          required: ["kind", "targetProfileUrl", "targetPostUrl", "text"],
          properties: {
            kind: {
              type: "string",
              enum: ["connectionNote", "message", "comment"],
              description: "Which list this target came from.",
            },
            targetProfileUrl: {
              type: "string",
              description: "Copied EXACTLY from the connection/message target list. Empty string for a comment action.",
            },
            targetPostUrl: {
              type: "string",
              description: "Copied EXACTLY from the post list. Empty string for a connectionNote/message action.",
            },
            text: {
              type: "string",
              description:
                "connectionNote: under 300 characters, no pitch. message: under 500 characters, opens or continues a real conversation. comment: a substantive reply to the post, ready to paste as-is.",
            },
          },
        },
      },
      strategyNote: { type: "string", description: "One or two sentences on the angle taken across the queue." },
    },
  }),
};

interface TargetProfile {
  name: string;
  url: string;
}

interface TargetPost {
  url: string;
  context: string;
}

/** "Full Name, https://linkedin.com/in/handle" per line. Tolerates a bare URL with no name. */
function parseProfileTargets(raw: string): TargetProfile[] {
  const out: TargetProfile[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const commaIdx = trimmed.lastIndexOf(",");
    const url = (commaIdx >= 0 ? trimmed.slice(commaIdx + 1) : trimmed).trim();
    const name = commaIdx >= 0 ? trimmed.slice(0, commaIdx).trim() : "";
    if (!/^https?:\/\/.*linkedin\.com/i.test(url)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: name || "there", url });
  }
  return out;
}

/** "https://linkedin.com/posts/..., what it's about" per line. */
function parsePostTargets(raw: string): TargetPost[] {
  const out: TargetPost[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const commaIdx = trimmed.indexOf(",");
    const url = (commaIdx >= 0 ? trimmed.slice(0, commaIdx) : trimmed).trim();
    const context = commaIdx >= 0 ? trimmed.slice(commaIdx + 1).trim() : "";
    if (!/^https?:\/\/.*linkedin\.com/i.test(url)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, context });
  }
  return out;
}

export const linkedinEngagerHandler: AgentHandler = async (run, updateStatus) => {
  await updateStatus("RUNNING");

  // Runs on the workspace's own Anthropic key (see lib/ai/client.ts).
  const { client } = await resolveAnthropic(run.agentConfig.workspaceId);
  const config = resolveInputs(run);

  const aimfoxAccountId = str(config, "aimfoxAccountId");
  const campaignName = str(config, "campaignName", "LinkedIn Engager - Connections");
  const connectionTargets = parseProfileTargets(str(config, "connectionProfiles"));
  const messageTargets = parseProfileTargets(str(config, "messageProfiles"));
  const postTargets = parsePostTargets(str(config, "postsToComment"));
  const engagementTone = str(config, "engagementTone", "Insightful");
  const engagementGuidelines = str(config, "engagementGuidelines");
  const dailyCap = num(config, "dailyCap", 15, { min: 1, max: 25 });

  if (connectionTargets.length === 0 && messageTargets.length === 0 && postTargets.length === 0) {
    throw new AgentInputError(
      "No connection targets, message targets, or posts to comment on were given.",
      "Add at least one LinkedIn profile URL (Connection Targets or Message Targets) or post URL (Posts to Comment On) before running this agent.",
      "no_targets",
    );
  }

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { workspaceId: run.agentConfig.workspaceId },
  });

  const aimfoxIntegration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: run.agentConfig.workspaceId, provider: "AIMFOX" } },
  });
  const connected = Boolean(aimfoxIntegration);

  // ---------------------------------------------------------------------------
  // Read-only validation against Aimfox while staging — no write ever happens here. Mirrors
  // lib/agent-handlers/outbound-linkedin.ts's resolveAimfoxCampaignId.
  // ---------------------------------------------------------------------------
  let resolvedAccountId = aimfoxAccountId;
  let campaignId: string | undefined;

  if (connected) {
    const creds = await decryptCredentials<{ apiKey: string }>(aimfoxIntegration!.encryptedCredentials);

    if (messageTargets.length > 0) {
      let accounts: Awaited<ReturnType<typeof listAimfoxAccounts>>;
      try {
        accounts = await listAimfoxAccounts(creds.apiKey);
      } catch (err) {
        throw new AgentInputError(
          "Couldn't reach Aimfox to validate the sending account.",
          "This is usually transient — try running LinkedIn Engager again.",
          "aimfox_unreachable",
        );
      }
      if (accounts.length === 0) {
        throw new AgentInputError(
          "The connected Aimfox workspace has no LinkedIn seats (accounts) on it.",
          "Connect a LinkedIn account inside Aimfox first, then try again.",
          "aimfox_no_accounts",
        );
      }
      const match = aimfoxAccountId
        ? accounts.find((a) => a.id === aimfoxAccountId)
        : accounts[0];
      if (!match) {
        throw new AgentInputError(
          `No Aimfox account "${aimfoxAccountId}" exists in this workspace's Aimfox account.`,
          `Use one of the connected account ids: ${accounts.map((a) => a.id).join(", ")}.`,
          "aimfox_account_not_found",
        );
      }
      resolvedAccountId = match.id;
    }

    if (connectionTargets.length > 0) {
      let campaigns: Awaited<ReturnType<typeof listAimfoxCampaigns>>;
      try {
        campaigns = await listAimfoxCampaigns(creds.apiKey);
      } catch (err) {
        throw new AgentInputError(
          "Couldn't reach Aimfox to look up the connection-request campaign.",
          "This is usually transient — try running LinkedIn Engager again.",
          "aimfox_unreachable",
        );
      }
      const match =
        campaigns.find((c) => c.name === campaignName) ??
        campaigns.find((c) => c.name.toLowerCase().includes("engager"));
      if (!match) {
        throw new AgentInputError(
          `No Aimfox campaign named "${campaignName}" exists in this workspace's Aimfox account.`,
          `Create a "connect"-type campaign in Aimfox named "${campaignName}" (or rename an existing one to include "engager"), then run this agent again.`,
          "aimfox_campaign_not_found",
        );
      }
      campaignId = match.id;
    }
  }

  // ---------------------------------------------------------------------------
  // Drafting — one Claude call, no network writes. See the module docstring for why every action
  // is grounded only in what the user typed (no live profile or post fetch exists to ground it in
  // anything else).
  // ---------------------------------------------------------------------------
  const businessContext = businessProfile
    ? [
        (businessProfile as { companyName?: string }).companyName ? `Company: ${(businessProfile as { companyName?: string }).companyName}` : "",
        (businessProfile as { industry?: string }).industry ? `Industry: ${(businessProfile as { industry?: string }).industry}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const system = [
    "You draft LinkedIn engagement actions for a real person's own account. They read exactly as written, so nothing generic, nothing that reads as templated or automated.",
    `Tone: ${engagementTone}.`,
    "connectionNote: no pitch, no \"I'd love to connect\" language, references something specific about the person.",
    "message: opens or continues a real conversation, ends with a genuine question, never salesy.",
    "comment: adds a real opinion, a fact, or a question to the post — never \"Great post!\" or agreement with nothing behind it.",
    engagementGuidelines ? `Additional guidelines: ${engagementGuidelines}` : "",
    businessContext ? `Business context:\n${businessContext}` : "",
    "Copy targetProfileUrl / targetPostUrl EXACTLY as given — these are used in code to match your draft back to the right target and a mismatch drops the action entirely.",
    "Return ONLY the submit_engagement_queue tool call.",
  ]
    .filter(Boolean)
    .join("\n");

  const userPrompt = [
    connectionTargets.length > 0
      ? `CONNECTION TARGETS (kind: connectionNote) — send a connection request note to each:\n${connectionTargets.map((t) => `- ${t.name} — ${t.url}`).join("\n")}`
      : "",
    messageTargets.length > 0
      ? `MESSAGE TARGETS (kind: message) — this person is already an accepted connection or existing lead; draft a message to each:\n${messageTargets.map((t) => `- ${t.name} — ${t.url}`).join("\n")}`
      : "",
    postTargets.length > 0
      ? `POSTS TO COMMENT ON (kind: comment) — draft one comment for each, for the person to paste in manually:\n${postTargets.map((t) => `- ${t.url}${t.context ? ` — ${t.context}` : ""}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const message = await createMessage(client, {
    model: MODELS.standard,
    max_tokens: 4096,
    system,
    tools: [SUBMIT_ENGAGEMENT_TOOL],
    tool_choice: { type: "tool", name: SUBMIT_ENGAGEMENT_TOOL_NAME },
    messages: [{ role: "user", content: userPrompt }],
  });

  const costUsd = estimateCostUsd(MODELS.standard, message.usage);

  const block = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === SUBMIT_ENGAGEMENT_TOOL_NAME,
  );
  if (!block) throw new Error("LinkedIn Engager's drafting call did not submit an engagement queue.");

  const submitted = block.input as { actions?: unknown; strategyNote?: string };
  const rawActions = asArray<{ kind?: unknown; targetProfileUrl?: unknown; targetPostUrl?: unknown; text?: unknown }>(
    submitted.actions,
  );

  // Defensive matching (see lib/*/anthropic-strict-tool-use note): trust the TARGET LIST this
  // code built, never the model's own `kind` claim — a drafted action is only kept if its echoed
  // URL matches a real target verbatim, and each target can produce at most one action.
  const connectionByUrl = new Map(connectionTargets.map((t) => [t.url.toLowerCase(), t]));
  const messageByUrl = new Map(messageTargets.map((t) => [t.url.toLowerCase(), t]));
  const postByUrl = new Map(postTargets.map((t) => [t.url.toLowerCase(), t]));
  const claimedUrls = new Set<string>();

  const actions: EngagementAction[] = [];
  let idCounter = 0;
  for (const raw of rawActions) {
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    if (!text) continue;
    const profileUrl = typeof raw.targetProfileUrl === "string" ? raw.targetProfileUrl.trim().toLowerCase() : "";
    const postUrl = typeof raw.targetPostUrl === "string" ? raw.targetPostUrl.trim().toLowerCase() : "";

    if (profileUrl && connectionByUrl.has(profileUrl) && !claimedUrls.has(`c:${profileUrl}`)) {
      claimedUrls.add(`c:${profileUrl}`);
      const target = connectionByUrl.get(profileUrl)!;
      actions.push({
        id: `action_${idCounter++}`,
        type: "connectionNote",
        targetName: target.name,
        targetProfileUrl: target.url,
        text,
        status: "pending",
      });
    } else if (profileUrl && messageByUrl.has(profileUrl) && !claimedUrls.has(`m:${profileUrl}`)) {
      claimedUrls.add(`m:${profileUrl}`);
      const target = messageByUrl.get(profileUrl)!;
      actions.push({
        id: `action_${idCounter++}`,
        type: "message",
        targetName: target.name,
        targetProfileUrl: target.url,
        text,
        status: "pending",
      });
    } else if (postUrl && postByUrl.has(postUrl) && !claimedUrls.has(`p:${postUrl}`)) {
      claimedUrls.add(`p:${postUrl}`);
      const target = postByUrl.get(postUrl)!;
      actions.push({
        id: `action_${idCounter++}`,
        type: "comment",
        targetName: target.url,
        targetPostUrl: target.url,
        text,
        status: "manual", // never sent by anything in this codebase — see module docstring.
      });
    }
    // else: unmatched — dropped rather than trusted. See the strict-tool-use defensive note.
  }

  if (actions.length === 0) {
    throw new Error(
      "LinkedIn Engager's drafting call returned no action whose target matched what was actually given — try running again.",
    );
  }

  const cappedActions = enforceDailyCap(actions, dailyCap);

  const delivery: LinkedinEngagerDelivery = {
    connected,
    accountId: resolvedAccountId,
    campaignName,
    campaignId,
    actions: cappedActions,
    dailyCap,
  };

  const automatedCount = cappedActions.filter((a) => a.type === "connectionNote" || a.type === "message").length;
  const manualCount = cappedActions.filter((a) => a.type === "comment").length;

  const output: Record<string, unknown> = {
    actions: cappedActions,
    automatedCount,
    manualCount,
    droppedCount: actions.length - cappedActions.length,
    strategyNote: submitted.strategyNote ?? "",
    delivery,
    generatedAt: new Date().toISOString(),
    workspaceId: run.agentConfig.workspaceId,
    howItWorks: connected
      ? `Connection notes are sent by adding the profile to the Aimfox campaign "${campaignName}"; direct messages are sent through the connected Aimfox account. Neither happens until you approve this run — approving is what sends them. Comments are drafted for you to paste onto the post by hand; Aimfox's API has no way to post a comment or a like, so this agent never attempts to automate that.`
      : `No Aimfox integration is connected, so approving this run will record a simulated send instead of a real one — connect Aimfox in Settings → Integrations to send for real. Comments are always manual regardless of connection status.`,
    approvalNote:
      "Nothing is sent to LinkedIn until a workspace admin approves this run — there is no auto-approve mode for this agent.",
  };

  await updateStatus("AWAITING_APPROVAL", output);
  return { output, costUsd };
};

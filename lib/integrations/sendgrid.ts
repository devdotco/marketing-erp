/**
 * SendGrid Marketing Campaigns for Email Marketing's campaign types.
 *
 * The write path is split on purpose, matching the approval gate:
 *  - a RUN creates a Single Send as a draft: no recipients, no send time. A
 *    draft with no `send_to` cannot go anywhere even if someone clicks in
 *    SendGrid by mistake.
 *  - APPROVAL attaches the campaign's lists/segments and schedules it.
 * Nothing here sends "now".
 *
 * Credentials (encrypted on the Integration row): apiKey, senderEmail (a
 * verified Marketing sender, e.g. hello@digital.marketing) and
 * suppressionGroupId. A Single Send must carry a suppression group or a custom
 * unsubscribe URL, and the {{{unsubscribe}}} tags in our templates resolve
 * against the group. Same API surface Brigham uses live
 * (brigham-erp-io/src/lib/integrations/sendgrid-campaigns.ts).
 */
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { AgentInputError } from "@/lib/ai/errors";

const API = "https://api.sendgrid.com/v3";

export interface SendgridCredentials {
  apiKey: string;
  senderEmail: string;
  suppressionGroupId: string;
}

export class SendgridError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SendgridError";
  }
}

async function call<T>(apiKey: string, method: "GET" | "POST" | "PATCH" | "PUT", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error body
  }
  if (!res.ok) {
    const errs = (json as { errors?: { message?: string; field?: string }[] } | null)?.errors;
    throw new SendgridError(
      errs?.map((e) => `${e.field ? `${e.field}: ` : ""}${e.message}`).join("; ") || `SendGrid answered HTTP ${res.status}`,
      res.status,
    );
  }
  return json as T;
}

export interface SendgridSender {
  id: number;
  nickname: string;
  email: string;
  verified: boolean;
}

export async function listSenders(apiKey: string): Promise<SendgridSender[]> {
  const rows = await call<{ id: number; nickname: string; from?: { email?: string }; verified?: { status?: boolean } }[]>(apiKey, "GET", "/marketing/senders");
  return (rows ?? []).map((x) => ({ id: x.id, nickname: x.nickname, email: x.from?.email ?? "", verified: !!x.verified?.status }));
}

export interface SendgridAudience {
  id: string;
  name: string;
  contacts: number;
  kind: "list" | "segment";
}

export async function listAudiences(apiKey: string): Promise<SendgridAudience[]> {
  const [lists, segments] = await Promise.all([
    call<{ result?: { id: string; name: string; contact_count?: number }[] }>(apiKey, "GET", "/marketing/lists?page_size=1000"),
    call<{ results?: { id: string; name: string; contacts_count?: number }[] }>(apiKey, "GET", "/marketing/segments/2.0"),
  ]);
  return [
    ...(lists?.result ?? []).map((x) => ({ id: x.id, name: x.name, contacts: x.contact_count ?? 0, kind: "list" as const })),
    ...(segments?.results ?? []).map((x) => ({ id: x.id, name: x.name, contacts: x.contacts_count ?? 0, kind: "segment" as const })),
  ];
}

export async function listSuppressionGroups(apiKey: string): Promise<{ id: number; name: string }[]> {
  const rows = await call<{ id: number; name: string }[]>(apiKey, "GET", "/asm/groups");
  return (rows ?? []).map((g) => ({ id: g.id, name: g.name }));
}

/** The verified sender id for the configured address. Refuses legibly rather than letting SendGrid 400. */
export async function resolveSenderId(creds: SendgridCredentials): Promise<number> {
  const senders = await listSenders(creds.apiKey);
  const want = creds.senderEmail.trim().toLowerCase();
  const match = senders.find((s) => s.email.toLowerCase() === want);
  if (!match) {
    throw new AgentInputError(
      `SendGrid has no Marketing sender for ${creds.senderEmail}.`,
      "Add it under Marketing → Senders in SendGrid, or change the sender address on the SendGrid integration.",
      "sendgrid_sender_missing",
    );
  }
  if (!match.verified) {
    throw new AgentInputError(
      `The SendGrid sender ${creds.senderEmail} is not verified yet.`,
      "Finish verification in SendGrid (Marketing → Senders), then run again.",
      "sendgrid_sender_unverified",
    );
  }
  return match.id;
}

export interface SingleSend {
  id: string;
  name: string;
  status: string;
  send_at?: string | null;
  send_to?: { list_ids?: string[]; segment_ids?: string[]; all?: boolean };
}

export interface DraftInput {
  name: string;
  subject: string;
  html: string;
  senderId: number;
  suppressionGroupId: number;
  categories?: string[];
}

/** A draft Single Send with NO recipients and NO send time. */
export async function createDraftSingleSend(apiKey: string, d: DraftInput): Promise<SingleSend> {
  const r = await call<SingleSend>(apiKey, "POST", "/marketing/singlesends", {
    name: d.name.slice(0, 100),
    categories: d.categories?.slice(0, 10),
    send_to: { list_ids: [], segment_ids: [], all: false },
    email_config: {
      subject: d.subject,
      html_content: d.html,
      generate_plain_content: true,
      editor: "code",
      sender_id: d.senderId,
      suppression_group_id: d.suppressionGroupId,
    },
  });
  if (r.status !== "draft") throw new SendgridError(`SendGrid created it with status "${r.status}", not "draft".`);
  return r;
}

export async function getSingleSend(apiKey: string, id: string): Promise<SingleSend> {
  return call<SingleSend>(apiKey, "GET", `/marketing/singlesends/${encodeURIComponent(id)}`);
}

/** Attach the audience (and the subject the approver picked) to a draft. */
export async function prepareSingleSend(
  apiKey: string,
  id: string,
  update: { name: string; subject: string; listIds: string[]; segmentIds: string[] },
): Promise<SingleSend> {
  return call<SingleSend>(apiKey, "PATCH", `/marketing/singlesends/${encodeURIComponent(id)}`, {
    name: update.name.slice(0, 100),
    send_to: { list_ids: update.listIds, segment_ids: update.segmentIds, all: false },
    email_config: { subject: update.subject },
  });
}

export async function scheduleSingleSend(apiKey: string, id: string, sendAt: Date): Promise<{ status: string; send_at: string }> {
  return call<{ status: string; send_at: string }>(apiKey, "PUT", `/marketing/singlesends/${encodeURIComponent(id)}/schedule`, {
    send_at: sendAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
}

/** The workspace's SendGrid credentials, or a legible refusal before any tokens are spent. */
export async function requireSendgrid(workspaceId: string): Promise<SendgridCredentials> {
  const integration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId, provider: "SENDGRID" } },
  });
  if (!integration) {
    throw new AgentInputError(
      "SendGrid isn't connected for this workspace.",
      "Connect SendGrid under Integrations (API key, sender address and suppression group), then run again.",
      "sendgrid_not_connected",
    );
  }
  const creds = await decryptCredentials<SendgridCredentials>(integration.encryptedCredentials);
  if (!creds.apiKey || !creds.senderEmail || !creds.suppressionGroupId) {
    throw new AgentInputError(
      "The SendGrid integration is missing its sender address or suppression group.",
      "Reconnect SendGrid under Integrations and fill in every field.",
      "sendgrid_incomplete",
    );
  }
  return creds;
}

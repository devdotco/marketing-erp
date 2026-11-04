import type { KeyVerifier } from "./types";
import { listSenders, listSuppressionGroups, SendgridError } from "@/lib/integrations/sendgrid";

/**
 * SendGrid. Two free, read-only calls: the Marketing senders (proves the key
 * has Marketing access and the sender exists and is verified) and the
 * unsubscribe groups (proves the group id is real). Catching both here turns
 * what would be a Monday-night failed draft into a form error.
 */
const verifySendgrid: KeyVerifier = async (credentials) => {
  const apiKey = credentials.apiKey?.trim();
  if (!apiKey) return { ok: false, reason: "The API key is empty." };

  try {
    const senders = await listSenders(apiKey);
    const sender = senders.find((s) => s.email.toLowerCase() === credentials.senderEmail?.toLowerCase());
    if (!sender) {
      return { ok: false, reason: `SendGrid has no Marketing sender for ${credentials.senderEmail}. Add it under Marketing → Senders first.` };
    }
    if (!sender.verified) return { ok: false, reason: `The sender ${sender.email} exists in SendGrid but is not verified yet.` };

    const groups = await listSuppressionGroups(apiKey);
    if (!groups.some((g) => String(g.id) === credentials.suppressionGroupId)) {
      return {
        ok: false,
        reason: `No unsubscribe group ${credentials.suppressionGroupId}. This account has: ${groups.map((g) => `${g.id} (${g.name})`).join(", ") || "none"}.`,
      };
    }
  } catch (err) {
    if (err instanceof SendgridError && (err.status === 401 || err.status === 403)) {
      return { ok: false, reason: "SendGrid rejected that key, or it lacks Marketing and Suppressions access." };
    }
    return { ok: false, reason: `Couldn't reach SendGrid: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true };
};

export const VERIFIERS = { SENDGRID: verifySendgrid };

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { AgentInputError } from "@/lib/ai/errors";
import { MODELS } from "@/lib/ai/models";

export type KeySource = "workspace" | "platform";

export interface ResolvedAnthropic {
  client: Anthropic;
  source: KeySource;
  /** Safe to show a person: the last four characters, never the key. */
  keyHint: string;
}

/** Per-request memo. A run makes many calls and should not re-decrypt each time. */
const cache = new Map<string, { at: number; resolved: ResolvedAnthropic }>();
const TTL_MS = 60_000;

export function forgetAnthropicKey(workspaceId: string): void {
  cache.delete(workspaceId);
}

/**
 * The Anthropic client a workspace's work runs on.
 *
 * Bring-your-own-key, and the key is the workspace's by default. Model spend for
 * a tenant's articles belongs on the tenant's account, not on ours — which also
 * means their rate limits, their usage dashboard, and their own control over
 * what the key can do.
 *
 * Order, and there is deliberately no silent fallback at the end:
 *   1. The workspace's own ANTHROPIC integration.
 *   2. The platform key, but ONLY for a workspace explicitly allowed it
 *      (`allowPlatformKey`, super-admin only). That is for workspaces we
 *      operate ourselves.
 *   3. Refuse, before a single token is spent, with a message that says what to
 *      do about it.
 *
 * The third case is the important one. A missing key that quietly falls through
 * to the platform account is a billing leak that nobody notices until the
 * invoice arrives.
 */
export async function resolveAnthropic(workspaceId: string): Promise<ResolvedAnthropic> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.resolved;

  const [integration, workspace] = await Promise.all([
    prisma.integration.findUnique({
      where: { workspaceId_provider: { workspaceId, provider: "ANTHROPIC" } },
    }),
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { allowPlatformKey: true, name: true },
    }),
  ]);

  let resolved: ResolvedAnthropic | null = null;

  if (integration) {
    const creds = await decryptCredentials<{ apiKey?: string }>(integration.encryptedCredentials);
    const apiKey = creds.apiKey?.trim();
    if (apiKey) {
      resolved = {
        client: new Anthropic({ apiKey }),
        source: "workspace",
        keyHint: hintFor(apiKey),
      };
    }
  }

  if (!resolved && workspace?.allowPlatformKey) {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (apiKey) {
      resolved = { client: new Anthropic({ apiKey }), source: "platform", keyHint: hintFor(apiKey) };
    }
  }

  if (!resolved) {
    throw new AgentInputError(
      `${workspace?.name ?? "This workspace"} has no Anthropic API key connected, so agents cannot run.`,
      "Add one under Settings → Integrations → Anthropic. Runs are billed to that key, so it stays on your own Anthropic account. No tokens were spent.",
      "no_api_key",
    );
  }

  cache.set(workspaceId, { at: Date.now(), resolved });
  return resolved;
}

function hintFor(apiKey: string): string {
  return `…${apiKey.slice(-4)}`;
}

/**
 * Check a key before we store it.
 *
 * A key that is wrong, revoked, or scoped away from the Messages API fails
 * identically to a stale model id at run time, and by then a person has queued
 * work and is waiting on it. One cheap call at save time turns that into a form
 * error.
 */
export async function verifyAnthropicKey(
  apiKey: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const trimmed = apiKey.trim();
  if (!trimmed) return { ok: false, reason: "The key is empty." };
  if (!trimmed.startsWith("sk-ant-")) {
    return { ok: false, reason: "That does not look like an Anthropic API key — they begin with \"sk-ant-\"." };
  }

  try {
    const probe = new Anthropic({ apiKey: trimmed });
    // Cheapest call that proves the key can actually reach the Messages API.
    // models.list would pass for a key with no inference access at all.
    await probe.messages.create({
      model: MODELS.fast,
      max_tokens: 1,
      messages: [{ role: "user", content: "." }],
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return { ok: false, reason: "Anthropic rejected that key. Check it was copied whole and has not been revoked." };
    }
    if (err instanceof Anthropic.PermissionDeniedError) {
      return { ok: false, reason: "That key is valid but not allowed to call the Messages API." };
    }
    if (err instanceof Anthropic.RateLimitError) {
      // The key works; the account is busy. Storing it is correct.
      return { ok: true };
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

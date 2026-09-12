import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";
import { AgentInputError } from "@/lib/ai/errors";
import { MODELS } from "@/lib/ai/models";

export type KeySource = "workspace" | "platform";

/**
 * Workspaces permitted to spend on the platform's own Anthropic key.
 *
 * Comma-separated slugs (ids are accepted too), from the environment. Unset or
 * empty means nobody — there is no default that grants it.
 *
 * This exists because the database flag alone was not safe. The BYOK migration
 * grandfathered every existing workspace to `allowPlatformKey = true` so that
 * shipping it would not stop production dead, and the effect was that other
 * people's workspaces were quietly running on our account. One UPDATE did that.
 * A second gate that lives in configuration means it now takes a deploy, not a
 * stray write or a misclick, to put anyone on our key.
 */
function platformAllowlist(): Set<string> {
  return new Set(
    (process.env.PLATFORM_KEY_WORKSPACES ?? "")
      .split(/[\s,]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Why a workspace can or cannot use the platform key. For the super-admin view. */
export type PlatformKeyEligibility =
  | { eligible: true }
  | { eligible: false; reason: "not_designated" | "toggle_off" | "no_platform_key" };

/** Whether this workspace is named in PLATFORM_KEY_WORKSPACES. Config, not data. */
export function isDesignatedForPlatformKey(workspace: { id: string; slug: string }): boolean {
  const allowlist = platformAllowlist();
  return allowlist.has(workspace.slug.toLowerCase()) || allowlist.has(workspace.id.toLowerCase());
}

export function platformKeyEligibility(workspace: {
  id: string;
  slug: string;
  allowPlatformKey: boolean;
}): PlatformKeyEligibility {
  if (!isDesignatedForPlatformKey(workspace)) return { eligible: false, reason: "not_designated" };
  if (!workspace.allowPlatformKey) return { eligible: false, reason: "toggle_off" };
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return { eligible: false, reason: "no_platform_key" };
  return { eligible: true };
}

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
 * Bring-your-own-key, and the key is the workspace's. Model spend for a tenant's
 * articles belongs on the tenant's account, not on ours — which also means their
 * rate limits, their usage dashboard, and their own control over what the key
 * can do.
 *
 * Order, and there is deliberately no silent fallback at the end:
 *   1. The workspace's own ANTHROPIC integration.
 *   2. The platform key, but only for a workspace that is BOTH named in
 *      PLATFORM_KEY_WORKSPACES and toggled on by a super admin. That is for
 *      workspaces we operate ourselves, and it takes a deploy to grant.
 *   3. Refuse, before a single token is spent, with a message that says what to
 *      do about it.
 *
 * The third case is the important one. A missing key that quietly falls through
 * to the platform account is a billing leak nobody notices until the invoice
 * arrives — and for a moment, it was exactly what was happening.
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
      select: { id: true, slug: true, allowPlatformKey: true, name: true },
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

  // Both gates, or neither. See platformAllowlist above for why one was not enough.
  if (!resolved && workspace && platformKeyEligibility(workspace).eligible) {
    const apiKey = process.env.ANTHROPIC_API_KEY!.trim();
    resolved = { client: new Anthropic({ apiKey }), source: "platform", keyHint: hintFor(apiKey) };
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

export type KeyStatus =
  | { ready: true; source: KeySource; keyHint: string }
  | { ready: false; reason: "no_key" };

/**
 * Can this workspace run an agent at all?
 *
 * The read-only counterpart to resolveAnthropic, for pages that need to ask
 * before anyone presses a button. Never throws: a workspace with no key is an
 * ordinary state with an answer, not an error.
 */
export async function getKeyStatus(workspaceId: string): Promise<KeyStatus> {
  try {
    const { source, keyHint } = await resolveAnthropic(workspaceId);
    return { ready: true, source, keyHint };
  } catch {
    return { ready: false, reason: "no_key" };
  }
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

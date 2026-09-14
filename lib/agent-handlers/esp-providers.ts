import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/crypto";

/**
 * Live Mailchimp/Klaviyo reads shared by email-marketing.ts and
 * newsletter.ts — both handlers ground their AI-written copy in the
 * account's actual recent-campaign performance when either ESP is
 * connected, then (separately, in each handler) create a draft with the
 * result.
 */

function mailchimpAuthHeader(apiKey: string): string {
  return "Basic " + Buffer.from(`anystring:${apiKey}`).toString("base64");
}

async function fetchMailchimpCampaigns(apiKey: string, server: string, count: number): Promise<unknown[]> {
  const res = await fetch(
    `https://${server}.api.mailchimp.com/3.0/campaigns?count=${count}&status=sent`,
    { headers: { Authorization: mailchimpAuthHeader(apiKey) }, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`Mailchimp campaigns ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { campaigns?: unknown[] };
  return data.campaigns ?? [];
}

async function fetchMailchimpAudiences(apiKey: string, server: string): Promise<unknown[]> {
  const res = await fetch(
    `https://${server}.api.mailchimp.com/3.0/lists`,
    { headers: { Authorization: mailchimpAuthHeader(apiKey) }, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`Mailchimp lists ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { lists?: unknown[] };
  return data.lists ?? [];
}

export async function createMailchimpDraft(
  apiKey: string,
  server: string,
  listId: string,
  subjectLine: string,
  title: string,
  fromName: string,
  replyTo: string,
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
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Mailchimp create draft ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { id?: string };
  return data.id ?? "";
}

// Klaviyo's API is revision-dated, not versioned. Its Campaigns endpoints were
// still in beta (GA planned) as of when this was written — pin and re-verify
// this against Settings → API Keys → API versioning in the Klaviyo dashboard
// before relying on it, since a beta endpoint's shape can move between
// revisions in ways a GA one won't.
const KLAVIYO_REVISION = "2025-04-15";

function klaviyoHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: KLAVIYO_REVISION,
    "Content-Type": "application/json",
  };
}

async function fetchKlaviyoCampaigns(apiKey: string, count: number): Promise<unknown[]> {
  const res = await fetch(
    `https://a.klaviyo.com/api/campaigns/?filter=equals(messages.channel,'email')&page[size]=${count}`,
    { headers: klaviyoHeaders(apiKey), signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`Klaviyo campaigns ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { data?: unknown[] };
  return (data.data ?? []).slice(0, count);
}

export async function createKlaviyoDraft(apiKey: string, name: string, audienceId?: string): Promise<string> {
  const res = await fetch(`https://a.klaviyo.com/api/campaigns/`, {
    method: "POST",
    headers: klaviyoHeaders(apiKey),
    body: JSON.stringify({
      data: {
        type: "campaign",
        attributes: {
          name,
          // An empty `included` list creates a campaign with no recipients —
          // Klaviyo accepts it, but the draft then needs manual audience
          // assignment before it can send. Attach the configured list/segment
          // ID when the caller has one.
          audiences: { included: audienceId ? [audienceId] : [] },
          send_strategy: { method: "static" },
        },
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Klaviyo create draft ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { data?: { id?: string } };
  return data.data?.id ?? "";
}

export type EspLiveResult =
  | {
      source: "live";
      provider: "MAILCHIMP";
      liveContext: string;
      mailchimpCreds: { apiKey: string; server: string };
      mailchimpAudienceId: string;
    }
  | { source: "live"; provider: "KLAVIYO"; liveContext: string; klaviyoCreds: { apiKey: string } }
  | { source: "simulation"; error?: string };

/**
 * Mailchimp → Klaviyo, same "connected but broken isn't the same as not
 * connected" shape as resolveSeoLiveData in seo-data-providers.ts — except
 * this is a non-fatal fallback, not a thrown error: the campaign copy that
 * follows is genuinely AI-written either way, only the "grounded in this
 * account's real performance" framing is lost, so the caller surfaces
 * `error` on the output instead of failing the whole run.
 */
export async function resolveEspLiveData(
  workspaceId: string,
  sentCount: number,
  // email-marketing.ts's "Email Platform" field is a required, explicit
  // choice (unlike newsletter.ts's "Email Service Provider", which is just a
  // formatting hint) — when given, only that provider is attempted, so an
  // explicit "Klaviyo" choice never silently sends through Mailchimp instead.
  preferredProvider?: "MAILCHIMP" | "KLAVIYO",
): Promise<EspLiveResult> {
  if (preferredProvider === "KLAVIYO") {
    return (await tryKlaviyo(workspaceId, sentCount)) ?? { source: "simulation" };
  }

  const mailchimpIntegration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId, provider: "MAILCHIMP" } },
  });

  if (mailchimpIntegration?.encryptedCredentials) {
    try {
      const mailchimpCreds = await decryptCredentials<{ apiKey: string; server: string }>(
        mailchimpIntegration.encryptedCredentials,
      );
      const [campaigns, audiences] = await Promise.all([
        fetchMailchimpCampaigns(mailchimpCreds.apiKey, mailchimpCreds.server, sentCount),
        fetchMailchimpAudiences(mailchimpCreds.apiKey, mailchimpCreds.server),
      ]);
      const mailchimpAudienceId = ((audiences[0] as Record<string, unknown> | undefined)?.id as string) ?? "";
      const liveContext = `\nMailchimp — last ${sentCount} sent campaigns (use open/click rates to understand what subject lines and content styles perform well for this audience):\n${JSON.stringify(campaigns, null, 2)}\nAudience lists:\n${JSON.stringify(audiences.slice(0, 5), null, 2)}`;
      return { source: "live", provider: "MAILCHIMP", liveContext, mailchimpCreds, mailchimpAudienceId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (preferredProvider === "MAILCHIMP") {
        return { source: "simulation", error: `Mailchimp is connected but didn't respond: ${message}` };
      }
      const klaviyoResult = await tryKlaviyo(workspaceId, sentCount);
      if (klaviyoResult?.source === "live") return klaviyoResult;
      return {
        source: "simulation",
        error: [`Mailchimp is connected but didn't respond: ${message}`, klaviyoResult?.error]
          .filter(Boolean)
          .join(" "),
      };
    }
  }
  if (preferredProvider === "MAILCHIMP") return { source: "simulation" };

  const klaviyoResult = await tryKlaviyo(workspaceId, sentCount);
  return klaviyoResult ?? { source: "simulation" };
}

async function tryKlaviyo(workspaceId: string, sentCount: number): Promise<EspLiveResult | null> {
  const klaviyoIntegration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId, provider: "KLAVIYO" } },
  });
  if (!klaviyoIntegration?.encryptedCredentials) return null;

  try {
    const klaviyoCreds = await decryptCredentials<{ apiKey: string }>(klaviyoIntegration.encryptedCredentials);
    const campaigns = await fetchKlaviyoCampaigns(klaviyoCreds.apiKey, sentCount);
    const liveContext = `\nKlaviyo — last ${campaigns.length} email campaigns (use performance data to understand what resonates with this audience):\n${JSON.stringify(campaigns, null, 2)}`;
    return { source: "live", provider: "KLAVIYO", liveContext, klaviyoCreds };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { source: "simulation", error: `Klaviyo is connected but didn't respond: ${message}` };
  }
}

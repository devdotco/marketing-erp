/**
 * Instantly v2 API — the raw HTTP calls shared by the Outbound Email agent
 * (lib/agent-handlers/outbound-email.ts) and the Email Marketing agent's Instantly channel
 * (lib/agent-handlers/email-marketing-channels.ts). Auth is always a v2 Bearer key; v1 keys are
 * rejected outright by every v2 endpoint here — see lib/integrations/verify/outbound.ts.
 *
 * Every function does exactly one HTTP call and either returns the parsed body or throws a plain
 * `Error` with the response detail attached — callers turn that into an `AgentInputError` with
 * whatever context makes sense for the run they're in (a campaign lookup failing reads
 * differently in Outbound Email than in Email Marketing).
 */

const TIMEOUT_MS = 15_000;
const BASE = "https://api.instantly.ai/api/v2";

export function instantlyHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

/** Wraps fetch's own network failures (DNS, timeout, connection reset) in one consistent shape,
 * so every caller distinguishes "couldn't reach Instantly" from "Instantly said no" the same way. */
async function instantlyFetch(path: string, apiKey: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...instantlyHeaders(apiKey), ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface InstantlyCampaignSummary {
  id: string;
  name: string;
  status?: number;
}

export async function listInstantlyCampaigns(apiKey: string, limit = 100): Promise<InstantlyCampaignSummary[]> {
  const res = await instantlyFetch(`/campaigns?limit=${limit}`, apiKey);
  if (!res.ok) throw new Error(`http_${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { items?: InstantlyCampaignSummary[] };
  return body.items ?? [];
}

/**
 * Resolve a campaign by name — exact match first, then a loose "contains the play slug" match so
 * renaming a campaign in Instantly doesn't break the lookup. Shared by Outbound Email (which
 * resolves DEV-01/02/03 campaigns) and anything else that targets a campaign by its configured
 * name rather than a stored id, since Instantly ids are per-workspace UUIDs nothing here can know
 * in advance.
 */
export async function resolveInstantlyCampaignIdByName(
  apiKey: string,
  targetName: string,
  looseMatch: string,
): Promise<string | null> {
  const campaigns = await listInstantlyCampaigns(apiKey);
  const match =
    campaigns.find((c) => c.name === targetName) ??
    campaigns.find((c) => c.name.toLowerCase().includes(looseMatch.toLowerCase()));
  return match?.id ?? null;
}

export interface InstantlySequenceStep {
  subject: string;
  body: string;
  delayDays?: number;
}

export interface CreateInstantlyCampaignInput {
  name: string;
  steps: InstantlySequenceStep[];
  /** IANA timezone for the send window. Defaults to America/New_York. */
  timezone?: string;
  /** Which sender addresses this campaign sends from — required by Instantly at activation time,
   * but a campaign can be created (and staged, unactivated) without one. */
  emailList?: string[];
  sendDayOfWeek?: "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday" | "Sunday";
  /** HH:MM (24-hour) send window. Defaults to 09:00–17:00. Optional so every existing caller that
   * doesn't pass it keeps the same default schedule it already gets. */
  timing?: { from: string; to: string };
}

const DAY_INDEX: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6,
};

/**
 * Pure payload builder — no network — so the shape sent to POST /campaigns can be unit tested
 * without a live key. Days default to every weekday when no preferred send day is given; a
 * preferred day narrows the schedule to that single day, same as the agent's "Preferred Send Day"
 * input implies.
 */
export function buildInstantlyCampaignPayload(input: CreateInstantlyCampaignInput): Record<string, unknown> {
  const days: Record<string, boolean> = { "0": false, "1": true, "2": true, "3": true, "4": true, "5": true, "6": false };
  if (input.sendDayOfWeek) {
    for (const key of Object.keys(days)) days[key] = false;
    days[String(DAY_INDEX[input.sendDayOfWeek])] = true;
  }

  return {
    name: input.name,
    campaign_schedule: {
      schedules: [
        {
          name: "Default",
          timing: input.timing ?? { from: "09:00", to: "17:00" },
          days,
          timezone: input.timezone ?? "America/New_York",
        },
      ],
    },
    ...(input.emailList && input.emailList.length > 0 ? { email_list: input.emailList } : {}),
    sequences: [
      {
        steps: input.steps.map((step) => ({
          type: "email",
          delay: step.delayDays ?? 0,
          delay_unit: "days",
          variants: [{ subject: step.subject, body: step.body }],
        })),
      },
    ],
  };
}

/** Creates a campaign in Instantly's own Draft status (0) — Instantly never auto-launches a
 * newly created campaign, so this alone is the "staged" half of the flow. */
export async function createInstantlyCampaign(apiKey: string, input: CreateInstantlyCampaignInput): Promise<string> {
  const res = await instantlyFetch("/campaigns", apiKey, {
    method: "POST",
    body: JSON.stringify(buildInstantlyCampaignPayload(input)),
  });
  if (!res.ok) throw new Error(`http_${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error("Instantly did not return a campaign id");
  return data.id;
}

/** POST /campaigns/{id}/activate — the send-mail step. Only ever call this from an approval path. */
export async function activateInstantlyCampaign(apiKey: string, campaignId: string): Promise<void> {
  const res = await instantlyFetch(`/campaigns/${encodeURIComponent(campaignId)}/activate`, apiKey, { method: "POST" });
  if (!res.ok) throw new Error(`http_${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** POST /leads/move — moves every lead in `listId` into `toCampaignId`. This is what actually
 * populates a staged campaign's recipients; only ever call this from an approval path, alongside
 * activation, since a lead moved into an ACTIVE campaign starts receiving it. */
export async function moveInstantlyLeadsToCampaign(apiKey: string, listId: string, toCampaignId: string): Promise<void> {
  const res = await instantlyFetch("/leads/move", apiKey, {
    method: "POST",
    body: JSON.stringify({ list_id: listId, to_campaign_id: toCampaignId }),
  });
  if (!res.ok) throw new Error(`http_${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** POST /leads — add a single lead directly to a campaign, with per-lead personalization. Used by
 * Outbound Email, which targets one prospect per run rather than a whole list. */
export async function addInstantlyLead(apiKey: string, body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await instantlyFetch("/leads", apiKey, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`http_${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as { id: string };
}

export interface InstantlyAccountSummary {
  email: string;
  status?: number;
}

/** GET /accounts — the workspace's connected sending mailboxes. Used by Prospector to confirm a
 * configured sending address is actually connected in Instantly before staging a campaign around
 * it, rather than finding out only when activation fails. Read-only, free. */
export async function listInstantlyAccounts(apiKey: string, limit = 100): Promise<InstantlyAccountSummary[]> {
  const res = await instantlyFetch(`/accounts?limit=${limit}`, apiKey);
  if (!res.ok) throw new Error(`http_${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { items?: InstantlyAccountSummary[] };
  return body.items ?? [];
}

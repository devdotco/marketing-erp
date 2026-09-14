/**
 * Apollo.io API — the raw HTTP calls shared by Lead Enrichment
 * (lib/agent-handlers/lead-enrichment.ts), Outbound Scout (lib/agent-handlers/outbound-scout.ts),
 * Outbound Strategist (lib/agent-handlers/outbound-strategist.ts — organization/people enrichment
 * and job postings only, never a reveal call), and the Email Marketing agent's Apollo channel
 * (lib/agent-handlers/email-marketing-channels.ts).
 * Auth is always the `x-api-key` header — Apollo rejects an `api_key` body field. See
 * lib/integrations/catalog.ts and lib/integrations/verify/outbound.ts.
 *
 * Every function does exactly one HTTP call and returns the parsed body or throws a plain `Error`
 * with the response detail attached; callers build their own `AgentInputError` with context.
 */

const TIMEOUT_MS = 15_000;

export function apolloHeaders(apiKey: string): Record<string, string> {
  return { "Content-Type": "application/json", "x-api-key": apiKey };
}

async function apolloFetch(path: string, apiKey: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`https://api.apollo.io${path}`, {
      ...init,
      headers: { ...apolloHeaders(apiKey), ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** POST /api/v1/people/match — resolves one person (by email, and optionally name/company) to
 * Apollo's enrichment record. Free — does not spend a credit unless it also reveals an email
 * that wasn't already known (Outbound Scout's reveal loop; Lead Enrichment always supplies one). */
export async function apolloMatchPerson(apiKey: string, matchBody: Record<string, string>): Promise<Response> {
  return apolloFetch("/api/v1/people/match", apiKey, { method: "POST", body: JSON.stringify(matchBody) });
}

/** POST /api/v1/mixed_people/api_search — free, but never returns email addresses; requires a
 * Master API Key and Apollo's Professional plan or higher. */
export async function apolloPeopleSearch(apiKey: string, filters: Record<string, unknown>): Promise<Response> {
  return apolloFetch("/api/v1/mixed_people/api_search", apiKey, { method: "POST", body: JSON.stringify(filters) });
}

/** GET /api/v1/organizations/enrich?domain=... — resolves one company by domain to Apollo's
 * firmographic record: industry, employee count, revenue range, funding stage/total/latest round,
 * technologies, keywords, locations, founded year. Costs 1 credit per organization, spent whether
 * or not Apollo has a match for the domain — see docs.apollo.io/reference/organization-enrichment.
 * Used by Outbound Strategist for firmographic/timing scoring; never resolves a person, so it
 * carries no email/phone reveal cost. */
export async function apolloEnrichOrganization(apiKey: string, domain: string): Promise<Response> {
  const params = new URLSearchParams({ domain });
  return apolloFetch(`/api/v1/organizations/enrich?${params.toString()}`, apiKey, { method: "GET" });
}

/** GET /api/v1/organizations/{organizationId}/job_postings — open roles Apollo has indexed for one
 * company, used as a hiring/timing signal (e.g. open engineering reqs). Costs 1 credit per page,
 * and a page holds up to 10,000 results, so a single call covers any one company — see
 * docs.apollo.io/reference/organization-jobs-postings. Requires the Apollo organization id, which
 * comes back from apolloEnrichOrganization or a person match's `organization.id`. */
export async function apolloOrganizationJobPostings(apiKey: string, organizationId: string, page = 1): Promise<Response> {
  const params = new URLSearchParams({ page: String(page) });
  return apolloFetch(`/api/v1/organizations/${encodeURIComponent(organizationId)}/job_postings?${params.toString()}`, apiKey, {
    method: "GET",
  });
}

/**
 * POST /api/v1/contacts/search — Apollo's SAVED contacts (distinct from the people-search index
 * above), searched by keyword (an email address works) via a JSON body, not query params. Used
 * to resolve a contact the customer named by email to the contact id `add_contact_ids` needs.
 * 0 credits.
 *
 * UNVERIFIED path prefix — same caveat as apolloCreateSequence: Apollo's hosted docs
 * (docs.apollo.io/reference/search-for-contacts) quoted this as bare "POST /contacts/search".
 * Confirm before production use.
 */
export async function apolloContactsSearch(apiKey: string, qKeywords: string): Promise<Response> {
  return apolloFetch("/api/v1/contacts/search", apiKey, {
    method: "POST",
    body: JSON.stringify({ q_keywords: qKeywords, per_page: 1 }),
  });
}

/** POST /api/v1/emailer_campaigns/search — lists/searches existing sequences. 0 credits. */
export async function apolloSearchSequences(apiKey: string, qName?: string): Promise<Response> {
  const params = new URLSearchParams({ per_page: "25" });
  if (qName) params.set("q_name", qName);
  return apolloFetch(`/api/v1/emailer_campaigns/search?${params.toString()}`, apiKey, { method: "POST" });
}

export interface ApolloEmailStep {
  subject: string;
  bodyHtml: string;
  /** Days to wait after the previous step. 0 on the first step. */
  waitDays?: number;
}

/**
 * Pure payload builder for POST /sequences — no network — so the shape can be unit tested without
 * a live key. `active: false` stages the sequence: per Apollo's docs a sequence created this way
 * has steps but enrolls no one, which is the "draft" half of the flow. Enrolling contacts (the
 * send-triggering step) is a SEPARATE call — see apolloAddContactsToSequence — made only on
 * approval.
 */
export function buildApolloSequencePayload(name: string, steps: ApolloEmailStep[]): Record<string, unknown> {
  return {
    name,
    active: false,
    emailer_steps: steps.map((step) => ({
      type: "auto_email",
      wait_time: step.waitDays ?? 0,
      wait_mode: "day",
      emailer_touches: [
        {
          type: "new_thread",
          status: "approved",
          emailer_template: { subject: step.subject, body_html: step.bodyHtml },
        },
      ],
    })),
  };
}

/**
 * POST /api/v1/sequences — creates the sequence in Apollo, staged (active: false). Needs either a
 * Master API Key or a scoped key with the `api/v1/sequences/create` permission.
 *
 * UNVERIFIED: fetched from Apollo's hosted docs (docs.apollo.io/reference/create-sequence), which
 * quoted the path as bare "POST /sequences" without the "/api/v1" prefix every other confirmed
 * Apollo endpoint in this file uses (including the sibling search-for-sequences endpoint, whose
 * doc page did give the full "/api/v1/emailer_campaigns/search" path). No live key was available
 * to confirm which is correct — verify against Apollo's own API reference or a Postman collection
 * before relying on this in production; if it 404s, the fix is almost certainly dropping the
 * "/api/v1" prefix back to bare "/sequences".
 */
export async function apolloCreateSequence(apiKey: string, name: string, steps: ApolloEmailStep[]): Promise<Response> {
  return apolloFetch("/api/v1/sequences", apiKey, { method: "POST", body: JSON.stringify(buildApolloSequencePayload(name, steps)) });
}

/**
 * POST /emailer_campaigns/{sequenceId}/add_contact_ids — the send-triggering call. Requires a
 * Master API Key (or the `api/v1/emailer_campaigns/add_contact_ids` scope) — callers should
 * surface that requirement by name when this 403s, since a regular scoped key silently looking
 * identical to a working one until this exact call is the failure mode Apollo's own docs warn
 * about. Only ever call this from an approval path: adding contacts to a sequence starts sending
 * them mail on the sequence's schedule.
 *
 * UNVERIFIED path prefix — see apolloCreateSequence's comment; the doc page for this endpoint
 * also gave the bare path ("POST /emailer_campaigns/{sequence_id}/add_contact_ids") without
 * "/api/v1". Confirm before production use.
 */
export async function apolloAddContactsToSequence(
  apiKey: string,
  sequenceId: string,
  params: { contactIds: string[]; sendEmailFromEmailAccountId: string },
): Promise<Response> {
  const search = new URLSearchParams({
    emailer_campaign_id: sequenceId,
    send_email_from_email_account_id: params.sendEmailFromEmailAccountId,
  });
  for (const id of params.contactIds) search.append("contact_ids[]", id);
  return apolloFetch(`/api/v1/emailer_campaigns/${encodeURIComponent(sequenceId)}/add_contact_ids?${search.toString()}`, apiKey, {
    method: "POST",
  });
}

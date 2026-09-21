/**
 * Outbound Scout — capital-raise sourcing mode.
 *
 * Sources the play's ICP from companies that just filed an SEC Form D, i.e. companies that have
 * just closed (or opened) a Regulation D private raise. The premise is simply that a company
 * which has taken money has budget, and said so on the public record with a date attached.
 *
 * Two data sources, deliberately split by what they cost:
 *   - SEC EDGAR (lib/integrations/sec-edgar.ts) — free, keyless, and authoritative for the
 *     ACCOUNT: who raised, how much, in what industry, where, and which officers signed for it.
 *   - Apollo.io — the only thing that turns a signatory's name into a reachable contact, at one
 *     credit per person, exactly as the ICP-search mode's reveal loop already spends them.
 *
 * So without Apollo this mode still works and still returns real, named, verifiable companies —
 * it just can't return email addresses, and (like the simulation path) persists nothing.
 *
 * Budgeting is the thing to be careful about here and the reason for the two caps below. EDGAR
 * lists ~300 Form Ds a day, the listing is one request per 100 but each filing's detail is one
 * request of its own, and the play's filters are only knowable from the detail. So filings are
 * read newest-first and the loop stops as soon as it has enough issuers to fill the run.
 */
import { decryptCredentials } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { AgentInputError } from "@/lib/ai/errors";
import { apolloMatchPerson } from "@/lib/integrations/apollo";
import {
  fetchFormDDocument,
  filterFormDIssuers,
  formDAccountRecord,
  formDDateWindow,
  formDFilingUrl,
  formDSignal,
  listFormDFilings,
  parseFormDXml,
  secUserAgent,
  selectFormDContacts,
  type FormDContactCandidate,
  type FormDIssuer,
} from "@/lib/integrations/sec-edgar";
import type { OutboundPlayConfig } from "./outbound-play-config";

/** Hard ceiling on Form D detail documents read in one run, whatever the filters do. Worst case
 * (a narrow industry + state filter that matches almost nothing) this is what stops the run
 * walking a whole month of filings instead of giving up and reporting an empty result. */
const MAX_FILINGS_EXAMINED = 250;

/** Ceiling on the listing crawl — filings the search endpoint enumerates before detail reads
 * begin. 1,000 is roughly three days of total national Form D volume. */
const MAX_FILINGS_LISTED = 1_000;

/** SEC asks automated clients to stay under 10 requests/second and throttles the originating IP —
 * this app's server, for every workspace — when they don't. ~8/s leaves headroom. */
const SEC_REQUEST_SPACING_MS = 125;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface CapitalRaiseSourcingResult {
  output: Record<string, unknown>;
  /** True only when Apollo resolved real contacts — i.e. when the caller may persist them. */
  isLive: boolean;
}

/**
 * Reads the Form D filings in the play's lookback window, applies the play's capital-raise rules,
 * and resolves the surviving issuers' signatories to contacts via Apollo when it's connected.
 */
export async function sourceCapitalRaiseProspects(opts: {
  workspaceId: string;
  playName: string;
  playConfig: OutboundPlayConfig;
  maxProspects: number;
  apolloApiKeyCiphertext: string | null;
}): Promise<CapitalRaiseSourcingResult> {
  const { playConfig, playName, maxProspects } = opts;
  const rules = playConfig.capitalRaise;

  if (!rules.enabled) {
    throw new AgentInputError(
      `The "${playName}" play doesn't have capital-raise sourcing turned on.`,
      "Open the play on the Outbound Engine page (/outbound), tick \"Source from SEC Form D filings\" under Capital raise, and set the offering size and industries you want. Then run Scout again in this mode.",
      "capital_raise_disabled",
    );
  }

  const userAgent = secUserAgent();
  if (!userAgent) {
    // Refused before any traffic is sent, not after SEC blocks us: their Internet Security Policy
    // requires a declared contact, and the ban that follows an undeclared client lands on this
    // server's IP for every workspace, not just this run.
    throw new AgentInputError(
      "SEC EDGAR access isn't configured, so capital-raise sourcing can't run.",
      "Set SEC_EDGAR_USER_AGENT on this deployment to a string naming your company and a working contact address (SEC requires one and blocks clients that don't send it) — for example \"DEV.co Outbound outbound@dev.co\". SEC_EDGAR_CONTACT_EMAIL alone also works. No API key or SEC account is needed.",
      "sec_user_agent_unset",
    );
  }

  const { startDate, endDate } = formDDateWindow(rules.lookbackDays);

  let listed;
  try {
    listed = await listFormDFilings(userAgent, {
      startDate,
      endDate,
      limit: MAX_FILINGS_LISTED,
      includeAmendments: rules.includeAmendments,
    });
  } catch (err) {
    throw new AgentInputError(
      `Couldn't reach SEC EDGAR to list Form D filings for play "${playName}".`,
      `EDGAR is usually transient — try running Scout again. If it persists, check https://www.sec.gov/ is reachable from this server and that SEC_EDGAR_USER_AGENT names a real contact (an undeclared client gets rate-limited). Detail: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "sec_edgar_unreachable",
    );
  }

  if (listed.length === 0) {
    return {
      isLive: false,
      output: {
        prospects: [],
        source: "sec_form_d",
        secFormD: { startDate, endDate, filingsListed: 0 },
        note: `SEC EDGAR returned no Form D filings between ${startDate} and ${endDate}.`,
      },
    };
  }

  // Companies already in this workspace's pipeline. Checked BEFORE any Apollo credit is spent —
  // the handler's own dedupe runs on email, which is only known after the reveal, so on a daily
  // tick that alone would re-buy the same company's contacts every morning.
  const existing = await prisma.outboundProspect.findMany({
    where: { workspaceId: opts.workspaceId },
    select: { company: true },
  });
  const existingCompanies = new Set(existing.map((p) => p.company.trim().toLowerCase()).filter(Boolean));

  // How many issuers are worth reading: enough to fill the run at this play's contacts-per-issuer,
  // with headroom for issuers whose officers Apollo can't resolve.
  const issuersNeeded = Math.ceil(maxProspects / Math.max(1, rules.contactsPerIssuer)) * 2;

  const kept: FormDIssuer[] = [];
  const rejected: Record<string, number> = {};
  let examined = 0;
  let readFailures = 0;
  let alreadyInPipeline = 0;

  for (const ref of listed) {
    if (kept.length >= issuersNeeded || examined >= MAX_FILINGS_EXAMINED) break;
    examined++;

    let xml: string;
    try {
      const res = await fetchFormDDocument(userAgent, ref);
      if (!res.ok) {
        readFailures++;
        await sleep(SEC_REQUEST_SPACING_MS);
        continue;
      }
      xml = await res.text();
    } catch {
      readFailures++;
      await sleep(SEC_REQUEST_SPACING_MS);
      continue;
    }
    await sleep(SEC_REQUEST_SPACING_MS);

    const issuer = parseFormDXml(xml, ref);

    if (existingCompanies.has(issuer.entityName.trim().toLowerCase())) {
      alreadyInPipeline++;
      continue;
    }

    const { kept: passed, rejected: reasons } = filterFormDIssuers([issuer], rules, playConfig.icp);
    for (const [reason, count] of Object.entries(reasons)) {
      if (count > 0) rejected[reason] = (rejected[reason] ?? 0) + count;
    }
    kept.push(...passed);
  }

  // Every read failing points at EDGAR or the User-Agent, not at any one filing — fail loudly
  // rather than reporting "no companies matched your filters", which would send someone off to
  // loosen filters that were never consulted.
  if (kept.length === 0 && readFailures > 0 && readFailures === examined) {
    throw new AgentInputError(
      `SEC EDGAR listed ${listed.length} Form D filings for play "${playName}" but every attempt to read one failed.`,
      "This is usually SEC throttling an undeclared or over-eager client. Check SEC_EDGAR_USER_AGENT names your company and a working contact address, then try again in a few minutes.",
      "sec_edgar_read_failed",
    );
  }

  const candidates = selectFormDContacts(kept, {
    titles: playConfig.icp.titles,
    relationships: rules.contactRelationships,
    perIssuer: rules.contactsPerIssuer,
    cap: maxProspects,
  });

  const filingSummary = {
    startDate,
    endDate,
    filingsListed: listed.length,
    filingsExamined: examined,
    filingsUnreadable: readFailures,
    issuersMatched: kept.length,
    issuersAlreadyInPipeline: alreadyInPipeline,
    issuersRejected: rejected,
    examinedCapReached: examined >= MAX_FILINGS_EXAMINED,
    companies: kept.map((i) => ({
      name: i.entityName,
      state: i.state,
      industryGroup: i.industryGroup,
      offeringAmount: i.totalOfferingAmount,
      rawOfferingAmount: i.rawOfferingAmount,
      amountSold: i.totalAmountSold,
      filedAt: i.filedAt,
      filingUrl: formDFilingUrl(i),
    })),
  };

  // ── No Apollo: real accounts, no addresses ──────────────────────────────────
  if (!opts.apolloApiKeyCiphertext) {
    return {
      isLive: false,
      output: {
        prospects: candidates.map(formDAccountRecord),
        source: "sec_form_d_accounts_only",
        secFormD: filingSummary,
        note: "These are real companies and real Form D signatories from SEC EDGAR, but Apollo.io isn't connected so none of them have an email address and none were saved to the pipeline. Connect Apollo.io in Settings → Integrations to resolve these names to reachable contacts.",
      },
    };
  }

  // ── Apollo: resolve each signatory to a contact ─────────────────────────────
  const creds = await decryptCredentials<{ apiKey: string }>(opts.apolloApiKeyCiphertext);
  const prospects: Array<Record<string, unknown>> = [];
  const unresolved: Array<{ name: string; company: string }> = [];
  let matchFailures = 0;

  for (const candidate of candidates) {
    const resolved = await resolveCandidate(creds.apiKey, candidate);
    if (resolved.kind === "matched") {
      prospects.push(resolved.prospect);
    } else {
      if (resolved.kind === "error") matchFailures++;
      unresolved.push({ name: `${candidate.firstName} ${candidate.lastName}`, company: candidate.organizationName });
    }
  }

  if (candidates.length > 0 && prospects.length === 0 && matchFailures === candidates.length) {
    throw new AgentInputError(
      `Found ${kept.length} companies that filed a Form D for play "${playName}", but every Apollo.io lookup to resolve their officers failed.`,
      "Check the Apollo API key's remaining credits and permissions in Settings → Integrations → Apollo.io.",
      "apollo_match_failed",
    );
  }

  return {
    isLive: true,
    output: {
      prospects,
      source: "sec_form_d_apollo",
      secFormD: filingSummary,
      contactsAttempted: candidates.length,
      contactsResolved: prospects.length,
      // Named, but with no Apollo record — common for officers of a company incorporated weeks
      // ago. Surfaced rather than dropped silently so the list can be worked by hand.
      contactsUnresolved: unresolved,
    },
  };
}

type CandidateResolution =
  | { kind: "matched"; prospect: Record<string, unknown> }
  | { kind: "no_match" }
  | { kind: "error" };

/**
 * One Apollo people/match per Form D signatory, scoped by the issuer's name.
 *
 * `first_name` / `last_name` / `organization_name` is the documented match shape, and is all a
 * Form D gives us — the filing carries no email, no domain and no LinkedIn URL. A match with no
 * revealed email is discarded rather than kept with a guessed address: OutboundProspect.email is
 * required and unique, so a fabricated one would both be wrong and poison the dedupe.
 */
async function resolveCandidate(apiKey: string, candidate: FormDContactCandidate): Promise<CandidateResolution> {
  let person: Record<string, unknown> | undefined;
  try {
    const res = await apolloMatchPerson(apiKey, {
      first_name: candidate.firstName,
      last_name: candidate.lastName,
      organization_name: candidate.organizationName,
    });
    if (!res.ok) return { kind: "error" };
    const json = (await res.json()) as { person?: Record<string, unknown> };
    person = json.person;
  } catch {
    return { kind: "error" };
  }

  const email = (person?.email as string | undefined)?.toLowerCase();
  if (!person || !email) return { kind: "no_match" };

  const org = (person.organization ?? {}) as Record<string, unknown>;
  const issuer = candidate.issuer;
  const { primarySignal, additionalSignals } = formDSignal(issuer);

  // Apollo's current title wins when it has one — the Form D clarification is what the filer typed
  // at filing time and is often blank or abbreviated ("CFO and Treasurer").
  const title = (person.title as string) || candidate.titleClarification || candidate.relationships.join(", ");

  return {
    kind: "matched",
    prospect: {
      firstName: (person.first_name as string) || candidate.firstName,
      lastName: (person.last_name as string) || candidate.lastName,
      email,
      linkedInUrl: (person.linkedin_url as string) ?? "",
      title,
      // Apollo's org name can be a parent or a rebrand; the Form D issuer is the entity that
      // actually filed, so it stays authoritative for the account this prospect belongs to.
      company: issuer.entityName,
      companyDomain: (org.primary_domain as string) ?? (org.website_url as string) ?? "",
      employees: String(org.estimated_num_employees ?? ""),
      industry: (org.industry as string) ?? issuer.industryGroup ?? "",
      geography: (person.country as string) ?? [issuer.city, issuer.state].filter(Boolean).join(", "),
      primarySignal,
      additionalSignals: [
        ...additionalSignals,
        ...(candidate.relationships.length > 0 ? [`Signed the Form D as: ${candidate.relationships.join(", ")}`] : []),
      ],
      // A Form D signatory is a named, dated, SEC-filed fact about this person's role at this
      // company, so a verified Apollo email on top of it is the strongest grade this pipeline
      // has; an unverified one still outranks a plain ICP-search hit.
      dataQualityScore: (person.email_status as string) === "verified" ? 5 : 4,
      secFormD: {
        cik: issuer.cik,
        accession: issuer.accession,
        filedAt: issuer.filedAt,
        offeringAmount: issuer.totalOfferingAmount,
        amountSold: issuer.totalAmountSold,
        industryGroup: issuer.industryGroup,
        url: formDFilingUrl(issuer),
      },
    },
  };
}

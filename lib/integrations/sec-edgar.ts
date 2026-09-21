/**
 * SEC EDGAR — Form D (Regulation D exempt offering) as an outbound buying signal.
 *
 * A Form D is filed within 15 days of the first sale in a private raise, so a fresh one is about
 * as close to "this company just took money and has a budget" as public data gets. It is also
 * free, keyless, and structured: the primary document is XML with the issuer's name, address,
 * phone, industry, offering size, amount sold to date, and the names + roles of the executive
 * officers and directors who signed it.
 *
 * Two endpoints, both verified live on 2026-09-21:
 *   1. https://efts.sec.gov/LATEST/search-index — EDGAR full-text search, JSON, filters by form
 *      type and filed-date range in one request. Used to LIST filings in the lookback window.
 *   2. https://www.sec.gov/Archives/edgar/data/<cik>/<accession-no-dashes>/primary_doc.xml — the
 *      Form D itself. Used to READ each filing.
 *
 * What is deliberately NOT here: a contact email. Form D carries no email address and no website,
 * only the issuer's name and its officers' names. Turning that into a reachable prospect is
 * Apollo's job (outbound-scout.ts matches each officer by first/last/organization_name) — this
 * module's output is accounts and people, never addresses.
 *
 * Everything below the network section is pure and unit-tested in test/content.test.ts.
 */
import type { OutboundCapitalRaise, OutboundPlayIcp } from "@/lib/agent-handlers/outbound-play-config";

const EDGAR_FULL_TEXT_SEARCH = "https://efts.sec.gov/LATEST/search-index";
const EDGAR_ARCHIVES = "https://www.sec.gov/Archives/edgar/data";
const TIMEOUT_MS = 20_000;

/** EDGAR full-text search honours `size` only for the page sizes its own UI uses; a value it
 * doesn't recognise comes back as 100 anyway (verified: `size=60` returned 100 rows). So always
 * ask for 100 and slice client-side rather than trusting the page size we requested. */
const FTS_PAGE_SIZE = 100;
/** EDGAR rejects a deep `from` offset, and a lookback this feature would ever use is far shorter.
 * 10 pages = 1,000 filings, roughly a fortnight of total Form D volume. */
const FTS_MAX_PAGES = 10;

/**
 * SEC's Internet Security Policy requires every automated request to declare a User-Agent naming
 * the requester with a working contact address; requests without one are throttled or blocked
 * outright, and the block is applied to the whole originating IP — i.e. to this app's server, for
 * every workspace, not just the run that caused it.
 *
 * So this is configuration, not a default we can invent: a made-up address would be a policy
 * breach, and hardcoding a real person's address would leak it to a third party. Unset means the
 * capital-raise sourcing mode refuses legibly (see outbound-scout.ts) instead of sending traffic
 * SEC is entitled to ban.
 */
export function secUserAgent(): string | null {
  const explicit = process.env.SEC_EDGAR_USER_AGENT?.trim();
  if (explicit) return explicit;
  const contact = process.env.SEC_EDGAR_CONTACT_EMAIL?.trim();
  if (contact) return `ERP.io Marketing Outbound ${contact}`;
  return null;
}

function secHeaders(userAgent: string): Record<string, string> {
  return { "User-Agent": userAgent, Accept: "application/json, text/xml;q=0.9, */*;q=0.8" };
}

async function secFetch(url: string, userAgent: string): Promise<Response> {
  try {
    return await fetch(url, { headers: secHeaders(userAgent), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** One row of the full-text search listing — enough to fetch the filing itself, nothing more. */
export interface FormDFilingRef {
  /** Unpadded, as the Archives path wants it (the search returns it zero-padded to 10). */
  cik: string;
  /** Accession number with dashes, e.g. "0001213900-26-101361". */
  accession: string;
  companyName: string;
  /** Filed date, YYYY-MM-DD. */
  filedAt: string;
  /** Two-letter state of the issuer's business address, when EDGAR indexed one. */
  businessState: string | null;
  form: string;
}

/** GET the full-text search listing for one page of Form D filings in a filed-date window. */
export async function fetchFormDSearchPage(
  userAgent: string,
  opts: { startDate: string; endDate: string; from: number },
): Promise<Response> {
  const params = new URLSearchParams({
    q: "",
    forms: "D",
    startdt: opts.startDate,
    enddt: opts.endDate,
    from: String(opts.from),
    size: String(FTS_PAGE_SIZE),
  });
  return secFetch(`${EDGAR_FULL_TEXT_SEARCH}?${params.toString()}`, userAgent);
}

/** GET one filing's primary Form D document (XML). */
export async function fetchFormDDocument(userAgent: string, ref: Pick<FormDFilingRef, "cik" | "accession">): Promise<Response> {
  const folder = ref.accession.replace(/-/g, "");
  return secFetch(`${EDGAR_ARCHIVES}/${encodeURIComponent(ref.cik)}/${encodeURIComponent(folder)}/primary_doc.xml`, userAgent);
}

/** Every Form D filed in the window, newest first, up to `limit`. Pages the search endpoint until
 * it runs out of hits or the limit is met — the caller's limit is what bounds the crawl, since
 * total Form D volume is ~300/day and no play wants all of it. */
export async function listFormDFilings(
  userAgent: string,
  opts: { startDate: string; endDate: string; limit: number; includeAmendments: boolean },
): Promise<FormDFilingRef[]> {
  const out: FormDFilingRef[] = [];
  for (let page = 0; page < FTS_MAX_PAGES && out.length < opts.limit; page++) {
    const res = await fetchFormDSearchPage(userAgent, { ...opts, from: page * FTS_PAGE_SIZE });
    if (!res.ok) {
      throw new Error(`EDGAR full-text search returned HTTP ${res.status}`);
    }
    const body = (await res.json()) as unknown;
    const refs = parseFormDSearchResults(body, opts.includeAmendments);
    const rawCount = rawHitCount(body);
    out.push(...refs);
    // A short page means EDGAR has nothing further, regardless of how many survived the
    // amendment filter — checking `refs.length` instead would stop early on a page that happened
    // to be all D/A rows.
    if (rawCount < FTS_PAGE_SIZE) break;
  }
  return out.slice(0, opts.limit);
}

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

function rawHitCount(body: unknown): number {
  const hits = (body as { hits?: { hits?: unknown[] } } | null)?.hits?.hits;
  return Array.isArray(hits) ? hits.length : 0;
}

/** Maps an EDGAR full-text search response to filing refs. Rows missing a CIK or accession are
 * skipped rather than throwing — one malformed hit shouldn't lose the other 99 on the page. */
export function parseFormDSearchResults(body: unknown, includeAmendments: boolean): FormDFilingRef[] {
  const hits = (body as { hits?: { hits?: unknown[] } } | null)?.hits?.hits;
  if (!Array.isArray(hits)) return [];

  const out: FormDFilingRef[] = [];
  for (const hit of hits) {
    const source = (hit as { _source?: Record<string, unknown> } | null)?._source;
    if (!source) continue;

    const form = typeof source.form === "string" ? source.form : "";
    // "D" is the new offering; "D/A" amends one already filed — usually a closing update on a
    // raise that is months old, which is the opposite of the timing signal this play wants.
    if (!includeAmendments && form !== "D") continue;
    if (form !== "D" && form !== "D/A") continue;

    const ciks = Array.isArray(source.ciks) ? source.ciks : [];
    const rawCik = typeof ciks[0] === "string" ? ciks[0] : "";
    const accession = typeof source.adsh === "string" ? source.adsh : "";
    if (!rawCik || !accession) continue;

    const displayNames = Array.isArray(source.display_names) ? source.display_names : [];
    const rawName = typeof displayNames[0] === "string" ? displayNames[0] : "";

    const bizStates = Array.isArray(source.biz_states) ? source.biz_states : [];

    out.push({
      // EDGAR returns the CIK zero-padded to 10 in search results but the Archives path wants it
      // unpadded — "0002074867" 404s where "2074867" resolves.
      cik: rawCik.replace(/^0+/, "") || rawCik,
      accession,
      companyName: stripCikSuffix(rawName),
      filedAt: typeof source.file_date === "string" ? source.file_date : "",
      businessState: typeof bizStates[0] === "string" ? bizStates[0] : null,
      form,
    });
  }
  return out;
}

/** Search results render the company as `Acme Holdings LLC  (CIK 0001234567)`. */
function stripCikSuffix(displayName: string): string {
  return displayName.replace(/\s*\(CIK\s+\d+\)\s*$/i, "").trim();
}

export interface FormDRelatedPerson {
  firstName: string;
  lastName: string;
  /** "Executive Officer" | "Director" | "Promoter" — a person can hold more than one. */
  relationships: string[];
  /** Free text the filer adds next to the relationship, and the only place an actual job title
   * ever appears on a Form D: "Chief Executive Officer", "CFO and Treasurer", etc. Often blank. */
  titleClarification: string;
}

export interface FormDIssuer {
  cik: string;
  accession: string;
  form: string;
  filedAt: string;
  entityName: string;
  entityType: string | null;
  city: string | null;
  state: string | null;
  phone: string | null;
  jurisdictionOfInc: string | null;
  yearOfInc: string | null;
  /** The filer's own answer to "was this entity formed within the last five years". */
  incorporatedWithinFiveYears: boolean;
  /** Form D's fixed taxonomy, e.g. "Other Technology", "Pooled Investment Fund", "Commercial". */
  industryGroup: string | null;
  /** Only present on pooled funds: "Venture Capital Fund", "Private Equity Fund", "Hedge Fund". */
  investmentFundType: string | null;
  revenueRange: string | null;
  /** Null when the filer entered "Indefinite" rather than a number — see rawOfferingAmount. */
  totalOfferingAmount: number | null;
  rawOfferingAmount: string | null;
  totalAmountSold: number | null;
  totalRemaining: number | null;
  minimumInvestmentAccepted: number | null;
  dateOfFirstSale: string | null;
  isAmendment: boolean;
  relatedPersons: FormDRelatedPerson[];
}

/** First text value of `<tag>` inside `xml`, trimmed; null when absent or empty. Form D's schema
 * is flat, single-namespace, and entity-light, so a scanner beats adding an XML dependency for
 * one document type — but it does mean tag names must be unique enough to address this way, which
 * is why the related-persons list is sliced out by block below rather than scanned globally. */
function tagValue(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!match) return null;
  const value = decodeXmlEntities(match[1].trim());
  return value.length > 0 ? value : null;
}

function allTagValues(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const value = decodeXmlEntities(match[1].trim());
    if (value.length > 0) out.push(value);
  }
  return out;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

/** All `<relatedPersonInfo>` blocks, so each person's name, relationships and clarification stay
 * associated with each other instead of being flattened into parallel global lists. */
function relatedPersonBlocks(xml: string): string[] {
  const out: string[] = [];
  const re = /<relatedPersonInfo>([\s\S]*?)<\/relatedPersonInfo>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) out.push(match[1]);
  return out;
}

/** "Indefinite" is a legal answer to the offering-amount question, and parseFloat("Indefinite") is
 * NaN, not an error — so an unguarded Number() would silently become 0 and then fail every
 * minimum-size filter as if the company had raised nothing. */
function numericValue(xml: string, tag: string): number | null {
  const raw = tagValue(xml, tag);
  if (raw === null) return null;
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parses a Form D primary document into the structured issuer record every filter and prospect
 * below reads. Pure — the XML string comes from fetchFormDDocument. */
export function parseFormDXml(xml: string, ref: FormDFilingRef): FormDIssuer {
  const issuerBlock = xml.match(/<primaryIssuer>([\s\S]*?)<\/primaryIssuer>/)?.[1] ?? "";
  const offeringBlock = xml.match(/<offeringData>([\s\S]*?)<\/offeringData>/)?.[1] ?? "";
  const salesBlock = offeringBlock.match(/<offeringSalesAmounts>([\s\S]*?)<\/offeringSalesAmounts>/)?.[1] ?? "";
  const yearBlock = issuerBlock.match(/<yearOfInc>([\s\S]*?)<\/yearOfInc>/)?.[1] ?? "";

  const relatedPersons: FormDRelatedPerson[] = relatedPersonBlocks(xml).map((block) => ({
    firstName: tagValue(block, "firstName") ?? "",
    lastName: tagValue(block, "lastName") ?? "",
    relationships: allTagValues(block, "relationship"),
    titleClarification: tagValue(block, "relationshipClarification") ?? "",
  }));

  return {
    cik: ref.cik,
    accession: ref.accession,
    form: ref.form,
    filedAt: ref.filedAt,
    // The XML's own entityName is authoritative; the search index's display name is a fallback
    // for the rare filing whose primaryIssuer block didn't parse.
    entityName: tagValue(issuerBlock, "entityName") ?? ref.companyName,
    entityType: tagValue(issuerBlock, "entityType"),
    city: tagValue(issuerBlock, "city"),
    state: tagValue(issuerBlock, "stateOrCountry") ?? ref.businessState,
    phone: tagValue(issuerBlock, "issuerPhoneNumber"),
    jurisdictionOfInc: tagValue(issuerBlock, "jurisdictionOfInc"),
    yearOfInc: tagValue(yearBlock, "value"),
    incorporatedWithinFiveYears: tagValue(yearBlock, "withinFiveYears") === "true",
    industryGroup: tagValue(offeringBlock, "industryGroupType"),
    investmentFundType: tagValue(offeringBlock, "investmentFundType"),
    revenueRange: tagValue(offeringBlock, "revenueRange"),
    totalOfferingAmount: numericValue(salesBlock, "totalOfferingAmount"),
    rawOfferingAmount: tagValue(salesBlock, "totalOfferingAmount"),
    totalAmountSold: numericValue(salesBlock, "totalAmountSold"),
    totalRemaining: numericValue(salesBlock, "totalRemaining"),
    minimumInvestmentAccepted: numericValue(offeringBlock, "minimumInvestmentAccepted"),
    dateOfFirstSale: tagValue(offeringBlock, "dateOfFirstSale"),
    isAmendment: ref.form === "D/A" || tagValue(offeringBlock, "isAmendment") === "true",
    relatedPersons,
  };
}

// ---------------------------------------------------------------------------
// Pure filtering — the play's capital-raise rules applied to parsed issuers
// ---------------------------------------------------------------------------

/** Why an issuer was dropped, counted so a run that sources nothing can say which rule did it
 * instead of reporting a bare zero. */
export type FormDRejectReason =
  | "pooled_investment_fund"
  | "industry_group"
  | "state"
  | "offering_too_small"
  | "offering_too_large"
  | "nothing_sold_yet"
  | "not_recently_incorporated"
  | "excluded_by_play"
  | "no_named_contacts";

export interface FormDFilterResult {
  kept: FormDIssuer[];
  rejected: Record<FormDRejectReason, number>;
}

function emptyRejections(): Record<FormDRejectReason, number> {
  return {
    pooled_investment_fund: 0,
    industry_group: 0,
    state: 0,
    offering_too_small: 0,
    offering_too_large: 0,
    nothing_sold_yet: 0,
    not_recently_incorporated: 0,
    excluded_by_play: 0,
    no_named_contacts: 0,
  };
}

function normalise(value: string): string {
  // Form D's taxonomy writes "and" where people type "&" ("Other Banking and Financial Services",
  // "Oil and Gas", "REITS and Finance"), so a config entry typed either way must match.
  return value.toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ").trim();
}

/**
 * Applies a play's capital-raise rules to parsed Form D issuers.
 *
 * The default that matters most is `excludePooledInvestmentFunds`. Roughly half of all Form D
 * filings are funds raising their own capital — a sample of 45 consecutive filings on 2026-09-17/18
 * was 22 pooled investment funds (10 VC, 5 PE, 1 hedge, 6 other) against 23 operating companies.
 * Left in, a fund raising its fund II would look exactly like a prospect that just closed a round,
 * and half of every run would be LPs-seeking-GPs rather than buyers. Plays that genuinely sell to
 * funds turn the exclusion off.
 */
export function filterFormDIssuers(
  issuers: FormDIssuer[],
  rules: OutboundCapitalRaise,
  icp: Pick<OutboundPlayIcp, "exclusions">,
): FormDFilterResult {
  const rejected = emptyRejections();
  const kept: FormDIssuer[] = [];

  const wantedGroups = rules.industryGroups.map(normalise).filter(Boolean);
  const wantedStates = rules.states.map((s) => s.trim().toUpperCase()).filter(Boolean);
  const exclusions = icp.exclusions.map((e) => e.trim().toLowerCase()).filter(Boolean);

  for (const issuer of issuers) {
    const group = issuer.industryGroup ? normalise(issuer.industryGroup) : "";

    if (rules.excludePooledInvestmentFunds && (group === "pooled investment fund" || issuer.investmentFundType !== null)) {
      rejected.pooled_investment_fund++;
      continue;
    }
    if (wantedGroups.length > 0 && !wantedGroups.includes(group)) {
      rejected.industry_group++;
      continue;
    }
    if (wantedStates.length > 0 && !(issuer.state && wantedStates.includes(issuer.state.toUpperCase()))) {
      rejected.state++;
      continue;
    }
    // An "Indefinite" offering amount (totalOfferingAmount null, rawOfferingAmount set) passes the
    // size gates rather than failing them — the filer declined to bound the raise, which is not
    // the same as raising nothing, and dropping those would silently lose large offerings.
    if (issuer.totalOfferingAmount !== null && issuer.totalOfferingAmount < rules.minOfferingUsd) {
      rejected.offering_too_small++;
      continue;
    }
    if (
      rules.maxOfferingUsd !== undefined &&
      issuer.totalOfferingAmount !== null &&
      issuer.totalOfferingAmount > rules.maxOfferingUsd
    ) {
      rejected.offering_too_large++;
      continue;
    }
    if (rules.requireAmountSold && !(issuer.totalAmountSold !== null && issuer.totalAmountSold > 0)) {
      rejected.nothing_sold_yet++;
      continue;
    }
    if (rules.onlyRecentlyIncorporated && !issuer.incorporatedWithinFiveYears) {
      rejected.not_recently_incorporated++;
      continue;
    }
    if (exclusions.length > 0 && exclusions.some((term) => issuer.entityName.toLowerCase().includes(term))) {
      rejected.excluded_by_play++;
      continue;
    }
    if (issuer.relatedPersons.length === 0) {
      rejected.no_named_contacts++;
      continue;
    }

    kept.push(issuer);
  }

  return { kept, rejected };
}

// ---------------------------------------------------------------------------
// Pure prospect shaping
// ---------------------------------------------------------------------------

function formatUsd(amount: number): string {
  if (amount >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(amount % 1_000_000_000 === 0 ? 0 : 1)}B`;
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(amount % 1_000_000 === 0 ? 0 : 1)}M`;
  if (amount >= 1_000) return `$${Math.round(amount / 1_000)}K`;
  return `$${amount}`;
}

/** The buying signal a Form D actually evidences, written the way the Strategist's timing and
 * signal scoring can read it — a dated, verifiable event with a dollar figure, not an inference. */
export function formDSignal(issuer: FormDIssuer): { primarySignal: string; additionalSignals: string[] } {
  const size =
    issuer.totalOfferingAmount !== null
      ? formatUsd(issuer.totalOfferingAmount)
      : issuer.rawOfferingAmount
        ? issuer.rawOfferingAmount.toLowerCase()
        : "an undisclosed amount";

  const primarySignal = `Filed SEC Form D on ${issuer.filedAt} — raising ${size} under Regulation D${
    issuer.totalAmountSold !== null && issuer.totalAmountSold > 0 ? `, ${formatUsd(issuer.totalAmountSold)} sold to date` : ""
  }`;

  const additionalSignals: string[] = [];
  if (issuer.totalRemaining !== null && issuer.totalRemaining > 0) {
    additionalSignals.push(`${formatUsd(issuer.totalRemaining)} of the offering still open`);
  }
  if (issuer.dateOfFirstSale) additionalSignals.push(`First sale ${issuer.dateOfFirstSale}`);
  if (issuer.industryGroup) additionalSignals.push(`Form D industry: ${issuer.industryGroup}`);
  if (issuer.revenueRange && !/decline to disclose|not applicable/i.test(issuer.revenueRange)) {
    additionalSignals.push(`Self-reported revenue: ${issuer.revenueRange}`);
  }
  if (issuer.incorporatedWithinFiveYears && issuer.yearOfInc) {
    additionalSignals.push(`Incorporated ${issuer.yearOfInc} (${issuer.jurisdictionOfInc ?? "jurisdiction not stated"})`);
  }
  if (issuer.minimumInvestmentAccepted !== null && issuer.minimumInvestmentAccepted > 0) {
    additionalSignals.push(`Minimum investment ${formatUsd(issuer.minimumInvestmentAccepted)}`);
  }
  additionalSignals.push(`SEC accession ${issuer.accession}`);
  return { primarySignal, additionalSignals };
}

/** One person to look up in Apollo, carrying the issuer they came from so the match can be scoped
 * by company name and the resulting prospect can inherit the filing's signal. */
export interface FormDContactCandidate {
  firstName: string;
  lastName: string;
  organizationName: string;
  relationships: string[];
  titleClarification: string;
  issuer: FormDIssuer;
}

/** Tokens that mark a related-person entry as a company rather than a human. Deliberately short
 * and unambiguous: every one of these is a legal-entity suffix or a fund-structure word that
 * effectively never appears as a person's given or family name, so matching them whole-word can't
 * plausibly discard a real signatory. */
const ENTITY_NAME_TOKENS = [
  "llc",
  "l.l.c",
  "inc",
  "corp",
  "ltd",
  "lp",
  "l.p",
  "llp",
  "gp",
  "plc",
  "trust",
  "partners",
  "holdings",
  "ventures",
  "fund",
  "associates",
];

/**
 * True when a Form D signatory is an entity, not a person.
 *
 * Form D's `relatedPersonsList` is not limited to natural people: a fund's managing member, a
 * sponsor LLC, or a corporate promoter is filed in the same structure, and EDGAR has no flag
 * saying which is which. Filers encode it three ways, all three seen in live filings on
 * 2026-09-21:
 *   - the entity's name duplicated into both name fields ("WM 96 MM LLC" / "WM 96 MM LLC")
 *   - a placeholder in the first name and the entity in the last ("-" / "Rose's Restaurant
 *     Group, LLC")
 *   - a plain company name split across the two fields ("Marble" / "Partners")
 *
 * None of them can ever match a person in Apollo, but each one still costs a credit to find that
 * out — in a live sample, 3 of 14 otherwise-eligible signatories (21% of the run's spend) were
 * entities. So they're dropped before the lookup, not after it.
 */
export function looksLikeEntityName(firstName: string, lastName: string): boolean {
  const first = firstName.trim();
  const last = lastName.trim();
  if (!first || !last) return true;

  // A name field with no letters at all ("-", "N/A" punctuation, an empty placeholder).
  if (!/\p{L}/u.test(first) || !/\p{L}/u.test(last)) return true;

  // The same string in both fields is EDGAR's commonest entity encoding; a person whose given and
  // family name are genuinely identical would be discarded here, which is a trade worth making
  // against a pattern this frequent.
  if (first.toLowerCase() === last.toLowerCase()) return true;

  const haystack = `${first} ${last}`.toLowerCase();
  return ENTITY_NAME_TOKENS.some((token) => new RegExp(`(^|[^a-z])${token.replace(/\./g, "\\.")}([^a-z]|$)`).test(haystack));
}

/**
 * Which signatories to spend an Apollo match on, best first.
 *
 * Form D names officers, directors and promoters but never their email, so each one costs a
 * credit to resolve — ranking matters more than it does in the ICP-search path, where Apollo has
 * already ranked the results. Order: anyone whose free-text title clarification matches a title
 * the play is targeting, then executive officers, then the rest. Within a tie, filing order,
 * which puts the person who signed first (almost always the CEO) ahead of the others.
 */
export function selectFormDContacts(
  issuers: FormDIssuer[],
  opts: { titles: string[]; relationships: string[]; perIssuer: number; cap: number },
): FormDContactCandidate[] {
  const wantedTitles = opts.titles.map((t) => t.trim().toLowerCase()).filter(Boolean);
  const wantedRelationships = opts.relationships.map(normalise).filter(Boolean);
  const out: FormDContactCandidate[] = [];

  for (const issuer of issuers) {
    const eligible = issuer.relatedPersons
      .map((person, index) => ({ person, index }))
      .filter(({ person }) => {
        // Entities filed as related persons can't be matched to a contact and would spend a
        // credit proving it — see looksLikeEntityName.
        if (looksLikeEntityName(person.firstName, person.lastName)) return false;
        if (wantedRelationships.length === 0) return true;
        return person.relationships.some((r) => wantedRelationships.includes(normalise(r)));
      })
      .map(({ person, index }) => {
        const clarification = person.titleClarification.toLowerCase();
        const titleHit = wantedTitles.length > 0 && wantedTitles.some((t) => clarification.includes(t));
        const isOfficer = person.relationships.some((r) => normalise(r) === "executive officer");
        return { person, index, rank: titleHit ? 0 : isOfficer ? 1 : 2 };
      })
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .slice(0, Math.max(0, opts.perIssuer));

    for (const { person } of eligible) {
      out.push({
        firstName: person.firstName.trim(),
        lastName: person.lastName.trim(),
        organizationName: issuer.entityName,
        relationships: person.relationships,
        titleClarification: person.titleClarification,
        issuer,
      });
    }
  }

  return out.slice(0, Math.max(0, opts.cap));
}

/** The prospect record for a candidate Apollo could not resolve to a contact — real company, real
 * named officer, real filing, no email. Never persisted (OutboundProspect.email is required); it
 * exists so a run reports the accounts it found rather than throwing them away when Apollo has no
 * record of a freshly-incorporated issuer's officers. */
export function formDAccountRecord(candidate: FormDContactCandidate): Record<string, unknown> {
  const { primarySignal, additionalSignals } = formDSignal(candidate.issuer);
  const issuer = candidate.issuer;
  return {
    firstName: candidate.firstName,
    lastName: candidate.lastName,
    email: "",
    title: candidate.titleClarification || candidate.relationships.join(", "),
    company: issuer.entityName,
    companyDomain: "",
    industry: issuer.industryGroup ?? "",
    geography: [issuer.city, issuer.state].filter(Boolean).join(", "),
    phone: issuer.phone ?? "",
    primarySignal,
    additionalSignals,
    dataQualityScore: 2,
    secFormD: {
      cik: issuer.cik,
      accession: issuer.accession,
      filedAt: issuer.filedAt,
      offeringAmount: issuer.totalOfferingAmount,
      amountSold: issuer.totalAmountSold,
      industryGroup: issuer.industryGroup,
      url: formDFilingUrl(issuer),
    },
  };
}

/** Human-readable link to the filing, so a reviewer approving the run can check the source. */
export function formDFilingUrl(issuer: Pick<FormDIssuer, "cik" | "accession">): string {
  return `${EDGAR_ARCHIVES}/${issuer.cik}/${issuer.accession.replace(/-/g, "")}/primary_doc.xml`;
}

/** The filed-date window to search, as EDGAR's `startdt`/`enddt` want it. Clamped to today so a
 * clock skew or a silly lookback can't ask EDGAR for the future. */
export function formDDateWindow(lookbackDays: number, now = new Date()): { startDate: string; endDate: string } {
  const end = new Date(now);
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - Math.max(1, lookbackDays));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { startDate: iso(start), endDate: iso(end) };
}

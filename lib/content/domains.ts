/**
 * Turning what people type into "Preferred sources" / "Never link these
 * domains" into something web_search accepts.
 *
 * The fields are free text, and people write sentences in them: a live run
 * had "High authority sites like hbr.org etc." as its preferred sources and
 * "other competitors of vdr.ai" among its blocked domains. Both went straight
 * into allowed_domains / blocked_domains, and the API rejects the whole request
 * on any entry that is not a plain hostname — the run died in under a second.
 *
 * So each entry is either a domain (goes to the search filter) or a note (goes
 * to the research instructions, where a sentence is useful). Nothing is dropped.
 * The split is per entry, never a regex hunt for hostnames inside prose:
 * "other competitors of vdr.ai" names the client's OWN site, and blocking it
 * would be exactly wrong.
 */

const HOSTNAME = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** `https://www.Example.com/path` → `example.com`; null when the entry is not a hostname. */
export function bareDomain(value: string): string | null {
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]!
    .replace(/\.$/, "");
  return HOSTNAME.test(host) ? host : null;
}

/** Split entries into search-filter domains (bare, deduped) and prose notes. */
export function splitDomainEntries(values: string[]): { domains: string[]; notes: string[] } {
  const domains = new Set<string>();
  const notes: string[] = [];
  for (const value of values) {
    const host = bareDomain(value);
    if (host) domains.add(host);
    else if (value.trim()) notes.push(value.trim());
  }
  return { domains: [...domains], notes };
}

/**
 * Bare, deduped, valid hosts — the only shape web_search's filters accept.
 * Both filters also reject a list with a repeat in it.
 */
export function domainList(values: string[]): string[] {
  return splitDomainEntries(values).domains;
}

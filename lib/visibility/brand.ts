import { prisma } from "@/lib/prisma";
import { hostOf } from "@/lib/answer-engines";

export interface BrandIdentity {
  /** Display name for the workspace's own brand. */
  name: string;
  /** Every string that counts as naming us in an answer. Lowercased. */
  terms: string[];
  /** Our own site, bare host. Null when the profile has no website. */
  domain: string | null;
  competitors: Array<{ name: string; terms: string[]; domain: string | null }>;
}

/**
 * Who we are measuring, and who we are measuring against.
 *
 * BusinessProfile.competitors is a bare String[] of names — enough to put in a
 * prompt, not enough to measure: share of voice needs a stable identity across
 * days and a domain to recognise in a citation. So the array is seeded into the
 * Competitor table the first time this runs, and the table is the source of
 * truth from then on. Editing a competitor there does not get overwritten by
 * the profile on the next capture.
 */
export async function resolveBrand(workspaceId: string): Promise<BrandIdentity | null> {
  const [profile, stored] = await Promise.all([
    prisma.businessProfile.findUnique({ where: { workspaceId } }),
    prisma.competitor.findMany({ where: { workspaceId, active: true }, orderBy: { name: "asc" } }),
  ]);

  if (!profile?.businessName) return null;

  let competitors = stored;
  if (competitors.length === 0 && profile.competitors.length > 0) {
    await prisma.competitor.createMany({
      data: profile.competitors
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => ({ workspaceId, name, domain: hostOf(name) })),
      skipDuplicates: true,
    });
    competitors = await prisma.competitor.findMany({
      where: { workspaceId, active: true },
      orderBy: { name: "asc" },
    });
  }

  const domain = profile.websiteUrl ? hostOf(profile.websiteUrl) : null;

  return {
    name: profile.businessName,
    terms: termsFor(profile.businessName, domain),
    domain,
    competitors: competitors.map((c) => ({
      name: c.name,
      terms: termsFor(c.name, c.domain, c.aliases),
      domain: c.domain,
    })),
  };
}

/**
 * The strings that mean "this brand" in a sentence.
 *
 * Deliberately conservative. An over-eager term list is worse than a short one
 * here: a false positive reports visibility the brand does not have, and that
 * is the exact failure mode this feature was built to end. So a bare domain
 * contributes its label ("dev.co" → "dev.co" and "dev"), but a single word
 * shorter than three characters is dropped — "Co", "AI" and "Go" match
 * everything.
 */
export function termsFor(name: string, domain: string | null, aliases: string[] = []): string[] {
  const out = new Set<string>();
  const add = (t: string) => {
    const term = t.trim().toLowerCase();
    if (term.length >= 3) out.add(term);
  };

  add(name);
  for (const alias of aliases) add(alias);
  if (domain) {
    add(domain);
    const label = domain.split(".")[0];
    if (label) add(label);
  }

  // "Acme Corp" should also match a bare "Acme", but only when the leading
  // word is distinctive enough to stand alone.
  const first = name.trim().split(/\s+/)[0];
  if (first && first.length >= 4 && name.trim().split(/\s+/).length > 1) add(first);

  return [...out];
}

/**
 * Where a term first appears in the text, or -1.
 *
 * Matching is on word boundaries so "Notion" does not match "Notional", and a
 * dotted term like "dev.co" is escaped rather than treated as a pattern. The
 * boundary before a term that starts with a letter is \b; for a term that
 * begins with punctuation \b would never match, so the check falls back to a
 * plain indexOf for those.
 */
export function firstIndexOfTerm(text: string, term: string): number {
  const haystack = text.toLowerCase();
  const needle = term.toLowerCase();
  if (!/^[a-z0-9]/.test(needle)) return haystack.indexOf(needle);

  const pattern = new RegExp(`(?<![a-z0-9])${escapeRegex(needle)}(?![a-z0-9])`, "i");
  const match = pattern.exec(haystack);
  return match ? match.index : -1;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

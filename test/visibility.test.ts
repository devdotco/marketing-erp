/**
 * The pure half of AI visibility measurement — brand matching, answer
 * analysis, the observation slice key, and series deltas. No network, no
 * database. Run with `npm run test:visibility`.
 *
 * Brand matching gets the most coverage on purpose. A false positive here
 * reports visibility a brand does not have, which is precisely the failure
 * this whole feature was built to end — a wrong number that looks measured is
 * worse than no number at all.
 */
import { termsFor, firstIndexOfTerm, type BrandIdentity } from "@/lib/visibility/brand";
import { analyseMentions } from "@/lib/visibility/analyse";
import { dimensionKeyFor } from "@/lib/visibility/observations";
import { deltaOf } from "@/lib/visibility/series";
import { dedupeCitations, hostOf } from "@/lib/answer-engines/parse";
import { geminiDomain } from "@/lib/answer-engines/gemini";

let failures = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!cond) failures += 1;
};

// ── termsFor ────────────────────────────────────────────────────────────────
{
  const t = termsFor("Acme Corp", "acme.com");
  check("termsFor: includes the full name", t.includes("acme corp"), t);
  check("termsFor: includes the domain", t.includes("acme.com"), t);
  check("termsFor: includes the domain label", t.includes("acme"), t);

  const short = termsFor("Go", "go.co");
  check("termsFor: drops a name shorter than 3 characters", !short.includes("go"), short);

  const single = termsFor("Notion", null);
  check("termsFor: a one-word name contributes only itself", single.length === 1 && single[0] === "notion", single);

  const shortFirst = termsFor("Vi Be Co", null);
  check("termsFor: a leading word under 4 characters is not a standalone term", !shortFirst.includes("vi"), shortFirst);
}

// ── firstIndexOfTerm ────────────────────────────────────────────────────────
{
  check(
    "firstIndexOfTerm: does not match inside a longer word",
    firstIndexOfTerm("Notional value rose", "notion") === -1,
    firstIndexOfTerm("Notional value rose", "notion"),
  );
  check(
    "firstIndexOfTerm: matches a whole word",
    firstIndexOfTerm("We recommend Notion for this", "notion") === 13,
    firstIndexOfTerm("We recommend Notion for this", "notion"),
  );
  check(
    "firstIndexOfTerm: a dotted term is escaped, not treated as a pattern",
    firstIndexOfTerm("See devXco for details", "dev.co") === -1,
    firstIndexOfTerm("See devXco for details", "dev.co"),
  );
  check(
    "firstIndexOfTerm: matches a real dotted term",
    firstIndexOfTerm("See dev.co for details", "dev.co") === 4,
    firstIndexOfTerm("See dev.co for details", "dev.co"),
  );
  check(
    "firstIndexOfTerm: is case-insensitive",
    firstIndexOfTerm("ACME CORP leads", "acme corp") === 0,
    firstIndexOfTerm("ACME CORP leads", "acme corp"),
  );
}

// ── analyseMentions ─────────────────────────────────────────────────────────
const brand: BrandIdentity = {
  name: "Acme",
  terms: ["acme", "acme.com"],
  domain: "acme.com",
  competitors: [
    { name: "Globex", terms: ["globex"], domain: "globex.com" },
    { name: "Initech", terms: ["initech"], domain: "initech.com" },
  ],
};

{
  const a = analyseMentions("Globex is popular, though Acme is cheaper. Initech also exists.", brand);
  check("analyseMentions: finds the brand", a.brandMentioned, a);
  check("analyseMentions: rank is order of first mention", a.brandRank === 2, a);
  check("analyseMentions: finds both competitors", a.competitors.length === 2, a.competitors);

  const b = analyseMentions("Acme is the clear choice here.", brand);
  check("analyseMentions: first mention ranks 1", b.brandRank === 1, b);
  check("analyseMentions: no competitors found when none named", b.competitors.length === 0, b.competitors);

  const c = analyseMentions("Globex and Initech are the leaders.", brand);
  check("analyseMentions: absent brand has a null rank, not zero", c.brandRank === null && !c.brandMentioned, c);

  // The regression that matters: a substring match would report visibility
  // this brand does not have.
  const d = analyseMentions("Acmeister Tools is unrelated.", brand);
  check("analyseMentions: a brand name inside another word is NOT a mention", !d.brandMentioned, d);
}

// ── dimensionKeyFor ─────────────────────────────────────────────────────────
{
  check("dimensionKeyFor: no slice is the empty string", dimensionKeyFor({}) === "", dimensionKeyFor({}));
  check(
    "dimensionKeyFor: keys are sorted, so argument order cannot fork a row",
    dimensionKeyFor({ topic: "pricing", engine: "CLAUDE" }) === dimensionKeyFor({ engine: "CLAUDE", topic: "pricing" }),
    dimensionKeyFor({ topic: "pricing", engine: "CLAUDE" }),
  );
  check(
    "dimensionKeyFor: distinct slices produce distinct keys",
    dimensionKeyFor({ engine: "CLAUDE" }) !== dimensionKeyFor({ engine: "OPENAI" }),
    [dimensionKeyFor({ engine: "CLAUDE" }), dimensionKeyFor({ engine: "OPENAI" })],
  );
}

// ── deltaOf ─────────────────────────────────────────────────────────────────
{
  const none = deltaOf({ subject: "brand", metric: "visibility", points: [] });
  check("deltaOf: no points reports nothing rather than zero", none.latest === null && none.change === null, none);

  const one = deltaOf({ subject: "brand", metric: "visibility", points: [{ day: "2026-09-20", value: 40 }] });
  check("deltaOf: a single point has a value but no change", one.latest === 40 && one.change === null, one);

  const many = deltaOf({
    subject: "brand",
    metric: "visibility",
    points: [
      { day: "2026-09-18", value: 40 },
      { day: "2026-09-19", value: 45 },
      { day: "2026-09-20", value: 52.5 },
    ],
  });
  check("deltaOf: change is measured from the start of the window", many.change === 12.5, many);
  check("deltaOf: samples counts the days with figures", many.samples === 3, many);
}

// ── citations ───────────────────────────────────────────────────────────────
{
  check("hostOf: strips www", hostOf("https://www.Example.com/a/b") === "example.com", hostOf("https://www.Example.com/a/b"));
  check("hostOf: junk returns null rather than throwing", hostOf("not a url") === null, hostOf("not a url"));

  const deduped = dedupeCitations([
    { url: "https://a.com/1" },
    { url: "https://a.com/1" },
    { url: "https://b.com/2", title: "B" },
  ]);
  check("dedupeCitations: a repeated source counts once", deduped.length === 2, deduped);
  check("dedupeCitations: positions are 1-based and sequential", deduped[0].position === 1 && deduped[1].position === 2, deduped);
  check("dedupeCitations: an empty url is dropped", dedupeCitations([{ url: "  " }]).length === 0);
}

// ── geminiDomain ────────────────────────────────────────────────────────────
{
  const redirect = {
    url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123",
    title: "techcrunch.com",
  };
  check(
    "geminiDomain: prefers the title, because the URL is a Vertex redirect",
    geminiDomain(redirect) === "techcrunch.com",
    geminiDomain(redirect),
  );
  check(
    "geminiDomain: falls back to the URL host when the title is prose",
    geminiDomain({ url: "https://www.bbc.co.uk/news/x", title: "A long headline" }) === "bbc.co.uk",
    geminiDomain({ url: "https://www.bbc.co.uk/news/x", title: "A long headline" }),
  );
  // The regression: a headline label on a redirect URL used to record
  // Google's own redirector as a cited publisher, where it climbed to the top
  // of the citation table. Dropping the source is the smaller error.
  check(
    "geminiDomain: a prose title on a redirect URL yields null, not Google's redirector",
    geminiDomain({ url: redirect.url, title: "Best CRM tools of 2026" }) === null,
    geminiDomain({ url: redirect.url, title: "Best CRM tools of 2026" }),
  );
  check(
    "geminiDomain: a redirect URL with no title at all yields null",
    geminiDomain({ url: redirect.url }) === null,
    geminiDomain({ url: redirect.url }),
  );
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

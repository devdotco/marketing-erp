/**
 * The pre-approval checks for a campaign email. These run in code, on the
 * exact HTML that goes to SendGrid, after the model has finished: a prompt can
 * ask for "no prices", only this can promise it.
 *
 * Every failure is blocking. The handler gives the model one repair pass with
 * the failures quoted back, and a draft that still fails never reaches
 * Awaiting approval. Pure module, no I/O.
 */
import {
  handlebarsTags,
  hrefsOf,
  swapUnsubscribeLinks,
  lockedSkeleton,
  SENDGRID_PREFERENCES,
  SENDGRID_UNSUBSCRIBE,
  visibleText,
  type ParsedTemplate,
  type SectionValues,
} from "./template";

export interface CheckInput {
  master: string;
  /** Rendered, before the unsubscribe swap. Compared against the master for the locked skeleton. */
  rendered: string;
  /** What is sent: `rendered` after the unsubscribe swap. */
  final: string;
  /** Every subject option offered to the approver. Each one must pass. */
  subjects: string[];
  values: SectionValues;
  parsed: ParsedTemplate;
  /** Section keys the campaign allows to change. */
  editableKeys: string[];
  /** Subjects and headlines from this campaign's recent runs. */
  recentSubjects: string[];
  recentHeadlines: string[];
  /** From the workspace's editorial profile. */
  allowEmDash: boolean;
  bannedWords: string[];
  bannedPhrases: string[];
  /** Max characters per text/rich section, keyed by section key. */
  maxLengths: Record<string, number>;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface CheckReport {
  passed: boolean;
  results: CheckResult[];
  failures: string[];
}

/**
 * Money in copy. "$" and the other currency signs on their own, a currency
 * code beside a number, and the usual ways a price is written without a sign.
 * Deliberately broad: a false positive costs one repair pass; a price in a
 * send costs an owner rule (no public pricing anywhere).
 */
const PRICE_PATTERNS: Array<[RegExp, string]> = [
  [/[$€£¥₹]/, "a currency sign"],
  [/\b(?:usd|eur|gbp|cad|aud)\b/i, "a currency code"],
  [/\b\d[\d,.]*\s*(?:k\s*)?(?:dollars?|bucks|cents?|euros?|pounds?)\b/i, "a price in words"],
  [/\b\d[\d,.]*\s*(?:\/|per\s+|a\s+)(?:mo|month|yr|year|user|seat|release|post|hour|hr)\b/i, "a per-unit price"],
  [/\b\d{1,3}\s*%\s*off\b/i, "a discount figure"],
  [/\b(?:starting at|starts at|priced at|for just|for only)\s+\d/i, "a 'starting at N' price"],
];

export function findPrice(text: string): string | null {
  for (const [re, label] of PRICE_PATTERNS) {
    const m = re.exec(text);
    if (m) return `${label} ("${text.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20).trim()}")`;
  }
  return null;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
// HTML lets these close implicitly; email masters do close them, but a missing </p> is not a broken email.
const OPTIONAL_CLOSE = new Set(["p", "li", "td", "th", "tr", "tbody", "thead", "option"]);

/** Tag balance, outside comments (which hold the MSO conditionals). Returns the first problem, or null. */
export function htmlProblem(html: string): string | null {
  if (!/<html\b/i.test(html) || !/<\/html>/i.test(html)) return "the document has no <html>…</html> wrapper";
  if (!/<body\b/i.test(html) || !/<\/body>/i.test(html)) return "the document has no <body>…</body>";
  // Not a count of "<!--" vs "-->": Outlook's <!--[if !mso]><!-- --> opens twice and closes once, legally.
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  if (withoutComments.includes("<!--")) return "an HTML comment is never closed";

  const body = withoutComments.replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, "");
  const stack: string[] = [];
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)\b[^>]*?(\/?)>/g)) {
    const name = m[2]!.toLowerCase();
    if (name === "!doctype" || VOID.has(name) || m[3] === "/") continue;
    if (!m[1]) {
      stack.push(name);
      continue;
    }
    const at = stack.lastIndexOf(name);
    if (at === -1) return `</${name}> closes nothing`;
    const skipped = stack.slice(at + 1).filter((t) => !OPTIONAL_CLOSE.has(t));
    if (skipped.length > 0) return `<${skipped[skipped.length - 1]}> is never closed before </${name}>`;
    stack.length = at;
  }
  const unclosed = stack.filter((t) => !OPTIONAL_CLOSE.has(t));
  if (unclosed.length > 0) return `<${unclosed[unclosed.length - 1]}> is never closed`;
  if (/<[a-zA-Z][^>]*$/.test(body)) return "the document ends inside a tag";
  return null;
}

export function normalizeLine(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function textOf(value: string | string[] | undefined): string {
  if (value === undefined) return "";
  return visibleText(Array.isArray(value) ? value.join(" ") : value);
}

export function runChecks(input: CheckInput): CheckReport {
  const results: CheckResult[] = [];
  const add = (name: string, problem: string | null | undefined) =>
    results.push(problem ? { name, passed: false, detail: problem } : { name, passed: true });

  // 1. Locked regions untouched, and only allowed sections changed.
  add(
    "Locked template unchanged",
    lockedSkeleton(input.master) === lockedSkeleton(input.rendered)
      ? null
      : "Something outside the edit markers differs from the master template.",
  );
  const allowed = new Set(input.editableKeys);
  const strays = Object.keys(input.values).filter((k) => !allowed.has(k));
  add("Only allowed sections changed", strays.length ? `Changed sections this campaign does not allow: ${strays.join(", ")}.` : null);

  // 2. Handlebars intact: every merge tag in the master, in order, and no new ones.
  const expected = handlebarsTags(input.master);
  const actual = handlebarsTags(input.rendered);
  add(
    "Handlebars intact",
    expected.join("\u0000") === actual.join("\u0000")
      ? null
      : `Merge tags differ from the master. Expected ${expected.join(" ") || "none"}; found ${actual.join(" ") || "none"}.`,
  );
  if (input.subjects.some((s) => /\{\{/.test(s))) add("No merge tags in the subject", "A subject option contains a Handlebars tag.");

  // 3. Unsubscribe tags swapped in, and no placeholder link left.
  const hasUnsub = input.final.includes(`href="${SENDGRID_UNSUBSCRIBE}"`);
  const placeholder = /<a\b[^>]*href="#"[^>]*>/i.exec(input.final);
  add(
    "Unsubscribe tags swapped",
    !hasUnsub
      ? `No unsubscribe link carries ${SENDGRID_UNSUBSCRIBE}. SendGrid will refuse the send without one.`
      : placeholder
        ? `A link still points at "#": ${placeholder[0].slice(0, 120)}`
        : null,
  );
  if (input.master.includes("Unsubscribe--unsubscribePreferences") && !input.final.includes(`href="${SENDGRID_PREFERENCES}"`)) {
    add("Preferences link swapped", `The preferences link does not carry ${SENDGRID_PREFERENCES}.`);
  }

  // 3b. Every link and CTA exactly as the master has them (after the unsubscribe swap).
  const expectedLinks = hrefsOf(swapUnsubscribeLinks(input.master)).sort();
  const actualLinks = hrefsOf(input.final).sort();
  const missing = expectedLinks.filter((h, i, all) => all.indexOf(h) === i && expectedLinks.filter((x) => x === h).length > actualLinks.filter((x) => x === h).length);
  const added = actualLinks.filter((h, i, all) => all.indexOf(h) === i && actualLinks.filter((x) => x === h).length > expectedLinks.filter((x) => x === h).length);
  add(
    "Links and CTAs unchanged",
    missing.length || added.length
      ? [missing.length ? `missing ${missing.join(", ")}` : "", added.length ? `new ${added.join(", ")}` : ""].filter(Boolean).join("; ")
      : null,
  );

  // 4. Valid HTML.
  add("Valid HTML", htmlProblem(input.final));

  // 5. No price figures anywhere a reader sees: subject, preheader, body.
  const readable = `${input.subjects.join("\n")}\n${visibleText(input.final)}`;
  const price = findPrice(readable);
  add("No prices or $", price ? `Found ${price}.` : null);

  // 6. Subject and headline not reused from recent runs.
  const subjects = input.subjects.map((s) => s.trim()).filter(Boolean);
  add("Subject options present", subjects.length ? null : "There is no subject line.");
  const recent = new Set(input.recentSubjects.map(normalizeLine));
  const reusedSubjects = subjects.filter((s) => recent.has(normalizeLine(s)));
  add("Subject not reused", reusedSubjects.length ? `Already used by this campaign: ${reusedSubjects.map((s) => `"${s}"`).join(", ")}.` : null);
  const headline = textOf(input.values.headline ?? input.parsed.sections.find((s) => s.key === "headline")?.original);
  if (headline && "headline" in input.values) {
    const reusedHeadline = input.recentHeadlines.find((h) => normalizeLine(h) === normalizeLine(headline));
    add("Headline not reused", reusedHeadline ? `"${headline}" was already used by this campaign.` : null);
  }

  // 7. The editorial profile's hard rules, on what the model wrote (the master is the owner's own copy).
  const written = `${subjects.join("\n")}\n${Object.values(input.values).map((v) => textOf(v)).join("\n")}`;
  if (!input.allowEmDash) add("No em dashes", /—/.test(written) ? "The new copy uses an em dash." : null);
  const lower = written.toLowerCase();
  const banned = [
    ...input.bannedWords.filter((w) => new RegExp(`\\b${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower)),
    ...input.bannedPhrases.filter((p) => lower.includes(p.toLowerCase())),
  ];
  add("No banned words", banned.length ? `Uses ${banned.map((b) => `"${b}"`).join(", ")}.` : null);

  // 8. Length: a section that balloons breaks the design on mobile.
  const tooLong = Object.entries(input.values).flatMap(([key, value]) => {
    const max = input.maxLengths[key];
    if (!max) return [];
    const parts = Array.isArray(value) ? value : [value];
    return parts.some((p) => visibleText(p).length > max) ? [`${key} (max ${max} characters per block)`] : [];
  });
  add("Sections within length", tooLong.length ? `Too long: ${tooLong.join(", ")}.` : null);
  const longSubject = subjects.find((s) => s.length > 90);
  add("Subject within length", longSubject ? `"${longSubject}" is ${longSubject.length} characters; keep subjects under 90.` : null);

  const failures = results.filter((r) => !r.passed).map((r) => `${r.name}: ${r.detail}`);
  return { passed: failures.length === 0, results, failures };
}

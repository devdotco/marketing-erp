/**
 * What the agents grid tells a person about each agent.
 *
 * These verdicts decide the pill, the sentence and the button on every card, so
 * a wrong one is not a cosmetic bug — it sends someone to connect an
 * integration they already have, or says "Ready" about an agent that will fail
 * the moment they press Run.
 *
 * No network and no database: everything here is pure. Run with
 * `npm run test:readiness`.
 */
import { AGENTS, getAgent } from "@/lib/agents";
import {
  readinessFor,
  requiredProviderGroups,
  upstreamAgents,
  chipsFor,
  PROVIDERS_BY_LABEL,
  SOCIAL_LABELS,
  GROUP_LABELS,
  type ReadinessFacts,
} from "@/lib/agent-readiness-rules";

let failures = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!cond) failures += 1;
};

const agent = (slug: string) => {
  const a = getAgent(slug);
  if (!a) throw new Error(`test refers to an agent that no longer exists: ${slug}`);
  return a;
};

const facts = (over: Partial<ReadinessFacts> = {}): ReadinessFacts => ({
  enabled: true,
  connected: new Set<string>(),
  lastRunStatus: null,
  lastRunError: null,
  awaiting: 0,
  usableUpstream: new Set<string>(),
  hasModelKey: true,
  ...over,
});

const ALL_CMS = new Set(["WORDPRESS", "STORYBLOK", "WEBFLOW", "PAYLOAD"]);

// ── 1. Every label on a card can be resolved ────────────────────────────────
// A label in lib/agents.ts with no provider entry renders a grey dot forever,
// which reads as "not connected" for something that may well be connected.
{
  const labels = [...new Set(AGENTS.flatMap((a) => a.integrations))];
  const unmapped = labels.filter(
    (l) => !PROVIDERS_BY_LABEL[l] && !SOCIAL_LABELS[l] && !l.includes("no key required"),
  );
  check("every integration label on a card maps to a provider (or is explicitly keyless)", unmapped.length === 0, unmapped);
}

// ── 2. Required-vs-optional is read off the run form ─────────────────────────
{
  // The Blog Writer's CMS Target defaults to "None (draft only)": it drafts
  // perfectly well with nothing connected, and must not be told to connect a CMS.
  check("Blog Writer declares no required integration", requiredProviderGroups("blog-writer").length === 0, requiredProviderGroups("blog-writer"));
  // The On-site Publisher's whole job is the CMS, and its Target CMS is required.
  const publisher = requiredProviderGroups("on-site-publisher");
  check("On-site Publisher requires a CMS", publisher.length === 1 && publisher[0].length === 4, publisher);
  check(
    "a CMS requirement is any-one-of, not all-of",
    readinessFor(agent("on-site-publisher"), facts({ connected: new Set(["PAYLOAD"]), usableUpstream: new Set(["blog-writer"]) })).state === "ready",
  );
}

// ── 3. Each state, and the order they win in ────────────────────────────────
{
  const blogWriter = agent("blog-writer");

  const waiting = readinessFor(blogWriter, facts({ awaiting: 1 }));
  check("a draft awaiting review shows as awaiting approval", waiting.state === "awaiting-approval", waiting.state);
  check("it counts as work waiting on a person", waiting.group === "needs-you", waiting.group);
  check("it links to that agent's own approval queue", waiting.action?.href === "/runs?status=AWAITING_APPROVAL&agent=blog-writer", waiting.action);
  check("one draft is described in the singular", waiting.note.includes("1 draft is waiting"), waiting.note);
  check("several drafts are described in the plural", readinessFor(blogWriter, facts({ awaiting: 3 })).note.includes("3 drafts are waiting"));

  // A finished draft nobody has looked at outranks a failure: it is the only
  // state where the work is done and stopped purely for want of a human.
  check(
    "a waiting draft outranks a later failed run",
    readinessFor(blogWriter, facts({ awaiting: 1, lastRunStatus: "FAILED" })).state === "awaiting-approval",
  );

  const failed = readinessFor(blogWriter, facts({
    lastRunStatus: "FAILED",
    lastRunError: { message: "Model not found (404). The run stopped before any work began." },
  }));
  check("a failed last run shows as failed", failed.state === "failed", failed.state);
  check("the card repeats the run's own plain-English reason, not a generic one", failed.note.startsWith("Model not found"), failed.note);
  check("a failed run with no stored error still says something true", readinessFor(blogWriter, facts({ lastRunStatus: "FAILED" })).note.length > 0);

  check("a completed last run is not treated as a failure", readinessFor(blogWriter, facts({ lastRunStatus: "COMPLETED" })).state === "ready");

  const off = readinessFor(blogWriter, facts({ enabled: false }));
  check("an agent this workspace has not turned on shows as not set up", off.state === "not-set-up", off.state);
  check("not set up is its own filter group, separate from needing you", off.group === "not-set-up", off.group);

  // A failure is worth more than "not set up": the agent clearly was set up
  // once, and the fix is on the run, not on the toggle.
  check(
    "a failed run still shows as failed on an agent that was since turned off",
    readinessFor(blogWriter, facts({ enabled: false, lastRunStatus: "FAILED" })).state === "failed",
  );

  const linking = readinessFor(agent("internal-linking"), facts());
  check("an enabled agent missing a required integration says so", linking.state === "needs-integration", linking.state);
  check("it names the alternatives rather than one arbitrary provider", linking.note.includes(" or "), linking.note);
  check("it sends you to the integrations page", linking.action?.href === "/integrations", linking.action);

  const blocked = readinessFor(agent("on-site-publisher"), facts({ connected: ALL_CMS }));
  check("an agent waiting on another agent's approved output shows as blocked", blocked.state === "blocked", blocked.state);
  check("blocked counts as work waiting on a person", blocked.group === "needs-you", blocked.group);
  check("it offers the upstream agent, not the integrations page", blocked.action?.href.startsWith("/agents/") === true, blocked.action);
  check(
    "approved upstream output unblocks it",
    readinessFor(agent("on-site-publisher"), facts({ connected: ALL_CMS, usableUpstream: new Set(["blog-writer"]) })).state === "ready",
  );

  // A missing integration is the more specific, more actionable answer.
  check(
    "a missing integration is reported before an upstream dependency",
    readinessFor(agent("on-site-publisher"), facts()).state === "needs-integration",
  );

  const ready = readinessFor(blogWriter, facts());
  check("an agent with nothing missing is ready", ready.state === "ready", ready.state);
  check("ready offers a run", ready.action?.label === "Run", ready.action);

  const noKey = readinessFor(blogWriter, facts({ hasModelKey: false }));
  check("with no Anthropic key nothing is called ready", noKey.state === "needs-integration", noKey.state);
  check("and the card says which key", noKey.note.includes("Anthropic"), noKey.note);
  // Asked last on purpose: a workspace with no key and an unconnected CMS
  // should be told about the CMS on that card, not the same key sentence
  // fifty-seven times.
  check(
    "a more specific problem still wins over the missing key",
    readinessFor(agent("internal-linking"), facts({ hasModelKey: false })).note.includes("Connect"),
  );
}

// ── 4. Agents we have not built ─────────────────────────────────────────────
{
  const soon = AGENTS.find((a) => a.status !== "ACTIVE");
  if (soon) {
    const r = readinessFor(soon, facts());
    check("an unshipped agent is never given a call to action", r.state === "coming-soon" && r.action === null, r);
  }
}

// ── 5. Integration chips say what is connected ──────────────────────────────
{
  const chips = chipsFor(agent("blog-writer"), new Set(["PAYLOAD"]));
  const payload = chips.find((c) => c.label === "Payload");
  const wordpress = chips.find((c) => c.label === "WordPress");
  check("a connected integration reads as connected", payload?.connected === true, chips);
  check("an unconnected one reads as unconnected", wordpress?.connected === false, chips);
  check(
    "either half of an either/or integration counts",
    chipsFor(agent("podcast"), new Set(["GOOGLE_TTS"])).some((c) => c.connected === true),
    chipsFor(agent("podcast"), new Set(["GOOGLE_TTS"])),
  );
  const keyless = AGENTS.flatMap((a) => chipsFor(a, new Set())).filter((c) => c.connected === null);
  check("a public source is marked as needing nothing, not as disconnected", keyless.every((c) => c.connected === null));
}

// ── 6. Every agent gets a verdict, and every verdict a pill ─────────────────
{
  const all = AGENTS.map((a) => readinessFor(a, facts({ enabled: false })));
  check("every agent resolves to a state", all.every((r) => !!r.state && !!r.label && !!r.note), all.find((r) => !r.note));
  check("every group has a pill label", all.every((r) => !!GROUP_LABELS[r.group]));
  check("no verdict renders an undefined into its sentence", all.every((r) => !r.note.includes("undefined")), all.find((r) => r.note.includes("undefined")));
  // A card that says something is missing and offers nothing to press is a
  // dead end — the exact failure this grid replaced.
  const active = AGENTS.filter((a) => a.status === "ACTIVE").map((a) => readinessFor(a, facts({ enabled: false })));
  check("every shipped agent offers somewhere to go", active.every((r) => !!r.action?.href), active.find((r) => !r.action));
}

// ── 7. Upstream references point at agents that exist ──────────────────────
{
  const dangling = [...new Set(AGENTS.flatMap((a) => upstreamAgents(a.slug)))].filter((s) => !getAgent(s));
  check("every upstream agent a card names is a real agent", dangling.length === 0, dangling);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

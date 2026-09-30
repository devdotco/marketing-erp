/**
 * The rules behind an agent card's one-line verdict — pure, so they can be
 * tested without a database and imported from client code without dragging
 * Prisma into the bundle. lib/agent-readiness.ts does the querying and calls in
 * here; nothing in this file touches the network or the database.
 */
import { getAgent, type Agent } from "@/lib/agents";
import { AGENT_META } from "@/lib/agent-metadata";

/** Ordered worst-first: the first one that applies is the one the card shows. */
export type ReadinessState =
  | "coming-soon"
  | "failed"
  | "awaiting-approval"
  | "blocked"
  | "needs-integration"
  | "not-set-up"
  | "ready";

/** The filter pills above the grid. "Blocked" and "failed" both want a person. */
export type ReadinessGroup = "needs-you" | "not-set-up" | "needs-integration" | "ready" | "coming-soon";

export type Tone = "info" | "warning" | "danger" | "success" | "muted";

export interface IntegrationChip {
  label: string;
  /** null — nothing to connect (public data source, or a label with no provider). */
  connected: boolean | null;
}

export interface AgentReadiness {
  slug: string;
  state: ReadinessState;
  group: ReadinessGroup;
  /** Pill text, e.g. "Awaiting approval". */
  label: string;
  tone: Tone;
  /** The tinted line inside the card: what is true, in one sentence. */
  note: string;
  action: { label: string; href: string } | null;
  integrations: IntegrationChip[];
}

export const GROUP_LABELS: Record<ReadinessGroup, string> = {
  "needs-you": "Needs you",
  "not-set-up": "Not set up",
  "needs-integration": "Needs integration",
  ready: "Ready",
  "coming-soon": "Coming soon",
};

const GROUP_OF: Record<ReadinessState, ReadinessGroup> = {
  "coming-soon": "coming-soon",
  failed: "needs-you",
  "awaiting-approval": "needs-you",
  blocked: "needs-you",
  "needs-integration": "needs-integration",
  "not-set-up": "not-set-up",
  ready: "ready",
};

/**
 * `Agent.integrations` is prose for the card; `IntegrationProvider` is what the
 * database stores. This is the only bridge between them, so a label added to
 * lib/agents.ts without an entry here shows as "no connection needed" rather
 * than as permanently disconnected — the safe way round.
 */
export const PROVIDERS_BY_LABEL: Record<string, string[]> = {
  Ahrefs: ["AHREFS"],
  Aimfox: ["AIMFOX"],
  "Apollo.io": ["APOLLO"],
  "Cartesia or Google Text-to-Speech": ["CARTESIA", "GOOGLE_TTS"],
  Gmail: ["GMAIL"],
  "Google Ads": ["GOOGLE_ADS"],
  "Google Analytics 4": ["GOOGLE_ANALYTICS_4"],
  "Google Business Profile": ["GOOGLE_BUSINESS_PROFILE"],
  "Google Search Console": ["GOOGLE_SEARCH_CONSOLE"],
  Instantly: ["INSTANTLY"],
  Klaviyo: ["KLAVIYO"],
  LinkedIn: ["LINKEDIN"],
  Mailchimp: ["MAILCHIMP"],
  Meta: ["META"],
  "Microsoft 365": ["MICROSOFT_365"],
  Payload: ["PAYLOAD"],
  Reddit: ["REDDIT"],
  SearchAtlas: ["SEARCH_ATLAS"],
  Semrush: ["SEMRUSH"],
  Storyblok: ["STORYBLOK"],
  Transistor: ["TRANSISTOR"],
  Webflow: ["WEBFLOW"],
  WordPress: ["WORDPRESS"],
  X: ["TWITTER_X"],
  YouTube: ["YOUTUBE"],
  "erp.io CRM": ["CRM_ERP_IO"],
};

/** Social posting reads SocialAccount, not Integration — a different table, same question. */
export const SOCIAL_LABELS: Record<string, "LINKEDIN" | "TWITTER_X"> = {
  "LinkedIn (Social accounts)": "LINKEDIN",
  "X (Social accounts)": "TWITTER_X",
};

/** Chip text only — several of these are too long for a card at a third of the row. */
const SHORT_LABELS: Record<string, string> = {
  "Google Search Console": "Search Console",
  "Google Analytics 4": "Analytics 4",
  "Google Business Profile": "Business Profile",
  "Cartesia or Google Text-to-Speech": "Cartesia / Google TTS",
  "LinkedIn (Social accounts)": "LinkedIn",
  "X (Social accounts)": "X",
  "SEC EDGAR (public — no key required)": "SEC EDGAR",
};

const PROVIDER_NAMES: Record<string, string> = {
  WORDPRESS: "WordPress", STORYBLOK: "Storyblok", WEBFLOW: "Webflow", PAYLOAD: "Payload",
  GOOGLE_SEARCH_CONSOLE: "Search Console", GOOGLE_ANALYTICS_4: "Analytics 4",
  GOOGLE_ADS: "Google Ads", GOOGLE_BUSINESS_PROFILE: "Business Profile",
  MAILCHIMP: "Mailchimp", KLAVIYO: "Klaviyo", AHREFS: "Ahrefs", SEMRUSH: "Semrush",
  SEARCH_ATLAS: "SearchAtlas", LINKEDIN: "LinkedIn", TWITTER_X: "X", META: "Meta",
  YOUTUBE: "YouTube", REDDIT: "Reddit", GMAIL: "Gmail", MICROSOFT_365: "Microsoft 365",
  INSTANTLY: "Instantly", APOLLO: "Apollo.io", AIMFOX: "Aimfox", CARTESIA: "Cartesia",
  GOOGLE_TTS: "Google TTS", TRANSISTOR: "Transistor", CRM_ERP_IO: "erp.io CRM",
  ANTHROPIC: "Anthropic", OPENAI_IMAGES: "OpenAI Images", GOOGLE_IMAGES: "Google Images",
};

const providerName = (p: string) => PROVIDER_NAMES[p] ?? p;

function joinOr(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/**
 * Which providers an agent genuinely cannot run without, as *groups of
 * alternatives* — `[["WORDPRESS","STORYBLOK","WEBFLOW","PAYLOAD"]]` means
 * "any one CMS", not "all four".
 *
 * Read off the run form rather than restated here: a required field that only
 * offers connected providers is exactly the thing that stops a run. An optional
 * field — the Blog Writer's CMS Target, which defaults to "None (draft only)" —
 * declares no requirement, which is why the Blog Writer is runnable with no CMS
 * connected and the On-site Publisher is not.
 */
export function requiredProviderGroups(slug: string): string[][] {
  const inputs = AGENT_META[slug]?.inputs ?? [];
  const groups: string[][] = [];
  for (const input of inputs) {
    if (!input.required) continue;
    if (input.optionProviders) {
      const providers = [...new Set(Object.values(input.optionProviders))];
      if (providers.length) groups.push(providers);
    } else if (input.type === "integration_resource" && input.provider) {
      groups.push([input.provider]);
    } else if (input.type === "social_account" && input.socialPlatform) {
      groups.push([input.socialPlatform]);
    }
  }
  return groups;
}

/** Agents whose required input is another agent's approved output. */
export function upstreamAgents(slug: string): string[] {
  const inputs = AGENT_META[slug]?.inputs ?? [];
  const sources = new Set<string>();
  for (const input of inputs) {
    if (input.required && input.type === "agent_run") {
      for (const s of input.sourceAgents ?? []) sources.add(s);
    }
  }
  return [...sources];
}

export function chipsFor(agent: Agent, connected: Set<string>): IntegrationChip[] {
  return agent.integrations.map((label) => {
    const social = SOCIAL_LABELS[label];
    const providers = social ? [social] : PROVIDERS_BY_LABEL[label];
    return {
      label: SHORT_LABELS[label] ?? label,
      connected: providers ? providers.some((p) => connected.has(p)) : null,
    };
  });
}

export interface ReadinessFacts {
  /** This workspace has turned the agent on. */
  enabled: boolean;
  /** Providers and social platforms this workspace has connected. */
  connected: Set<string>;
  /** Status of the agent's most recent run, if it has ever run. */
  lastRunStatus: string | null;
  /** `output.error` of that run, when it failed. */
  lastRunError: { message?: string; hint?: string } | null;
  /** Runs of this agent sitting in AWAITING_APPROVAL. */
  awaiting: number;
  /** Agents that have approved output a downstream agent could actually pick up. */
  usableUpstream: Set<string>;
  /** The workspace has an Anthropic key. Without one nothing runs at all. */
  hasModelKey: boolean;
}

export function readinessFor(agent: Agent, facts: ReadinessFacts): AgentReadiness {
  const integrations = chipsFor(agent, facts.connected);
  const make = (
    state: ReadinessState,
    label: string,
    tone: Tone,
    note: string,
    action: { label: string; href: string } | null,
  ): AgentReadiness => ({ slug: agent.slug, state, group: GROUP_OF[state], label, tone, note, action, integrations });

  if (agent.status !== "ACTIVE") {
    return make("coming-soon", "Coming soon", "muted", "Not built yet. Nothing to set up.", null);
  }

  // A waiting draft outranks everything: it is the only state where the work is
  // finished and sitting still because nobody has looked at it.
  if (facts.awaiting > 0) {
    const n = facts.awaiting;
    return make(
      "awaiting-approval",
      "Awaiting approval",
      "info",
      `${n} draft${n === 1 ? " is" : "s are"} waiting for your review before ${n === 1 ? "it" : "they"} can go out.`,
      { label: n === 1 ? "Review draft" : "Review drafts", href: `/runs?status=AWAITING_APPROVAL&agent=${agent.slug}` },
    );
  }

  if (facts.lastRunStatus === "FAILED") {
    return make(
      "failed",
      "Last run failed",
      "danger",
      facts.lastRunError?.message ?? "The last run failed. The reason is on the run.",
      { label: "View error", href: `/agents/${agent.slug}/history` },
    );
  }

  if (!facts.enabled) {
    return make(
      "not-set-up",
      "Not set up",
      "muted",
      "Turn it on and fill in what it needs to start.",
      { label: "Set up", href: `/agents/${agent.slug}` },
    );
  }

  const missing = requiredProviderGroups(agent.slug).filter((group) => !group.some((p) => facts.connected.has(p)));
  if (missing.length > 0) {
    const names = [...new Set(missing[0].map(providerName))];
    return make(
      "needs-integration",
      "Needs integration",
      "warning",
      `Connect ${joinOr(names)} before it can run.`,
      { label: names.length === 1 ? `Connect ${names[0]}` : "Connect", href: "/integrations" },
    );
  }

  const upstream = upstreamAgents(agent.slug);
  if (upstream.length > 0 && !upstream.some((s) => facts.usableUpstream.has(s))) {
    const names = upstream.map((s) => getAgent(s)?.name ?? s);
    return make(
      "blocked",
      "Blocked",
      "warning",
      `Needs approved output from ${joinOr(names)} first.`,
      { label: `Open ${names[0]}`, href: `/agents/${upstream[0]}` },
    );
  }

  // Asked last because it is true of every agent at once, and a workspace with
  // no key wants one answer rather than fifty-seven.
  if (!facts.hasModelKey) {
    return make(
      "needs-integration",
      "Needs integration",
      "warning",
      "Add your Anthropic API key — every run is billed to it, and nothing runs without one.",
      { label: "Connect Anthropic", href: "/integrations" },
    );
  }

  return make("ready", "Ready", "success", "Everything it needs is in place.", {
    label: "Run",
    href: `/agents/${agent.slug}`,
  });
}

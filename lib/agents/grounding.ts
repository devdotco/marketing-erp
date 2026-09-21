/**
 * What kind of thing an agent's output is, and what it would take to believe it.
 *
 * The product had one rendering for every run: a JSON panel. A drafted article
 * and a claim about where we rank in AI answers arrived looking identical, and
 * one of them was a model's guess. `ai-search-visibility` asked Haiku to
 * *imagine* how ChatGPT would answer and shipped the result next to real Search
 * Console figures in the same object — the only thing separating them was a
 * `source` field nobody rendered.
 *
 * So: classify by what the output *claims*, not by which suite it sits in.
 *
 *  - An OBSERVATION asserts something about the world ("we rank 4th", "this
 *    page lost impressions"). It is only worth as much as the system it came
 *    from, so it must always carry its evidence, and an observation with no
 *    live source behind it is labelled as an estimate everywhere it appears.
 *  - An ARTIFACT is a thing the agent made — an article, an ad, a script. There
 *    is nothing to verify; the model writing it *is* the product. These need no
 *    evidence badge and must never be charted.
 *  - An ACTION changed something outside this app — published a post, sent an
 *    email. What matters is whether it landed.
 *
 * The static map says what an agent CAN reach. What it actually reached on a
 * given run is runtime evidence, recorded per run — see ./provenance.ts. A
 * handler that can read Search Console but ran for a workspace that never
 * connected it produced a model-only observation that time, and the run page
 * has to say so.
 */

export type OutputKind = "observation" | "artifact" | "action";

/** A live system an agent reads to ground an observation. Display names. */
export const EVIDENCE_SOURCES = {
  GSC: "Google Search Console",
  GA4: "Google Analytics 4",
  GOOGLE_ADS: "Google Ads",
  GBP: "Google Business Profile",
  SEO_API: "Ahrefs / Semrush / SearchAtlas",
  WEB_SEARCH: "Live web search",
  ANSWER_CAPTURE: "AI answer capture",
  CRAWL_LOGS: "AI crawler logs",
  META_ADS: "Meta Ads",
  LINKEDIN_ADS: "LinkedIn Ads",
  CRM: "erp.io CRM",
  ESP: "Email platform",
  SOCIAL: "Connected social account",
  CMS: "Connected CMS",
} as const;

export type EvidenceSource = keyof typeof EVIDENCE_SOURCES;

export interface AgentGrounding {
  kind: OutputKind;
  /** Live systems this agent reads when they are connected. Empty = model only. */
  canRead: EvidenceSource[];
  /**
   * Observations only. True when the agent still produces its headline figures
   * with no live source connected — i.e. the number can be a model's estimate.
   * These are the ones that cost us credibility, so the UI says so plainly.
   */
  estimatesWithoutSource?: boolean;
}

export const AGENT_GROUNDING: Record<string, AgentGrounding> = {
  // ── Observations ───────────────────────────────────────────────────────────
  "technical-audit":      { kind: "observation", canRead: ["GSC", "WEB_SEARCH"], estimatesWithoutSource: true },
  "keyword-research":     { kind: "observation", canRead: ["GSC", "SEO_API"], estimatesWithoutSource: true },
  "rank-tracker":         { kind: "observation", canRead: ["GSC", "SEO_API"], estimatesWithoutSource: true },
  "gsc-analyst":          { kind: "observation", canRead: ["GSC"] },
  "competitor-watch":     { kind: "observation", canRead: ["SEO_API", "WEB_SEARCH"], estimatesWithoutSource: true },
  "ai-search-visibility": { kind: "observation", canRead: ["ANSWER_CAPTURE", "GSC", "CRAWL_LOGS"] },
  "backlink-monitor":     { kind: "observation", canRead: ["SEO_API"], estimatesWithoutSource: true },
  "weekly-report":        { kind: "observation", canRead: ["GSC", "GA4", "GOOGLE_ADS"], estimatesWithoutSource: true },
  "anomaly-watch":        { kind: "observation", canRead: ["GSC", "GA4"], estimatesWithoutSource: true },
  "attribution":          { kind: "observation", canRead: ["GA4", "GSC"], estimatesWithoutSource: true },
  "social-listening":     { kind: "observation", canRead: ["WEB_SEARCH"], estimatesWithoutSource: true },
  "google-ads":           { kind: "observation", canRead: ["GOOGLE_ADS", "GSC"], estimatesWithoutSource: true },
  "meta-ads":             { kind: "observation", canRead: ["META_ADS"], estimatesWithoutSource: true },
  "linkedin-ads":         { kind: "observation", canRead: ["LINKEDIN_ADS"], estimatesWithoutSource: true },
  "local-seo-gbp":        { kind: "observation", canRead: ["GBP", "GSC"], estimatesWithoutSource: true },
  "review-engine":        { kind: "observation", canRead: ["GBP"], estimatesWithoutSource: true },
  "lead-enrichment":      { kind: "observation", canRead: ["CRM"], estimatesWithoutSource: true },
  "prospector":           { kind: "observation", canRead: ["SEO_API", "WEB_SEARCH"], estimatesWithoutSource: true },
  "outbound-scout":       { kind: "observation", canRead: ["WEB_SEARCH", "CRM"] },

  // ── Artifacts — the model writing it IS the product ────────────────────────
  "blog-writer":          { kind: "artifact", canRead: ["WEB_SEARCH"] },
  "topic-planner":        { kind: "artifact", canRead: ["GSC", "SEO_API", "WEB_SEARCH"] },
  "content-refresh":      { kind: "artifact", canRead: ["GSC", "CMS"] },
  "internal-linking":     { kind: "artifact", canRead: ["CMS"] },
  "repurposer":           { kind: "artifact", canRead: [] },
  "landing-page-copy":    { kind: "artifact", canRead: [] },
  "newsletter":           { kind: "artifact", canRead: [] },
  "schema":               { kind: "artifact", canRead: [] },
  "ad-creative":          { kind: "artifact", canRead: [] },
  "cro-experiments":      { kind: "artifact", canRead: ["GA4"] },
  "email-marketing":      { kind: "artifact", canRead: ["ESP", "CRM"] },
  "digital-pr":           { kind: "artifact", canRead: ["WEB_SEARCH"] },
  "outreach":             { kind: "artifact", canRead: ["WEB_SEARCH"] },
  "placement":            { kind: "artifact", canRead: [] },
  "proposal":             { kind: "artifact", canRead: [] },
  "podcast":              { kind: "artifact", canRead: [] },
  "video-script":         { kind: "artifact", canRead: [] },
  "captions-clips":       { kind: "artifact", canRead: [] },
  "short-form":           { kind: "artifact", canRead: [] },
  "community":            { kind: "artifact", canRead: [] },
  "youtube":              { kind: "artifact", canRead: ["SOCIAL"] },
  "inbox-responder":      { kind: "artifact", canRead: ["ESP"] },
  "x-engager":            { kind: "artifact", canRead: ["SOCIAL"] },
  "linkedin-engager":     { kind: "artifact", canRead: ["SOCIAL"] },
  "onboarder":            { kind: "artifact", canRead: [] },
  "operator":             { kind: "artifact", canRead: [] },
  "outbound-strategist":  { kind: "artifact", canRead: ["CRM"] },
  "outbound-email":       { kind: "artifact", canRead: ["CRM"] },
  "outbound-linkedin":    { kind: "artifact", canRead: ["CRM"] },
  "outbound-cro":         { kind: "artifact", canRead: [] },
  "outbound-revenue":     { kind: "artifact", canRead: ["CRM"] },

  // ── Actions — something outside this app changed ───────────────────────────
  "on-site-publisher":    { kind: "action", canRead: ["CMS"] },
  "linkedin-poster":      { kind: "action", canRead: ["SOCIAL"] },
  "x-poster":             { kind: "action", canRead: ["SOCIAL"] },
  "meta-poster":          { kind: "action", canRead: ["SOCIAL"] },
};

/** Unknown slugs are treated as artifacts: never chart what we cannot vouch for. */
export function groundingFor(slug: string): AgentGrounding {
  return AGENT_GROUNDING[slug] ?? { kind: "artifact", canRead: [] };
}

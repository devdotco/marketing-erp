/**
 * Suites whose agents genuinely hand work to each other, in order.
 *
 * Only two chains are real today — the content one (brief → draft → publish →
 * repurpose, every hop an approved run the next agent reads) and the outbound
 * one that lib/agent-handlers/chaining.ts enqueues automatically. A suite whose
 * agents merely sit near each other gets no strip, because a diagram of a
 * sequence that does not exist is worse than none.
 */
export const PIPELINES: Record<string, { name: string; steps: string[] }> = {
  content: {
    name: "Content pipeline",
    steps: ["topic-planner", "blog-writer", "on-site-publisher", "repurposer"],
  },
  outbound: {
    name: "Outbound pipeline",
    steps: ["outbound-scout", "outbound-strategist", "outbound-email", "outbound-revenue"],
  },
};

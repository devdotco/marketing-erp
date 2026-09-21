import { groundingFor } from "@/lib/agents/grounding";

/**
 * What this agent produces, said before anyone presses Run.
 *
 * The roster showed 54 agents as peers. Some write things, some assert things,
 * and a person choosing between them had no way to know which — so an estimate
 * and a measurement arrived with equal authority. This is the cheap half of the
 * fix; the run itself carries its actual sources (ProvenanceBanner).
 */
export function GroundingBadge({ agentSlug }: { agentSlug: string }) {
  const { kind, estimatesWithoutSource } = groundingFor(agentSlug);

  if (kind === "artifact") {
    return <span className="badge badge-muted" title="Produces a draft for you to review and use.">Drafts</span>;
  }
  if (kind === "action") {
    return <span className="badge badge-muted" title="Changes something outside this app when you approve it.">Publishes</span>;
  }
  if (estimatesWithoutSource) {
    return (
      <span
        className="badge badge-awaiting"
        title="Reports figures. With no live source connected it estimates them, and the run will say so."
      >
        Reports · needs a source
      </span>
    );
  }
  return (
    <span className="badge badge-active" title="Reports figures read from a connected system.">
      Reports
    </span>
  );
}

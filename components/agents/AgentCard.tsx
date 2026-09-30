import Link from "next/link";
import type { Agent } from "@/lib/agents";
import type { AgentReadiness } from "@/lib/agent-readiness-rules";

/**
 * One agent, as a card that answers "can this run for me, and what do I do
 * next?" before it answers anything else.
 *
 * The whole card is clickable through the title's stretched ::after, so the
 * call to action stays a real button rather than a link nested inside a link.
 */
export function AgentCard({ agent, readiness }: { agent: Agent; readiness: AgentReadiness }) {
  const { tone, label, note, action, integrations } = readiness;
  // "Blocked" sends you somewhere else to fix something; every other action is
  // the thing to do on this card, so only that one is de-emphasised.
  const secondaryAction = readiness.state === "blocked";

  return (
    <article className={`agent-card agent-card--${tone}`}>
      <div className="agent-card__head">
        <h3 className="agent-card__name">
          <Link href={`/agents/${agent.slug}`}>{agent.name}</Link>
        </h3>
        <span className={`status-pill status-pill--${tone}`}>
          <span className="status-pill__dot" />
          {label}
        </span>
      </div>

      <p className="agent-card__description" title={agent.description}>
        {agent.description}
      </p>

      <p className={`agent-card__note agent-card__note--${tone}`}>{note}</p>

      <div className="agent-card__foot">
        <div className="agent-card__chips">
          {integrations.length === 0 && <span className="agent-card__none">No integrations needed</span>}
          {integrations.slice(0, 4).map((chip) => (
            <span
              key={chip.label}
              className="int-chip"
              title={
                chip.connected === null
                  ? "No connection needed"
                  : chip.connected
                    ? `${chip.label} is connected`
                    : `${chip.label} is not connected`
              }
            >
              <span
                className={`int-chip__dot ${
                  chip.connected === null ? "is-na" : chip.connected ? "is-on" : "is-off"
                }`}
              />
              {chip.label}
            </span>
          ))}
          {integrations.length > 4 && (
            <span className="int-chip int-chip--more">+{integrations.length - 4}</span>
          )}
        </div>

        {action && (
          <Link
            href={action.href}
            className={`btn btn-sm agent-card__cta ${secondaryAction ? "btn-secondary" : "btn-primary"}`}
          >
            {action.label}
          </Link>
        )}
      </div>
    </article>
  );
}

"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import type { Agent, Suite } from "@/lib/agents";
import { GROUP_LABELS, type AgentReadiness, type ReadinessGroup } from "@/lib/agent-readiness-rules";
import { PIPELINES } from "@/lib/agent-pipelines";
import { AgentCard } from "./AgentCard";

const ALL_TAB = { slug: "all", name: "All" };

/** Worst first, so the pills read left to right as "how much of this is on me". */
const GROUP_ORDER: ReadinessGroup[] = ["needs-you", "not-set-up", "needs-integration", "ready", "coming-soon"];

export function AgentsBrowser({
  agents,
  suites,
  readiness,
}: {
  agents: Agent[];
  suites: Suite[];
  readiness: Record<string, AgentReadiness>;
}) {
  const [suite, setSuite] = useState("all");
  const [group, setGroup] = useState<ReadinessGroup | "all">("all");
  const [query, setQuery] = useState("");

  // Narrowed by suite and search, but NOT by group — the pill counts have to
  // describe the set the pills are offered against, or they change as you use
  // them.
  const inScope = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents
      .filter((a) => (suite === "all" || a.suite === suite))
      .filter(
        (a) =>
          !q ||
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          a.integrations.some((i) => i.toLowerCase().includes(q)),
      )
      .sort((a, b) => Number(a.status !== "ACTIVE") - Number(b.status !== "ACTIVE"));
  }, [agents, suite, query]);

  const counts = useMemo(() => {
    const c = {} as Record<ReadinessGroup, number>;
    for (const a of inScope) {
      const g = readiness[a.slug]?.group;
      if (g) c[g] = (c[g] ?? 0) + 1;
    }
    return c;
  }, [inScope, readiness]);

  const visible = group === "all" ? inScope : inScope.filter((a) => readiness[a.slug]?.group === group);

  const pipeline = suite !== "all" ? PIPELINES[suite] : undefined;

  return (
    <>
      {/* Suite tabs + search */}
      <div className="agents-tabs">
        <div className="agents-tabs__scroll">
          {[ALL_TAB, ...suites].map((tab) => (
            <button
              key={tab.slug}
              onClick={() => {
                setSuite(tab.slug);
                setGroup("all");
              }}
              className={`agents-tab ${suite === tab.slug ? "is-active" : ""}`}
            >
              {tab.name}
            </button>
          ))}
        </div>
        <div className="agents-search">
          <Search size={13} className="agents-search__icon" />
          <input
            className="input"
            type="search"
            placeholder="Search agents…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {/* The chain, when this suite actually is one */}
      {pipeline && (
        <section className="pipeline" aria-label={pipeline.name}>
          <div className="pipeline__head">
            <span className="pipeline__title">{pipeline.name}</span>
            <span className="pipeline__hint">Each step feeds the next</span>
          </div>
          <div className="pipeline__steps">
            {pipeline.steps.map((slug, i) => {
              const agent = agents.find((a) => a.slug === slug);
              const state = readiness[slug];
              if (!agent || !state) return null;
              return (
                <div key={slug} className="pipeline__step-wrap">
                  {i > 0 && <span className="pipeline__arrow" aria-hidden>→</span>}
                  <Link href={`/agents/${slug}`} className="pipeline__step">
                    <span className="pipeline__step-name">{agent.name}</span>
                    <span className={`pipeline__step-state status-pill--${state.tone}`}>
                      <span className="status-pill__dot" />
                      {state.label}
                    </span>
                  </Link>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Status filters */}
      <div className="agent-filters">
        <button
          onClick={() => setGroup("all")}
          className={`agent-filter ${group === "all" ? "is-active" : ""}`}
        >
          All <span className="agent-filter__count">{inScope.length}</span>
        </button>
        {GROUP_ORDER.filter((g) => (counts[g] ?? 0) > 0).map((g) => (
          <button
            key={g}
            onClick={() => setGroup(g)}
            className={`agent-filter agent-filter--${g} ${group === g ? "is-active" : ""}`}
          >
            <span className="agent-filter__dot" />
            {GROUP_LABELS[g]} <span className="agent-filter__count">{counts[g]}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div style={{ textAlign: "center", padding: "48px 0", color: "var(--text-muted)" }}>
          <p style={{ fontSize: 14 }}>No agents match that.</p>
        </div>
      ) : (
        <div className="agent-grid">
          {visible.map((agent) => {
            const state = readiness[agent.slug];
            return state ? <AgentCard key={agent.slug} agent={agent} readiness={state} /> : null;
          })}
        </div>
      )}
    </>
  );
}

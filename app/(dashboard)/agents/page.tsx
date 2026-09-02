"use client";

import { useState } from "react";
import Link from "next/link";
import { AGENTS, SUITES } from "@/lib/agents";
import { Search } from "lucide-react";

const ALL_TAB = { slug: "all", name: "All" };

export default function AgentsPage() {
  const [activeTab, setActiveTab] = useState("all");
  const [query, setQuery] = useState("");

  const filtered = AGENTS.filter((a) => {
    const matchesSuite = activeTab === "all" || a.suite === activeTab;
    const matchesQuery =
      !query ||
      a.name.toLowerCase().includes(query.toLowerCase()) ||
      a.description.toLowerCase().includes(query.toLowerCase()) ||
      a.integrations.some((i) => i.toLowerCase().includes(query.toLowerCase()));
    return matchesSuite && matchesQuery;
  });

  const activeCounts = Object.fromEntries(
    SUITES.map((s) => [s.slug, AGENTS.filter((a) => a.suite === s.slug && a.status === "ACTIVE").length])
  );

  return (
    <div className="scrollable">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 4 }}>Agents</h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {AGENTS.length} agents across {SUITES.length} suites · {AGENTS.filter((a) => a.status === "ACTIVE").length} live now
          </p>
        </div>
      </div>

      {/* Tabs + search */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 0,
          borderBottom: "1px solid var(--border)",
          marginBottom: 24,
          position: "sticky",
          top: 0,
          background: "var(--bg)",
          zIndex: 10,
          paddingBottom: 0,
        }}
      >
        <div style={{ display: "flex", flex: 1, gap: 0, overflow: "auto" }}>
          {[ALL_TAB, ...SUITES].map((tab) => (
            <button
              key={tab.slug}
              onClick={() => setActiveTab(tab.slug)}
              style={{
                padding: "10px 14px",
                fontSize: 13,
                fontWeight: activeTab === tab.slug ? 600 : 400,
                color: activeTab === tab.slug ? "var(--text)" : "var(--text-muted)",
                background: "none",
                border: "none",
                borderBottom: `2px solid ${activeTab === tab.slug ? "var(--text)" : "transparent"}`,
                cursor: "pointer",
                whiteSpace: "nowrap",
                marginBottom: -1,
                display: "flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              {tab.name}
              {tab.slug !== "all" && activeCounts[tab.slug] > 0 && (
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    background: "var(--success-bg)",
                    color: "var(--success)",
                    padding: "1px 5px",
                    borderRadius: 3,
                    letterSpacing: "0.04em",
                  }}
                >
                  {activeCounts[tab.slug]} live
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Search */}
        <div style={{ position: "relative", flexShrink: 0, marginLeft: 12 }}>
          <Search
            size={13}
            style={{
              position: "absolute",
              left: 9,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--text-dim)",
            }}
          />
          <input
            className="input"
            type="search"
            placeholder="Search agents…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ paddingLeft: 28, width: 180, fontSize: 13, height: 32 }}
          />
        </div>
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "48px 0", color: "var(--text-muted)" }}>
          <p style={{ fontSize: 14 }}>No agents match your search.</p>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
          {filtered.map((agent) => (
            <Link
              key={agent.slug}
              href={`/agents/${agent.slug}`}
              className={`agent-card ${agent.status === "ACTIVE" ? "active-agent" : "disabled"}`}
              style={{ textDecoration: "none" }}
            >
              {/* Header row */}
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: "0.02em",
                    color: "var(--text-dim)",
                    fontFamily: "monospace",
                  }}
                >
                  {agent.suite}
                </span>
                <span className={`badge ${agent.status === "ACTIVE" ? "badge-active" : "badge-soon"}`}>
                  {agent.status === "ACTIVE" ? "Live" : "Soon"}
                </span>
              </div>

              {/* Agent name */}
              <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text)" }}>{agent.name}</div>

              {/* Description */}
              <p className="agent-description">{agent.description}</p>

              {/* Integrations + CTA */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
                {agent.integrations.slice(0, 3).map((int) => (
                  <span
                    key={int}
                    style={{
                      fontSize: 10,
                      background: "var(--surface-2)",
                      color: "var(--text-dim)",
                      padding: "1px 6px",
                      borderRadius: 3,
                      border: "1px solid var(--border)",
                    }}
                  >
                    {int}
                  </span>
                ))}
                {agent.integrations.length > 3 && (
                  <span style={{ fontSize: 10, color: "var(--text-dim)" }}>+{agent.integrations.length - 3}</span>
                )}
                <span style={{ marginLeft: "auto", fontSize: 11, color: agent.status === "ACTIVE" ? "var(--success)" : "var(--text-dim)" }}>
                  {agent.status === "ACTIVE" ? "Configure →" : "Coming soon"}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

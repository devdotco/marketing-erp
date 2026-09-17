/**
 * Keyword Research as a dashboard instead of a JSON dump. Everything comes from
 * lib/reports/keyword-research.ts — the same model the HTML download renders —
 * so what a person approves here is what they download.
 */
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { formatDelta, type KeywordReport, type KwAction, type ScanComparison } from "@/lib/reports/keyword-research";

const th: CSSProperties = { textAlign: "left", padding: "7px 10px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-dim)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" };
const td: CSSProperties = { padding: "7px 10px", fontSize: 13, borderBottom: "1px solid var(--border)", verticalAlign: "top" };
const numTd: CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
const numTh: CSSProperties = { ...th, textAlign: "right" };

const fmt = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-US"));
const money = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);

const PRIORITY_BADGE: Record<KwAction["priority"], string> = { high: "badge-failed", medium: "badge-awaiting", low: "badge-running" };

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="card">
      <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: hint ? 2 : 12 }}>{title}</h2>
      {hint && <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 12 }}>{hint}</p>}
      {children}
    </div>
  );
}

function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>{head}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const TONE: Record<string, string> = { up: "var(--success)", down: "var(--danger)", flat: "var(--text-dim)" };

function SinceLastScan({ cmp }: { cmp: ScanComparison }) {
  const t = cmp.totals;
  const tiles = t
    ? ([
        ["Clicks (28d)", fmt(t.clicks[1]), formatDelta(t.clicks[0], t.clicks[1])],
        ["Impressions (28d)", fmt(t.impressions[1]), formatDelta(t.impressions[0], t.impressions[1])],
        ["CTR", `${(t.ctr[1] * 100).toFixed(2)}%`, formatDelta(t.ctr[0], t.ctr[1], { decimals: 2, percent: true })],
        ["Avg. position", t.position[1].toFixed(1), formatDelta(t.position[0], t.position[1], { decimals: 1, lowerIsBetter: true })],
      ] as const)
    : [];
  const movers = [...cmp.improved.slice(0, 5), ...cmp.declined.slice(0, 5)];
  return (
    <Section
      title="Since last scan"
      hint={cmp.previousAt ? `Compared with the scan on ${new Date(cmp.previousAt).toLocaleDateString()}.` : undefined}
    >
      {tiles.length > 0 ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, marginBottom: 12 }}>
          {tiles.map(([label, value, d]) => (
            <div key={label} style={{ background: "var(--surface-2)", borderRadius: "var(--radius)", padding: "10px 12px" }}>
              <div style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</div>
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{label}</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: TONE[d.tone] }}>{d.text}</div>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "0 0 12px" }}>
          Search Console totals weren&rsquo;t captured on both scans, so traffic change isn&rsquo;t shown yet.
        </p>
      )}
      {movers.length > 0 && (
        <Table head={<><th style={th}>Query</th><th style={numTh}>Was</th><th style={numTh}>Now</th><th style={numTh}>Change</th></>}>
          {movers.map((m) => (
            <tr key={m.query}>
              <td style={td}>{m.query}</td>
              <td style={numTd}>{m.before.toFixed(1)}</td>
              <td style={numTd}>{m.after.toFixed(1)}</td>
              <td style={{ ...numTd, fontWeight: 600, color: m.change > 0 ? "var(--success)" : "var(--danger)" }}>
                {m.change > 0 ? "▲" : "▼"} {Math.abs(m.change).toFixed(1)}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "12px 0 0" }}>
        Keyword coverage: {fmt(cmp.keywordCount[0])} → {fmt(cmp.keywordCount[1])} keywords, {fmt(cmp.winnable[0])} → {fmt(cmp.winnable[1])} winnable
        {cmp.newKeywords.length > 0 && `; ${cmp.newKeywords.length} new this scan`}.
      </p>
    </Section>
  );
}

export function KeywordResearchReport({ report, downloadHref, comparison }: { report: KeywordReport; downloadHref: string; comparison: ScanComparison | null }) {
  const r = report;
  const kpis: Array<[string, string]> = [
    ["Keywords", fmt(r.summary.totalKeywords)],
    ["Winnable", fmt(r.summary.winnable)],
    ["Avg. difficulty", fmt(r.summary.avgDifficulty)],
    ["Traffic potential / mo", fmt(r.summary.trafficPotential)],
    ["Clusters", fmt(r.clusters.length)],
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card">
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Keyword research report</h2>
            <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0 }}>
              Data: {r.sourceLabel}
              {r.seeds.length > 0 && <> &middot; Seeds: {r.seeds.join(", ")}</>}
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Link href="/agents/keyword-research/history" className="btn btn-secondary btn-sm">
              Scan history
            </Link>
            <a href={downloadHref} className="btn btn-secondary btn-sm" download>
              Download HTML
            </a>
          </div>
        </div>
        {r.dataNote && (
          <p style={{ fontSize: 12, color: "var(--text-muted)", background: "var(--warning-bg)", borderRadius: "var(--radius)", padding: "8px 12px", margin: "12px 0 0" }}>
            {r.dataNote}
          </p>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, marginTop: 14 }}>
          {kpis.map(([label, value]) => (
            <div key={label} style={{ background: "var(--surface-2)", borderRadius: "var(--radius)", padding: "10px 12px" }}>
              <div style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</div>
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{label}</div>
            </div>
          ))}
        </div>
        {r.summary.topOpportunity && (
          <p style={{ fontSize: 13, margin: "12px 0 0" }}>
            <strong>Top opportunity:</strong> {r.summary.topOpportunity}
          </p>
        )}
      </div>

      {comparison && <SinceLastScan cmp={comparison} />}

      {r.actions.length > 0 && (
        <Section title="What to do next">
          <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            {r.actions.map((a, i) => (
              <li key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <span className={`badge ${PRIORITY_BADGE[a.priority]}`} style={{ flexShrink: 0, minWidth: 58, justifyContent: "center" }}>{a.priority}</span>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>{a.title}</p>
                  {a.detail && <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "2px 0 0", lineHeight: 1.55 }}>{a.detail}</p>}
                </div>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {r.opportunities.length > 0 && (
        <Section title="Gaps & opportunities">
          <Table head={<><th style={th}>Keyword</th><th style={th}>Why it matters</th><th style={th}>Action</th></>}>
            {r.opportunities.map((o, i) => (
              <tr key={i}>
                <td style={td}><strong>{o.keyword}</strong><div style={{ fontSize: 11, color: "var(--text-dim)" }}>{o.type}</div></td>
                <td style={{ ...td, color: "var(--text-muted)" }}>{o.why}</td>
                <td style={td}>{o.action}</td>
              </tr>
            ))}
          </Table>
        </Section>
      )}

      {r.strikingDistance.length > 0 && (
        <Section title="Striking distance" hint="Real Google Search Console queries from the last 90 days, ranking just off the top spots.">
          <Table head={<><th style={th}>Query</th><th style={numTh}>Avg. position</th><th style={numTh}>Impressions</th><th style={numTh}>Clicks</th></>}>
            {r.strikingDistance.map((q) => (
              <tr key={q.query}>
                <td style={td}>{q.query}</td>
                <td style={numTd}>{q.position.toFixed(1)}</td>
                <td style={numTd}>{fmt(q.impressions)}</td>
                <td style={numTd}>{fmt(q.clicks)}</td>
              </tr>
            ))}
          </Table>
        </Section>
      )}

      {r.quickWins.length > 0 && (
        <Section title="Quick wins" hint="Winnable keywords with difficulty 40 or under, by volume.">
          <Table head={<><th style={th}>Keyword</th><th style={th}>Cluster</th><th style={numTh}>Volume</th><th style={numTh}>Difficulty</th><th style={numTh}>CPC</th></>}>
            {r.quickWins.map((k) => (
              <tr key={`${k.cluster}-${k.keyword}`}>
                <td style={td}>{k.keyword}</td>
                <td style={{ ...td, color: "var(--text-muted)" }}>{k.cluster}</td>
                <td style={numTd}>{fmt(k.volume)}</td>
                <td style={numTd}>{fmt(k.difficulty)}</td>
                <td style={numTd}>{money(k.cpc)}</td>
              </tr>
            ))}
          </Table>
        </Section>
      )}

      <Section title="Clusters & content briefs">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {r.clusters.map((c, i) => (
            <details key={i} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "10px 12px" }}>
              <summary style={{ cursor: "pointer", fontSize: 13 }}>
                <strong>{c.name}</strong>
                <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
                  {" "}&middot; {c.intent || "mixed"}{c.funnelStage ? ` · ${c.funnelStage} of funnel` : ""} &middot; {c.keywords.length} keywords
                  {c.brief?.priorityScore != null ? ` · priority ${c.brief.priorityScore}` : ""}
                </span>
              </summary>
              {c.brief && (
                <div style={{ background: "var(--surface-2)", borderRadius: "var(--radius)", padding: "10px 12px", margin: "10px 0" }}>
                  <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>{c.brief.title}</p>
                  <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "2px 0 0" }}>
                    {c.brief.contentType}{c.brief.wordCount ? ` · ~${c.brief.wordCount} words` : ""} · target: {c.brief.targetKeyword}
                    {c.brief.secondaryKeywords.length > 0 && ` · also: ${c.brief.secondaryKeywords.join(", ")}`}
                  </p>
                  {c.brief.outline.length > 0 && (
                    <ol style={{ fontSize: 12, color: "var(--text-muted)", margin: "8px 0 0", paddingLeft: 18 }}>
                      {c.brief.outline.map((h, j) => <li key={j}>{h}</li>)}
                    </ol>
                  )}
                </div>
              )}
              <Table head={<><th style={th}>Keyword</th><th style={numTh}>Volume</th><th style={numTh}>Difficulty</th><th style={numTh}>CPC</th><th style={th}>Winnable</th></>}>
                {c.keywords.map((k) => (
                  <tr key={k.keyword}>
                    <td style={td}>{k.keyword}</td>
                    <td style={numTd}>{fmt(k.volume)}</td>
                    <td style={numTd}>{fmt(k.difficulty)}</td>
                    <td style={numTd}>{money(k.cpc)}</td>
                    <td style={td}>{k.winnable ? "Yes" : "—"}</td>
                  </tr>
                ))}
              </Table>
            </details>
          ))}
        </div>
      </Section>
    </div>
  );
}

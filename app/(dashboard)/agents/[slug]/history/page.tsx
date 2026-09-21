import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "@/lib/session";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import { loadKeywordScans } from "@/lib/reports/keyword-scans";
import { compareScans, formatDelta } from "@/lib/reports/keyword-research";
import { withBase } from "@/lib/base-path";

export const metadata = { title: "Keyword Research history — marketing.erp.io" };

const TONE: Record<string, string> = { up: "var(--success)", down: "var(--danger)", flat: "var(--text-dim)" };
const fmt = (n: number) => n.toLocaleString("en-US");

function Delta({ d }: { d: { text: string; tone: string } | null }) {
  if (!d) return null;
  return <div style={{ fontSize: 11, color: TONE[d.tone], fontWeight: d.tone === "flat" ? 400 : 600 }}>{d.text}</div>;
}

/**
 * Every Keyword Research scan for the workspace, with what changed between
 * them. The change that matters is Search Console's — clicks, impressions and
 * positions are measured; the keyword lists are model output and shift run to run.
 */
export default async function KeywordHistoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (slug !== "keyword-research") notFound();

  const session = await getServerSession();
  if (!session?.user) redirect("/login");
  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");
  await requireWorkspaceAccess(workspaceId);

  const scans = await loadKeywordScans(workspaceId);
  const latest = scans.at(-1) ?? null;
  const withGsc = scans.filter((s) => s.report.gscAll.length > 0);
  const moversCmp = withGsc.length >= 2 ? compareScans(withGsc.at(-1)!.report, withGsc.at(-2)!.report) : null;
  const first = scans.find((s) => s.report.gscTotals);
  const last = [...scans].reverse().find((s) => s.report.gscTotals);
  const overall = first && last && first !== last ? { from: first, to: last } : null;

  return (
    <div className="scrollable">
      <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 20 }}>
        <Link href="/agents" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Agents</Link>
        {" / "}
        <Link href="/agents/keyword-research" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Keyword Research</Link>
        {" / History"}
      </div>
      <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 6 }}>Keyword Research history</h1>
      <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 24 }}>
        Every scan is kept. Traffic and positions come from Google Search Console at the time of each scan, so change here is measured, not estimated.
      </p>

      {scans.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "40px 24px", color: "var(--text-muted)", fontSize: 13 }}>
          No completed scans yet. <Link href="/agents/keyword-research">Run Keyword Research</Link> to start the history.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {overall && (
            <div className="card">
              <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>Since the first tracked scan</h2>
              <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 12 }}>
                {overall.from.at.toLocaleDateString()} → {overall.to.at.toLocaleDateString()} · Search Console, 28-day windows
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
                {([
                  ["Clicks", fmt(overall.to.report.gscTotals!.clicks), formatDelta(overall.from.report.gscTotals!.clicks, overall.to.report.gscTotals!.clicks)],
                  ["Impressions", fmt(overall.to.report.gscTotals!.impressions), formatDelta(overall.from.report.gscTotals!.impressions, overall.to.report.gscTotals!.impressions)],
                  ["CTR", `${(overall.to.report.gscTotals!.ctr * 100).toFixed(2)}%`, formatDelta(overall.from.report.gscTotals!.ctr, overall.to.report.gscTotals!.ctr, { decimals: 2, percent: true })],
                  ["Avg. position", overall.to.report.gscTotals!.position.toFixed(1), formatDelta(overall.from.report.gscTotals!.position, overall.to.report.gscTotals!.position, { decimals: 1, lowerIsBetter: true })],
                ] as const).map(([label, value, d]) => (
                  <div key={label} style={{ background: "var(--surface-2)", borderRadius: "var(--radius)", padding: "10px 12px" }}>
                    <div style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{label}</div>
                    <Delta d={d} />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
              <h2 style={{ fontSize: 14, fontWeight: 600 }}>Scans</h2>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th><th>Data</th><th style={{ textAlign: "right" }}>Keywords</th><th style={{ textAlign: "right" }}>Winnable</th>
                    <th style={{ textAlign: "right" }}>Clicks (28d)</th><th style={{ textAlign: "right" }}>Impressions (28d)</th><th style={{ textAlign: "right" }}>Avg. position</th><th />
                  </tr>
                </thead>
                <tbody>
                  {[...scans].reverse().map((scan, i, rows) => {
                    const prev = rows[i + 1];
                    const t = scan.report.gscTotals;
                    const pt = prev?.report.gscTotals;
                    return (
                      <tr key={scan.runId}>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <Link href={`/runs/${scan.runId}`}>{scan.at.toLocaleDateString()}</Link>
                          {scan === latest && <span className="badge badge-completed" style={{ marginLeft: 6 }}>latest</span>}
                          {scan.status === "AWAITING_APPROVAL" && <span className="badge badge-awaiting" style={{ marginLeft: 6 }}>unapproved</span>}
                        </td>
                        <td style={{ fontSize: 12, color: "var(--text-muted)" }}>{scan.report.source === "simulation" ? "Estimates" : scan.report.source.includes("gsc") ? "Search Console" : "Live SEO"}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {fmt(scan.report.summary.totalKeywords)}
                          {prev && <Delta d={formatDelta(prev.report.summary.totalKeywords, scan.report.summary.totalKeywords)} />}
                        </td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {fmt(scan.report.summary.winnable)}
                          {prev && <Delta d={formatDelta(prev.report.summary.winnable, scan.report.summary.winnable)} />}
                        </td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {t ? fmt(t.clicks) : "—"}
                          {t && pt && <Delta d={formatDelta(pt.clicks, t.clicks)} />}
                        </td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {t ? fmt(t.impressions) : "—"}
                          {t && pt && <Delta d={formatDelta(pt.impressions, t.impressions)} />}
                        </td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {t ? t.position.toFixed(1) : "—"}
                          {t && pt && <Delta d={formatDelta(pt.position, t.position, { decimals: 1, lowerIsBetter: true })} />}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <a href={withBase(`/api/runs/${scan.runId}/report`)} style={{ fontSize: 12 }}>HTML</a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!scans.some((s) => s.report.gscTotals) && (
              <p style={{ fontSize: 12, color: "var(--text-dim)", padding: "12px 20px", margin: 0 }}>
                Traffic columns fill in from the next scan onward for workspaces with Google Search Console connected.
              </p>
            )}
          </div>

          {moversCmp && (moversCmp.improved.length > 0 || moversCmp.declined.length > 0) && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
              {([["Moved up since the previous scan", moversCmp.improved, "var(--success)", "▲"], ["Moved down since the previous scan", moversCmp.declined, "var(--danger)", "▼"]] as const).map(([title, rows, color, arrow]) => (
                <div key={title} className="card">
                  <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>{title}</h2>
                  {rows.length === 0 ? (
                    <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0 }}>None.</p>
                  ) : (
                    <table className="table">
                      <thead><tr><th>Query</th><th style={{ textAlign: "right" }}>Was</th><th style={{ textAlign: "right" }}>Now</th><th style={{ textAlign: "right" }}>Change</th></tr></thead>
                      <tbody>
                        {rows.map((m) => (
                          <tr key={m.query}>
                            <td>{m.query}</td>
                            <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{m.before.toFixed(1)}</td>
                            <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{m.after.toFixed(1)}</td>
                            <td style={{ textAlign: "right", color, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{arrow} {Math.abs(m.change).toFixed(1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

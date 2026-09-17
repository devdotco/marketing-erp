/**
 * Keyword Research output → a report a person can act on.
 *
 * The run page used to print this agent's output as raw JSON. Both the on-page
 * dashboard (components/runs/KeywordResearchReport.tsx) and the downloadable
 * HTML file are built from `buildKeywordReport`, so the two cannot drift.
 *
 * Runs from before `opportunities` / `actions` / `gscQueries` existed still get
 * a full report: the missing sections are derived from the clusters.
 */

export type KwKeyword = {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  winnable: boolean;
  features: string[];
  cluster: string;
};

export type KwCluster = {
  name: string;
  intent: string;
  funnelStage: string;
  keywords: KwKeyword[];
  brief: {
    title: string;
    targetKeyword: string;
    secondaryKeywords: string[];
    outline: string[];
    wordCount: number | null;
    contentType: string;
    priorityScore: number | null;
  } | null;
};

export type KwGscQuery = { query: string; impressions: number; clicks: number; position: number };
export type KwOpportunity = { keyword: string; type: string; why: string; action: string };
export type KwAction = { priority: "high" | "medium" | "low"; title: string; detail: string };

export type KwGscTotals = { clicks: number; impressions: number; ctr: number; position: number; days: number };

export type KeywordReport = {
  source: string;
  gscProperty: string | null;
  gscTotals: KwGscTotals | null;
  /** Every saved Search Console row, not just the striking-distance slice — used for scan-to-scan comparison. */
  gscAll: KwGscQuery[];
  sourceLabel: string;
  dataNote: string | null;
  generatedAt: string | null;
  seeds: string[];
  summary: { totalKeywords: number; winnable: number; highPriority: number; avgDifficulty: number | null; trafficPotential: number | null; topOpportunity: string | null };
  actions: KwAction[];
  opportunities: KwOpportunity[];
  strikingDistance: KwGscQuery[];
  quickWins: KwKeyword[];
  clusters: KwCluster[];
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function isKeywordResearchOutput(output: unknown): boolean {
  return Array.isArray(rec(output).clusters);
}

const SOURCE_LABELS: Record<string, string> = {
  live: "Live SEO data (Ahrefs / Semrush / SearchAtlas)",
  "live+gsc": "Live SEO data + Google Search Console",
  gsc: "Google Search Console + AI estimates",
  simulation: "AI estimates (no SEO data connected)",
};

export function buildKeywordReport(raw: unknown): KeywordReport {
  const output = rec(raw);
  const source = str(output.source) || "simulation";

  const clusters: KwCluster[] = arr(output.clusters).map((c) => {
    const cluster = rec(c);
    const name = str(cluster.name) || "Untitled cluster";
    const brief = rec(cluster.brief);
    return {
      name,
      intent: str(cluster.intent),
      funnelStage: str(cluster.funnelStage),
      keywords: arr(cluster.keywords).map((k) => {
        const kw = rec(k);
        return {
          keyword: str(kw.keyword),
          volume: num(kw.estimatedVolume ?? kw.volume),
          difficulty: num(kw.difficulty),
          cpc: num(kw.cpc),
          winnable: kw.winnable === true,
          features: arr(rec(kw.serp).features).map(str).filter(Boolean),
          cluster: name,
        };
      }).filter((k) => k.keyword),
      brief: Object.keys(brief).length
        ? {
            title: str(brief.title),
            targetKeyword: str(brief.targetKeyword),
            secondaryKeywords: arr(brief.secondaryKeywords).map(str).filter(Boolean),
            outline: arr(brief.outline).map(str).filter(Boolean),
            wordCount: num(brief.wordCount),
            contentType: str(brief.contentType),
            priorityScore: num(brief.priorityScore),
          }
        : null,
    };
  });

  const allKeywords = clusters.flatMap((c) => c.keywords);
  const difficulties = allKeywords.map((k) => k.difficulty).filter((d): d is number => d !== null);
  const summary = rec(output.summary);

  const quickWins = allKeywords
    .filter((k) => k.winnable && (k.difficulty ?? 100) <= 40)
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, 15);

  const gscAll: KwGscQuery[] = arr(output.gscQueries)
    .map((q) => {
      const row = rec(q);
      return { query: str(row.query), impressions: num(row.impressions) ?? 0, clicks: num(row.clicks) ?? 0, position: num(row.position) ?? 0 };
    })
    .filter((q) => q.query);
  const strikingDistance = gscAll
    .filter((q) => q.position >= 4 && q.position <= 30)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 25);

  let opportunities: KwOpportunity[] = arr(output.opportunities)
    .map((o) => {
      const row = rec(o);
      return { keyword: str(row.keyword), type: str(row.type) || "gap", why: str(row.why), action: str(row.action) };
    })
    .filter((o) => o.keyword);
  if (opportunities.length === 0) {
    opportunities = [
      ...strikingDistance.slice(0, 8).map((q) => ({
        keyword: q.query,
        type: "striking distance",
        why: `Already ranks at position ${q.position.toFixed(1)} with ${q.impressions.toLocaleString("en-US")} impressions in 90 days.`,
        action: "Strengthen the ranking page: tighten the title and H1 to this query, expand the section that answers it, and add internal links pointing to it.",
      })),
      ...quickWins.slice(0, 8).map((k) => ({
        keyword: k.keyword,
        type: "content gap",
        why: `Winnable (difficulty ${k.difficulty ?? "?"}) with ~${(k.volume ?? 0).toLocaleString("en-US")} monthly searches.`,
        action: `Cover it in the "${k.cluster}" piece, or a dedicated page if intent differs.`,
      })),
    ];
  }

  let actions: KwAction[] = arr(output.actions)
    .map((a) => {
      const row = rec(a);
      const p = str(row.priority).toLowerCase();
      return { priority: (p === "high" || p === "low" ? p : "medium") as KwAction["priority"], title: str(row.title), detail: str(row.detail) };
    })
    .filter((a) => a.title);
  if (actions.length === 0) {
    const briefs = clusters
      .filter((c) => c.brief?.title)
      .sort((a, b) => (b.brief!.priorityScore ?? 0) - (a.brief!.priorityScore ?? 0));
    actions = [
      ...(strikingDistance.length
        ? [{ priority: "high" as const, title: `Push ${Math.min(strikingDistance.length, 8)} striking-distance queries onto page one`, detail: `Start with "${strikingDistance[0].query}" (position ${strikingDistance[0].position.toFixed(1)}). These already have impressions; on-page and internal-link work moves them fastest.` }]
        : []),
      ...briefs.slice(0, 5).map((c, i) => ({
        priority: (i < 2 ? "high" : "medium") as KwAction["priority"],
        title: `Publish: ${c.brief!.title}`,
        detail: `${c.brief!.contentType || "article"}${c.brief!.wordCount ? `, ~${c.brief!.wordCount} words` : ""}, targeting "${c.brief!.targetKeyword}" (${c.intent || "mixed"} intent, ${c.keywords.length} keywords in cluster).`,
      })),
    ];
  }

  const dataNote = str(output.simulationNote) || null;
  const gscNote = str(output.gscNote);

  const totals = rec(output.gscTotals);
  const gscTotals: KwGscTotals | null =
    num(totals.impressions) !== null
      ? { clicks: num(totals.clicks) ?? 0, impressions: num(totals.impressions) ?? 0, ctr: num(totals.ctr) ?? 0, position: num(totals.position) ?? 0, days: num(totals.days) ?? 28 }
      : null;

  return {
    source,
    gscProperty: str(output.gscProperty) || null,
    gscTotals,
    gscAll,
    sourceLabel: SOURCE_LABELS[source] ?? source,
    dataNote: [dataNote, gscNote].filter(Boolean).join(" ") || null,
    generatedAt: str(output.generatedAt) || null,
    seeds: arr(output.seeds).map(str).filter(Boolean),
    summary: {
      totalKeywords: num(summary.totalKeywords) ?? allKeywords.length,
      winnable: num(summary.winnableKeywords) ?? allKeywords.filter((k) => k.winnable).length,
      highPriority: num(summary.highPriority) ?? 0,
      avgDifficulty: num(summary.avgDifficulty) ?? (difficulties.length ? Math.round(difficulties.reduce((a, b) => a + b, 0) / difficulties.length) : null),
      trafficPotential: num(summary.estimatedMonthlyTrafficPotential),
      topOpportunity: str(summary.topOpportunity) || null,
    },
    actions,
    opportunities,
    strikingDistance,
    quickWins,
    clusters,
  };
}

export type KwMover = { query: string; before: number; after: number; change: number; impressions: number };

export type ScanComparison = {
  previousAt: string | null;
  totals: { clicks: [number, number]; impressions: [number, number]; ctr: [number, number]; position: [number, number] } | null;
  improved: KwMover[];
  declined: KwMover[];
  newQueries: KwGscQuery[];
  newKeywords: string[];
  droppedKeywords: string[];
  keywordCount: [number, number];
  winnable: [number, number];
};

/**
 * What changed between two scans. Search Console positions are the honest
 * signal of improvement; keyword lists are AI output and shift run to run, so
 * those are shown as coverage change, not as progress.
 */
export function compareScans(current: KeywordReport, previous: KeywordReport): ScanComparison {
  const prev = new Map(previous.gscAll.map((q) => [q.query.toLowerCase(), q]));
  const movers: KwMover[] = [];
  const newQueries: KwGscQuery[] = [];
  for (const q of current.gscAll) {
    const before = prev.get(q.query.toLowerCase());
    if (!before) {
      if (previous.gscAll.length > 0) newQueries.push(q);
      continue;
    }
    const change = Math.round((before.position - q.position) * 10) / 10; // positive = moved up
    if (Math.abs(change) >= 0.5) movers.push({ query: q.query, before: before.position, after: q.position, change, impressions: q.impressions });
  }
  const weight = (m: KwMover) => Math.abs(m.change) * Math.log10(10 + m.impressions);
  const kwSet = (r: KeywordReport) => new Set(r.clusters.flatMap((c) => c.keywords.map((k) => k.keyword.toLowerCase())));
  const cur = kwSet(current);
  const old = kwSet(previous);

  return {
    previousAt: previous.generatedAt,
    totals:
      current.gscTotals && previous.gscTotals
        ? {
            clicks: [previous.gscTotals.clicks, current.gscTotals.clicks],
            impressions: [previous.gscTotals.impressions, current.gscTotals.impressions],
            ctr: [previous.gscTotals.ctr, current.gscTotals.ctr],
            position: [previous.gscTotals.position, current.gscTotals.position],
          }
        : null,
    improved: movers.filter((m) => m.change > 0).sort((a, b) => weight(b) - weight(a)).slice(0, 10),
    declined: movers.filter((m) => m.change < 0).sort((a, b) => weight(b) - weight(a)).slice(0, 10),
    newQueries: newQueries.sort((a, b) => b.impressions - a.impressions).slice(0, 10),
    newKeywords: [...cur].filter((k) => !old.has(k)).slice(0, 30),
    droppedKeywords: [...old].filter((k) => !cur.has(k)).slice(0, 30),
    keywordCount: [previous.summary.totalKeywords, current.summary.totalKeywords],
    winnable: [previous.summary.winnable, current.summary.winnable],
  };
}

export function formatDelta(before: number, after: number, opts: { decimals?: number; lowerIsBetter?: boolean; percent?: boolean } = {}): { text: string; tone: "up" | "down" | "flat" } {
  const d = after - before;
  const decimals = opts.decimals ?? 0;
  const scale = opts.percent ? 100 : 1;
  const shown = (Math.abs(d) * scale).toFixed(decimals);
  if (Number(shown) === 0) return { text: "no change", tone: "flat" };
  const better = opts.lowerIsBetter ? d < 0 : d > 0;
  return { text: `${d > 0 ? "+" : "−"}${Number(shown).toLocaleString("en-US")}${opts.percent ? " pts" : ""}`, tone: better ? "up" : "down" };
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmt = (n: number | null): string => (n === null ? "—" : n.toLocaleString("en-US"));

/** A self-contained HTML file: inline CSS, no scripts, prints cleanly. */
export function renderKeywordReportHtml(report: KeywordReport, meta: { workspaceName: string; runId: string; comparison?: ScanComparison | null }): string {
  const r = report;
  const cmp = meta.comparison ?? null;
  const tone = (d: { text: string; tone: string }) => `<span class="d-${d.tone}">${esc(d.text)}</span>`;
  const since = cmp
    ? `<h2>Since last scan <span class="muted">${cmp.previousAt ? `— ${esc(new Date(cmp.previousAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }))}` : ""}</span></h2>
  ${cmp.totals ? `<div class="kpis">
    ${kpiDelta("Clicks (28d)", fmt(cmp.totals.clicks[1]), tone(formatDelta(cmp.totals.clicks[0], cmp.totals.clicks[1])))}
    ${kpiDelta("Impressions (28d)", fmt(cmp.totals.impressions[1]), tone(formatDelta(cmp.totals.impressions[0], cmp.totals.impressions[1])))}
    ${kpiDelta("CTR", (cmp.totals.ctr[1] * 100).toFixed(2) + "%", tone(formatDelta(cmp.totals.ctr[0], cmp.totals.ctr[1], { decimals: 2, percent: true })))}
    ${kpiDelta("Avg. position", cmp.totals.position[1].toFixed(1), tone(formatDelta(cmp.totals.position[0], cmp.totals.position[1], { decimals: 1, lowerIsBetter: true })))}
  </div>` : `<p class="muted">Search Console totals weren't captured on both scans, so traffic change isn't shown.</p>`}
  ${cmp.improved.length ? `<h3 style="margin-top:18px">Moved up</h3><div class="tw"><table><thead><tr><th>Query</th><th class="n">Was</th><th class="n">Now</th><th class="n">Change</th></tr></thead><tbody>${cmp.improved.map((m) => `<tr><td>${esc(m.query)}</td><td class="n">${m.before.toFixed(1)}</td><td class="n">${m.after.toFixed(1)}</td><td class="n d-up">▲ ${m.change.toFixed(1)}</td></tr>`).join("")}</tbody></table></div>` : ""}
  ${cmp.declined.length ? `<h3 style="margin-top:18px">Moved down</h3><div class="tw"><table><thead><tr><th>Query</th><th class="n">Was</th><th class="n">Now</th><th class="n">Change</th></tr></thead><tbody>${cmp.declined.map((m) => `<tr><td>${esc(m.query)}</td><td class="n">${m.before.toFixed(1)}</td><td class="n">${m.after.toFixed(1)}</td><td class="n d-down">▼ ${Math.abs(m.change).toFixed(1)}</td></tr>`).join("")}</tbody></table></div>` : ""}
  ${cmp.newQueries.length ? `<h3 style="margin-top:18px">New queries showing up</h3><div class="tw"><table><thead><tr><th>Query</th><th class="n">Position</th><th class="n">Impressions</th></tr></thead><tbody>${cmp.newQueries.map((q) => `<tr><td>${esc(q.query)}</td><td class="n">${q.position.toFixed(1)}</td><td class="n">${fmt(q.impressions)}</td></tr>`).join("")}</tbody></table></div>` : ""}
  <p class="muted">Keyword coverage: ${fmt(cmp.keywordCount[0])} → ${fmt(cmp.keywordCount[1])} keywords, ${fmt(cmp.winnable[0])} → ${fmt(cmp.winnable[1])} winnable; ${cmp.newKeywords.length} new this scan.</p>`
    : "";
  const date = r.generatedAt ? new Date(r.generatedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "";
  function kpiDelta(label: string, value: string, delta: string) {
    return `<div class="kpi"><div class="kv">${esc(value)}</div><div class="kl">${esc(label)} · ${delta}</div></div>`;
  }
  const kpi = (label: string, value: string) => `<div class="kpi"><div class="kv">${esc(value)}</div><div class="kl">${esc(label)}</div></div>`;

  const actions = r.actions.map((a) => `<li class="action"><span class="pill p-${a.priority}">${a.priority}</span><div><strong>${esc(a.title)}</strong><p>${esc(a.detail)}</p></div></li>`).join("");
  const opps = r.opportunities.map((o) => `<tr><td><strong>${esc(o.keyword)}</strong><div class="muted">${esc(o.type)}</div></td><td>${esc(o.why)}</td><td>${esc(o.action)}</td></tr>`).join("");
  const striking = r.strikingDistance.map((q) => `<tr><td>${esc(q.query)}</td><td class="n">${q.position.toFixed(1)}</td><td class="n">${fmt(q.impressions)}</td><td class="n">${fmt(q.clicks)}</td></tr>`).join("");
  const wins = r.quickWins.map((k) => `<tr><td>${esc(k.keyword)}</td><td>${esc(k.cluster)}</td><td class="n">${fmt(k.volume)}</td><td class="n">${fmt(k.difficulty)}</td><td class="n">${k.cpc === null ? "—" : "$" + k.cpc.toFixed(2)}</td></tr>`).join("");
  const clusters = r.clusters.map((c) => `
    <section class="cluster">
      <h3>${esc(c.name)} <span class="muted">· ${esc(c.intent)}${c.funnelStage ? ` · ${esc(c.funnelStage)} of funnel` : ""}</span></h3>
      ${c.brief ? `<div class="brief"><div><strong>${esc(c.brief.title)}</strong>${c.brief.priorityScore !== null ? ` <span class="pill p-medium">priority ${c.brief.priorityScore}</span>` : ""}</div>
        <p class="muted">${esc(c.brief.contentType)}${c.brief.wordCount ? ` · ~${c.brief.wordCount} words` : ""} · target: ${esc(c.brief.targetKeyword)}${c.brief.secondaryKeywords.length ? ` · also: ${esc(c.brief.secondaryKeywords.join(", "))}` : ""}</p>
        ${c.brief.outline.length ? `<ol>${c.brief.outline.map((h) => `<li>${esc(h)}</li>`).join("")}</ol>` : ""}</div>` : ""}
      <table><thead><tr><th>Keyword</th><th class="n">Volume</th><th class="n">Difficulty</th><th class="n">CPC</th><th>Winnable</th></tr></thead><tbody>
      ${c.keywords.map((k) => `<tr><td>${esc(k.keyword)}</td><td class="n">${fmt(k.volume)}</td><td class="n">${fmt(k.difficulty)}</td><td class="n">${k.cpc === null ? "—" : "$" + k.cpc.toFixed(2)}</td><td>${k.winnable ? "Yes" : "—"}</td></tr>`).join("")}
      </tbody></table>
    </section>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Keyword Research — ${esc(meta.workspaceName)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #18181b; background: #fafafa; margin: 0; padding: 32px 20px; }
  main { max-width: 1040px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.02em; }
  h2 { font-size: 17px; margin: 36px 0 12px; }
  h3 { font-size: 15px; margin: 0 0 10px; }
  .muted { color: #71717a; font-weight: 400; font-size: 12.5px; }
  .note { background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px; padding: 10px 14px; margin: 16px 0; font-size: 13px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 20px; }
  .kpi, .cluster, .card { background: #fff; border: 1px solid #e4e4e7; border-radius: 10px; padding: 14px 16px; }
  .kv { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .kl { font-size: 12px; color: #71717a; }
  ul.actions { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
  .action { display: flex; gap: 12px; align-items: flex-start; background: #fff; border: 1px solid #e4e4e7; border-radius: 10px; padding: 12px 14px; }
  .action p { margin: 2px 0 0; color: #52525b; }
  .pill { display: inline-block; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; padding: 2px 8px; border-radius: 99px; white-space: nowrap; }
  .p-high { background: #fee2e2; color: #b91c1c; } .p-medium { background: #fef3c7; color: #92400e; } .p-low { background: #e0f2fe; color: #075985; }
  .tw { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; background: #fff; font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #f0f0f2; vertical-align: top; }
  th { font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; color: #71717a; background: #fafafa; }
  .n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .cluster { margin-bottom: 14px; }
  .brief { background: #f4f4f5; border-radius: 8px; padding: 10px 14px; margin-bottom: 10px; }
  .brief ol { margin: 6px 0 0; padding-left: 20px; color: #3f3f46; }
  .d-up { color: #047857; font-weight: 600; } .d-down { color: #b91c1c; font-weight: 600; } .d-flat { color: #71717a; }
  footer { margin-top: 40px; color: #a1a1aa; font-size: 12px; }
  @media print { body { background: #fff; padding: 0; } .cluster, .action { break-inside: avoid; } }
</style></head>
<body><main>
  <h1>Keyword Research</h1>
  <div class="muted">${esc(meta.workspaceName)}${date ? ` · ${esc(date)}` : ""} · Data: ${esc(r.sourceLabel)}</div>
  ${r.seeds.length ? `<div class="muted">Seeds: ${esc(r.seeds.join(", "))}</div>` : ""}
  ${r.dataNote ? `<div class="note">${esc(r.dataNote)}</div>` : ""}
  <div class="kpis">
    ${kpi("Keywords found", fmt(r.summary.totalKeywords))}
    ${kpi("Winnable", fmt(r.summary.winnable))}
    ${kpi("Avg. difficulty", fmt(r.summary.avgDifficulty))}
    ${kpi("Monthly traffic potential", fmt(r.summary.trafficPotential))}
    ${kpi("Clusters", fmt(r.clusters.length))}
  </div>
  ${r.summary.topOpportunity ? `<p><strong>Top opportunity:</strong> ${esc(r.summary.topOpportunity)}</p>` : ""}
  ${since}
  ${actions ? `<h2>What to do next</h2><ul class="actions">${actions}</ul>` : ""}
  ${opps ? `<h2>Gaps &amp; opportunities</h2><div class="tw"><table><thead><tr><th>Keyword</th><th>Why it matters</th><th>Action</th></tr></thead><tbody>${opps}</tbody></table></div>` : ""}
  ${striking ? `<h2>Striking distance <span class="muted">— real Google Search Console queries, last 90 days</span></h2><div class="tw"><table><thead><tr><th>Query</th><th class="n">Avg. position</th><th class="n">Impressions</th><th class="n">Clicks</th></tr></thead><tbody>${striking}</tbody></table></div>` : ""}
  ${wins ? `<h2>Quick wins <span class="muted">— winnable, difficulty ≤ 40</span></h2><div class="tw"><table><thead><tr><th>Keyword</th><th>Cluster</th><th class="n">Volume</th><th class="n">Difficulty</th><th class="n">CPC</th></tr></thead><tbody>${wins}</tbody></table></div>` : ""}
  <h2>Clusters &amp; content briefs</h2>
  ${clusters}
  <footer>erp.io Marketing · Keyword Research run ${esc(meta.runId)}</footer>
</main></body></html>`;
}

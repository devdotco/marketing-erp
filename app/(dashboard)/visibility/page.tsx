import { redirect } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { resolveWorkspaceId } from "@/lib/actions/workspace";
import { connectedEngines, ENGINE_NAMES } from "@/lib/answer-engines";
import { METRICS } from "@/lib/visibility/observations";
import {
  citationAuthority,
  deltaOf,
  readSeries,
  shareOfVoice,
  visibilityByEngine,
} from "@/lib/visibility/series";
import { TrendChart } from "@/components/charts/TrendChart";
import { BarList } from "@/components/charts/BarList";
import { StatTile } from "@/components/charts/StatTile";

export const metadata = { title: "AI Visibility — marketing.erp.io" };
export const dynamic = "force-dynamic";

const WINDOW_DAYS = 30;

/**
 * What the answer engines say about this brand, over time.
 *
 * The first screen in this product to show a number that moves. Everything on
 * it reads from Observation — the same rows the agent writes — so the report
 * inside a run and this page can never disagree.
 */
export default async function VisibilityPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");

  const [visibility, rank, sentiment, byEngine, voice, authority, engines, promptCount, lastCapture] =
    await Promise.all([
      readSeries(workspaceId, { subject: "brand", metric: METRICS.VISIBILITY, days: WINDOW_DAYS }),
      readSeries(workspaceId, { subject: "brand", metric: METRICS.BRAND_RANK, days: WINDOW_DAYS }),
      readSeries(workspaceId, { subject: "brand", metric: METRICS.SENTIMENT, days: WINDOW_DAYS }),
      visibilityByEngine(workspaceId, WINDOW_DAYS),
      shareOfVoice(workspaceId, WINDOW_DAYS),
      citationAuthority(workspaceId, { days: WINDOW_DAYS, limit: 12 }),
      connectedEngines(workspaceId),
      prisma.trackedPrompt.count({ where: { workspaceId, active: true } }),
      prisma.answerCapture.findFirst({
        where: { workspaceId },
        orderBy: { capturedAt: "desc" },
        select: { capturedAt: true, capturedOn: true },
      }),
    ]);

  const vis = deltaOf(visibility);
  const rankDelta = deltaOf(rank);
  const sentimentDelta = deltaOf(sentiment);
  const hasData = visibility.points.length > 0;

  return (
    <div className="scrollable">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 8, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 4 }}>AI Visibility</h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {hasData
              ? `${promptCount} prompts across ${engines.length} ${engines.length === 1 ? "engine" : "engines"} · last captured ${lastCapture?.capturedOn ?? "—"}`
              : "What the answer engines say about you, measured from their actual answers."}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link href="/visibility/prompts" className="btn btn-secondary">
            Prompts{promptCount > 0 ? ` (${promptCount})` : ""}
          </Link>
          <Link href="/agents/ai-search-visibility" className="btn btn-primary">
            Capture now
          </Link>
        </div>
      </div>

      {engines.length === 0 && (
        <Notice tone="warning" title="No answer engine is connected">
          Nothing can be measured until at least one of OpenAI, Google Gemini, Perplexity or Anthropic is connected
          under <Link href="/integrations">Settings → Integrations</Link>. Captures run on your own keys — we will
          not estimate what an engine might have said.
        </Notice>
      )}

      {engines.length > 0 && promptCount === 0 && (
        <Notice tone="info" title="No prompts are being tracked yet">
          <Link href="/visibility/prompts">Add the questions</Link> your customers ask an assistant, or let the
          agent propose twenty from your own Search Console demand on its first run.
        </Notice>
      )}

      {engines.length > 0 && promptCount > 0 && !hasData && (
        <Notice tone="info" title="Nothing captured yet">
          Everything is set up. Run <Link href="/agents/ai-search-visibility">AI Search Visibility</Link> once to
          take the first reading, then schedule it daily so this page has a trend to draw.
        </Notice>
      )}

      {/* Headline figures. Only measured ones get a tile. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 20, marginBottom: 24 }}>
        <StatTile
          label="Visibility"
          value={vis.latest}
          unit="%"
          change={vis.change}
          changeSuffix={`in ${vis.samples} days`}
          hint="Share of answers that name you"
        />
        <StatTile
          label="Rank when named"
          value={rankDelta.latest}
          change={rankDelta.change}
          lowerIsBetter
          hint="1 = named before any competitor"
        />
        <StatTile
          label="How you're described"
          value={sentimentDelta.latest}
          change={sentimentDelta.change}
          hint="1 recommended · 0 neutral · -1 criticised"
        />
        <StatTile
          label="Engines measured"
          value={engines.length === 0 ? null : engines.length}
          hint={engines.map((e) => ENGINE_NAMES[e]).join(", ") || "None connected"}
        />
      </div>

      <div style={{ display: "grid", gap: 16 }}>
        <div className="card">
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Visibility over time</h2>
          <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 14 }}>
            The share of captured answers that named you, by day.
          </p>
          <TrendChart points={visibility.points} label="Visibility" unit="%" max={100} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
          <div className="card">
            <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Share of voice</h2>
            <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 14 }}>
              You against every competitor you track, on the latest day measured.
            </p>
            <BarList
              items={voice.map((v) => ({
                label: v.isBrand ? "You" : v.subject,
                value: v.value,
                emphasis: v.isBrand,
              }))}
              max={100}
              emptyLabel="No competitors measured yet. Add them to your business profile and capture again."
            />
          </div>

          <div className="card">
            <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Visibility by engine</h2>
            <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 14 }}>
              Engines disagree. Where you are absent is where the work is.
            </p>
            <BarList
              items={byEngine.map((e) => ({
                label: ENGINE_NAMES[e.engine as keyof typeof ENGINE_NAMES] ?? e.engine,
                value: e.value,
                emphasis: true,
              }))}
              max={100}
              emptyLabel="No captures yet."
            />
          </div>
        </div>

        <div className="card">
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>What the answers cite</h2>
          <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 14 }}>
            The sources these engines lean on when answering about your category. Earning a mention on one of these
            is usually faster than trying to be cited directly.
          </p>
          {authority.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--text-dim)", margin: 0 }}>No citations captured yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Domain</th>
                    <th style={{ width: 120 }}>Citations</th>
                    <th style={{ width: 110 }}>Yours?</th>
                  </tr>
                </thead>
                <tbody>
                  {authority.map((a) => (
                    <tr key={a.domain}>
                      <td style={{ fontFamily: "monospace", fontSize: 12.5 }}>{a.domain}</td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>{a.citations}</td>
                      <td>
                        {a.isOwned ? (
                          <span className="badge badge-active">Your site</span>
                        ) : (
                          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: "warning" | "info";
  title: string;
  children: React.ReactNode;
}) {
  const fg = tone === "warning" ? "var(--warning)" : "var(--info)";
  const bg = tone === "warning" ? "var(--warning-bg)" : "var(--info-bg)";
  return (
    <div style={{ background: bg, border: `1px solid ${fg}`, borderRadius: "var(--radius)", padding: "14px 18px", marginTop: 16 }}>
      <p style={{ fontSize: 13, fontWeight: 600, color: fg, marginBottom: 4 }}>{title}</p>
      <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>{children}</p>
    </div>
  );
}

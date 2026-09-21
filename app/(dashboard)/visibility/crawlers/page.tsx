import { redirect } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import { crawlerByKey, PURPOSE_LABEL } from "@/lib/crawlers/bots";
import {
  botTotals,
  crawlErrors,
  crawlTrend,
  hasCrawlData,
  referralTotals,
  topCrawledPages,
  topReferredPages,
} from "@/lib/crawlers/series";
import { TrendChart } from "@/components/charts/TrendChart";
import { BarList } from "@/components/charts/BarList";
import { StatTile } from "@/components/charts/StatTile";

export const metadata = { title: "AI crawlers — marketing.erp.io" };
export const dynamic = "force-dynamic";

const DAYS = 30;

/**
 * What the engines read, and who arrived because of it.
 *
 * The companion to the visibility dashboard and a stronger kind of evidence:
 * visibility is derived from answers we captured, this is counted from what
 * the CDN actually served. It is also the only view in the product that can
 * show a crawler being handed errors, which no tag-based analytics can see
 * because the page never rendered.
 */
export default async function CrawlersPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");
  await requireWorkspaceAccess(workspaceId);

  const [connected, hasData] = await Promise.all([
    prisma.integration.findUnique({
      where: { workspaceId_provider: { workspaceId, provider: "CLOUDFLARE_LOGPUSH" } },
      select: { id: true },
    }),
    hasCrawlData(workspaceId),
  ]);

  const [bots, trend, pages, errors, referrals, referredPages] = await Promise.all([
    botTotals(workspaceId, DAYS),
    crawlTrend(workspaceId, DAYS),
    topCrawledPages(workspaceId, { days: DAYS }),
    crawlErrors(workspaceId, { days: DAYS }),
    referralTotals(workspaceId, DAYS),
    topReferredPages(workspaceId, { days: DAYS }),
  ]);

  const totalHits = bots.reduce((s, b) => s + b.hits, 0);
  const totalVerified = bots.reduce((s, b) => s + b.verifiedHits, 0);
  const totalErrors = bots.reduce((s, b) => s + b.errorHits, 0);
  const totalVisits = referrals.reduce((s, r) => s + r.visits, 0);

  return (
    <div className="scrollable">
      <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 20 }}>
        <Link href="/visibility" style={{ color: "var(--text-dim)", textDecoration: "none" }}>
          AI Visibility
        </Link>
        {" / "}
        <span>Crawlers</span>
      </div>

      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 4 }}>
          AI crawlers and referrals
        </h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: "64ch", lineHeight: 1.6 }}>
          Counted from your Cloudflare request logs over the last {DAYS} days — what the engines read, and who came
          back as a result. Read from server logs rather than a page tag, so a crawler is visible at all and a human
          with an ad blocker still counts.
        </p>
      </div>

      {!connected && (
        <div style={{ background: "var(--info-bg)", border: "1px solid var(--info)", borderRadius: "var(--radius)", padding: "14px 18px", marginBottom: 20 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: "var(--info)", marginBottom: 4 }}>
            Cloudflare Logpush is not connected
          </p>
          <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
            <Link href="/integrations/connect/CLOUDFLARE_LOGPUSH">Connect it</Link> to get a destination URL, then
            create a Logpush job in Cloudflare pointing at it. Setup takes about fifteen minutes and needs Cloudflare
            Pro or above.
          </p>
        </div>
      )}

      {connected && !hasData && (
        <div style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "14px 18px", marginBottom: 20 }}>
          <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
            Connected, but no log batches have arrived yet. Cloudflare delivers every few minutes — give it an hour
            before worrying, and check the job&apos;s status in Cloudflare if it stays empty.
          </p>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 24 }}>
        <StatTile label="Crawler requests" value={hasData ? totalHits : null} hint={`Across ${bots.length} AI crawlers`} />
        <StatTile
          label="Verified"
          value={hasData && totalHits > 0 ? Math.round((totalVerified / totalHits) * 1000) / 10 : null}
          unit="%"
          hint="Most operators publish nothing to check against"
        />
        <StatTile label="Served an error" value={hasData ? totalErrors : null} hint="Fix these first" />
        <StatTile label="Visits from AI answers" value={hasData ? totalVisits : null} hint="Undercounts — see below" />
      </div>

      <div style={{ display: "grid", gap: 16 }}>
        <div className="card">
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Crawl volume</h2>
          <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 14 }}>
            Total AI crawler requests per day.
          </p>
          <TrendChart points={trend} label="Crawler requests" unit="" />
        </div>

        {errors.length > 0 && (
          <div className="card" style={{ borderColor: "var(--warning)" }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4, color: "var(--warning)" }}>
              Crawlers are being served errors
            </h2>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14, lineHeight: 1.6 }}>
              A page an engine cannot read is a page it cannot cite. This is the one table here worth acting on
              today, and no page-tag analytics can show it — the tag never ran.
            </p>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Path</th>
                    <th style={{ width: 150 }}>Crawler</th>
                    <th style={{ width: 90 }}>Errors</th>
                    <th style={{ width: 90 }}>Of total</th>
                  </tr>
                </thead>
                <tbody>
                  {errors.map((e) => (
                    <tr key={`${e.bot}-${e.path}`}>
                      <td style={{ fontFamily: "monospace", fontSize: 12.5, wordBreak: "break-all" }}>{e.path}</td>
                      <td style={{ fontSize: 12.5 }}>{e.bot}</td>
                      <td style={{ fontVariantNumeric: "tabular-nums", color: "var(--warning)", fontWeight: 600 }}>
                        {e.errorHits}
                      </td>
                      <td style={{ fontVariantNumeric: "tabular-nums", color: "var(--text-dim)" }}>{e.hits}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="card">
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Which crawlers came</h2>
          <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 14, lineHeight: 1.6 }}>
            A user agent is a claim. Verified means the request&apos;s source address actually passed the
            operator&apos;s published check — most operators publish none, and those are counted and labelled
            honestly rather than dropped.
          </p>
          {bots.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--text-dim)", margin: 0 }}>No crawler requests recorded yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Crawler</th>
                    <th style={{ width: 170 }}>What it is doing</th>
                    <th style={{ width: 90 }}>Requests</th>
                    <th style={{ width: 110 }}>Verified</th>
                    <th style={{ width: 80 }}>Pages</th>
                  </tr>
                </thead>
                <tbody>
                  {bots.map((b) => {
                    const meta = crawlerByKey(b.bot);
                    return (
                      <tr key={b.bot}>
                        <td>
                          <span style={{ fontWeight: 600, fontSize: 13 }}>{b.bot}</span>
                          {meta && (
                            <span style={{ display: "block", fontSize: 11, color: "var(--text-dim)" }}>
                              {meta.operator}
                            </span>
                          )}
                        </td>
                        <td style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                          {meta ? PURPOSE_LABEL[meta.purpose] : "—"}
                        </td>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}>{b.hits}</td>
                        <td>
                          {b.verifiedHits > 0 ? (
                            <span className="badge badge-active">{b.verifiedHits}</span>
                          ) : (
                            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>unverified</span>
                          )}
                        </td>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}>{b.pages}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
          <div className="card">
            <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Most-read pages</h2>
            <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 14 }}>
              What the engines spend their crawl on.
            </p>
            <BarList
              items={pages.map((p) => ({ label: p.path, value: p.hits, emphasis: p.errorHits > 0 }))}
              unit=""
              emptyLabel="No pages crawled yet."
            />
          </div>

          <div className="card">
            <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Visits from AI answers</h2>
            <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 14, lineHeight: 1.6 }}>
              People who clicked through from an assistant. Some assistants send no referrer and native apps send
              none at all, so this is a floor, not a total.
            </p>
            <BarList
              items={referrals.map((r) => ({ label: r.source, value: r.visits, emphasis: true }))}
              unit=""
              emptyLabel="No AI referrals recorded yet."
            />
          </div>
        </div>

        {referredPages.length > 0 && (
          <div className="card">
            <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Pages AI answers send people to</h2>
            <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 14 }}>
              Where the traffic actually lands. Usually a shorter list than the pages being crawled.
            </p>
            <BarList
              items={referredPages.map((p) => ({ label: p.path, value: p.visits, emphasis: true }))}
              unit=""
              emptyLabel="Nothing yet."
            />
          </div>
        )}
      </div>
    </div>
  );
}

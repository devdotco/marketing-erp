import { getServerSession } from "@/lib/session";
import { redirect } from "next/navigation";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import { prisma } from "@/lib/prisma";
import { formatDistanceToNow } from "@/lib/utils";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const metadata = { title: "Outbound Engine — marketing.erp.io" };

const PLAY_SLUGS = ["DEV-01", "DEV-02", "DEV-03"];

type StatusCountRow = {
  status: string;
  playId: string;
  _count: { _all: number };
};

function getCount(rows: StatusCountRow[], playId: string | null, status: string): number {
  return rows
    .filter((r) => (playId === null || r.playId === playId) && r.status === status)
    .reduce((sum, r) => sum + r._count._all, 0);
}

function scoreColor(score: number): string {
  if (score >= 80) return "var(--success)";
  if (score >= 65) return "var(--warning)";
  if (score >= 50) return "#f97316";
  return "var(--text-dim)";
}

function statusBadgeStyle(status: string): React.CSSProperties {
  const base: React.CSSProperties = {
    display: "inline-block",
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.04em",
    padding: "2px 7px",
    borderRadius: 4,
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  };
  switch (status) {
    case "PENDING":
      return { ...base, background: "var(--surface-2)", color: "var(--text-muted)", border: "1px solid var(--border)" };
    case "IN_SEQUENCE":
      return { ...base, background: "rgba(59,130,246,0.12)", color: "var(--accent)", border: "1px solid var(--accent)" };
    case "REPLIED":
      return { ...base, background: "rgba(234,179,8,0.12)", color: "var(--warning)", border: "1px solid var(--warning)" };
    case "INTERESTED":
      return { ...base, background: "var(--success-bg)", color: "var(--success)", border: "1px solid var(--success)" };
    case "MEETING_BOOKED":
      return { ...base, background: "var(--success-bg)", color: "var(--success)", border: "1px solid var(--success)", fontWeight: 700 };
    case "NOT_INTERESTED":
      return { ...base, background: "rgba(239,68,68,0.12)", color: "var(--danger)", border: "1px solid var(--danger)" };
    case "CONVERTED":
      return { ...base, background: "var(--success-bg)", color: "var(--success)", border: "2px solid var(--success)" };
    case "SUPPRESSED":
      return { ...base, background: "var(--surface-2)", color: "var(--text-dim)", border: "1px solid var(--border)" };
    default:
      return { ...base, background: "var(--surface-2)", color: "var(--text-muted)", border: "1px solid var(--border)" };
  }
}

function channelBadgeStyle(channel: string): React.CSSProperties {
  const base: React.CSSProperties = {
    display: "inline-block",
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.03em",
    padding: "2px 7px",
    borderRadius: 4,
    whiteSpace: "nowrap",
  };
  switch (channel) {
    case "EMAIL_AND_LINKEDIN":
      return { ...base, background: "rgba(59,130,246,0.12)", color: "var(--accent)", border: "1px solid var(--accent)" };
    case "EMAIL_ONLY":
      return { ...base, background: "var(--surface-2)", color: "var(--text-muted)", border: "1px solid var(--border)" };
    case "WATCHLIST":
      return { ...base, background: "var(--surface-2)", color: "var(--text-dim)", border: "1px solid var(--border)" };
    default:
      return { ...base, background: "var(--surface-2)", color: "var(--text-dim)", border: "1px solid var(--border)" };
  }
}

function channelLabel(channel: string): string {
  switch (channel) {
    case "EMAIL_AND_LINKEDIN": return "Email + LI";
    case "EMAIL_ONLY": return "Email";
    case "WATCHLIST": return "Watchlist";
    case "DISCARDED": return "Discarded";
    default: return channel;
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "PENDING": return "Pending";
    case "IN_SEQUENCE": return "In Sequence";
    case "REPLIED": return "Replied";
    case "INTERESTED": return "Interested";
    case "NOT_INTERESTED": return "Not Interested";
    case "MEETING_BOOKED": return "Meeting Booked";
    case "CONVERTED": return "Converted";
    case "SUPPRESSED": return "Suppressed";
    default: return status;
  }
}

export default async function OutboundPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");

  await requireWorkspaceAccess(workspaceId);

  const [plays, rawStatusCounts, recentProspects] = await Promise.all([
    prisma.outboundPlay.findMany({
      where: { workspaceId },
      include: {
        _count: { select: { prospects: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.outboundProspect.groupBy({
      by: ["status", "playId"],
      where: { workspaceId },
      _count: { _all: true },
    }),
    prisma.outboundProspect.findMany({
      where: { workspaceId },
      include: { play: true },
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
  ]);

  // Cast to our local type — Prisma groupBy shape matches at runtime
  const statusCounts = rawStatusCounts as unknown as StatusCountRow[];

  // Global totals
  const totalProspects = plays.reduce((sum, p) => sum + p._count.prospects, 0);
  const totalInSequence = getCount(statusCounts, null, "IN_SEQUENCE");
  const totalReplied = getCount(statusCounts, null, "REPLIED");
  const totalInterested = getCount(statusCounts, null, "INTERESTED");
  const totalMeetings = getCount(statusCounts, null, "MEETING_BOOKED");

  // Build a map from slug → play for the 3 canonical plays
  const playBySlug = Object.fromEntries(plays.map((p) => [p.slug, p]));

  return (
    <div className="scrollable">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 4 }}>
            Outbound Engine
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
            Dev.co autonomous pipeline: Scout → Score → Email → LinkedIn → Revenue
          </p>
        </div>
        <Link href="/agents/outbound-scout" className="btn btn-primary">
          Run Scout
        </Link>
      </div>

      {/* Quick stats bar */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 10,
          marginBottom: 24,
        }}
      >
        {[
          { label: "Total Prospects", value: totalProspects, color: undefined },
          { label: "In Sequence", value: totalInSequence, color: "var(--accent)" },
          { label: "Replied", value: totalReplied, color: "var(--warning)" },
          { label: "Interested", value: totalInterested, color: "var(--success)" },
          { label: "Meetings Booked", value: totalMeetings, color: "var(--success)" },
        ].map((stat) => (
          <div key={stat.label} className="stat-card">
            <div className="stat-value" style={stat.color ? { color: stat.color } : undefined}>
              {stat.value}
            </div>
            <div className="stat-label">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Play cards */}
      <div style={{ marginBottom: 32 }}>
        <h2
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-dim)",
            marginBottom: 12,
          }}
        >
          Active Plays
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          {PLAY_SLUGS.map((slug) => {
            const play = playBySlug[slug];

            if (!play) {
              return (
                <div
                  key={slug}
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: 20,
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                        fontFamily: "monospace",
                        background: "var(--surface-2)",
                        color: "var(--text-dim)",
                        border: "1px solid var(--border)",
                        padding: "2px 7px",
                        borderRadius: 4,
                      }}
                    >
                      {slug}
                    </span>
                  </div>
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "20px 0", gap: 8 }}>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", textAlign: "center" }}>
                      No play configured yet
                    </p>
                    <Link
                      href="/agents/outbound-scout"
                      style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none" }}
                    >
                      Run Scout to populate →
                    </Link>
                  </div>
                </div>
              );
            }

            const inSeq = getCount(statusCounts, play.id, "IN_SEQUENCE");
            const replied = getCount(statusCounts, play.id, "REPLIED");
            const interested = getCount(statusCounts, play.id, "INTERESTED");
            const meetings = getCount(statusCounts, play.id, "MEETING_BOOKED");

            return (
              <div
                key={slug}
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: 20,
                  display: "flex",
                  flexDirection: "column",
                  gap: 14,
                }}
              >
                {/* Play header */}
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
                      {play.name}
                    </div>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                        fontFamily: "monospace",
                        background: "rgba(59,130,246,0.1)",
                        color: "var(--accent)",
                        border: "1px solid var(--accent)",
                        padding: "2px 7px",
                        borderRadius: 4,
                      }}
                    >
                      {play.slug}
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: play.enabled ? "var(--success)" : "var(--text-dim)",
                      background: play.enabled ? "var(--success-bg)" : "var(--surface-2)",
                      border: `1px solid ${play.enabled ? "var(--success)" : "var(--border)"}`,
                      padding: "2px 7px",
                      borderRadius: 4,
                    }}
                  >
                    {play.enabled ? "Active" : "Paused"}
                  </span>
                </div>

                {/* Stat tiles */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6 }}>
                  {[
                    { label: "Total", value: play._count.prospects, color: "var(--text)" },
                    { label: "Sequence", value: inSeq, color: "var(--accent)" },
                    { label: "Replied", value: replied, color: "var(--warning)" },
                    { label: "Interested", value: interested, color: "var(--success)" },
                    { label: "Meetings", value: meetings, color: meetings > 0 ? "var(--success)" : "var(--text-dim)" },
                  ].map((tile) => (
                    <div
                      key={tile.label}
                      style={{
                        background: "var(--bg)",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        padding: "8px 6px",
                        textAlign: "center",
                      }}
                    >
                      <div style={{ fontSize: 15, fontWeight: 700, color: tile.color, fontVariantNumeric: "tabular-nums" }}>
                        {tile.value}
                      </div>
                      <div style={{ fontSize: 9, fontWeight: 600, color: "var(--text-dim)", letterSpacing: "0.04em", textTransform: "uppercase", marginTop: 2 }}>
                        {tile.label}
                      </div>
                    </div>
                  ))}
                </div>

                {/* CTA */}
                <Link
                  href="/agents/outbound-scout"
                  style={{ fontSize: 12, color: "var(--text-muted)", textDecoration: "none", display: "flex", alignItems: "center", gap: 4 }}
                >
                  <span>Run Scout</span>
                  <span style={{ color: "var(--text-dim)" }}>→</span>
                </Link>
              </div>
            );
          })}
        </div>
      </div>

      {/* Prospect pipeline */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <h2
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--text-dim)",
            }}
          >
            Recent Prospects
          </h2>
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
            Showing latest {recentProspects.length} of {totalProspects}
          </span>
        </div>

        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          {recentProspects.length === 0 ? (
            <div style={{ padding: "48px 24px", textAlign: "center" }}>
              <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>
                No prospects yet
              </p>
              <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 16 }}>
                Run the Scout agent to find and score prospects for your plays.
              </p>
              <Link href="/agents/outbound-scout" className="btn btn-secondary btn-sm">
                Run Scout agent →
              </Link>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 52 }}>Score</th>
                    <th>Name / Company</th>
                    <th>Title</th>
                    <th>Channel</th>
                    <th>Status</th>
                    <th>Play</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {recentProspects.map((prospect) => (
                    <tr key={prospect.id}>
                      {/* Score */}
                      <td>
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: 700,
                            fontVariantNumeric: "tabular-nums",
                            color: scoreColor(prospect.score),
                          }}
                        >
                          {prospect.score}
                        </span>
                      </td>

                      {/* Name + Company */}
                      <td>
                        <div style={{ fontWeight: 500, fontSize: 12, color: "var(--text)" }}>
                          {prospect.firstName} {prospect.lastName ?? ""}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>
                          {prospect.company}
                        </div>
                      </td>

                      {/* Title */}
                      <td style={{ fontSize: 12, color: "var(--text-muted)", maxWidth: 180 }}>
                        <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {prospect.title ?? "—"}
                        </span>
                      </td>

                      {/* Channel */}
                      <td>
                        <span style={channelBadgeStyle(prospect.channel)}>
                          {channelLabel(prospect.channel)}
                        </span>
                      </td>

                      {/* Status */}
                      <td>
                        <span style={statusBadgeStyle(prospect.status)}>
                          {statusLabel(prospect.status)}
                        </span>
                      </td>

                      {/* Play slug */}
                      <td>
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            fontFamily: "monospace",
                            color: "var(--text-dim)",
                            background: "var(--surface-2)",
                            border: "1px solid var(--border)",
                            padding: "2px 6px",
                            borderRadius: 3,
                          }}
                        >
                          {prospect.play.slug}
                        </span>
                      </td>

                      {/* Updated at */}
                      <td style={{ fontSize: 12, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                        {formatDistanceToNow(prospect.updatedAt)}
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

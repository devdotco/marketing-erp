import { getServerSession } from "@/lib/session";
import { redirect } from "next/navigation";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import { prisma } from "@/lib/prisma";
import { formatDistanceToNow } from "@/lib/utils";
import Link from "next/link";
import { DeleteButton } from "@/components/social/DeleteButton";

export const dynamic = "force-dynamic";
export const metadata = { title: "Post Queue — Social — marketing.erp.io" };

function platformLabel(platform: string): string {
  return platform === "LINKEDIN" ? "LI" : "X";
}

function platformBadgeStyle(platform: string): React.CSSProperties {
  const base: React.CSSProperties = {
    display: "inline-block",
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.04em",
    padding: "2px 7px",
    borderRadius: 4,
    whiteSpace: "nowrap",
  };
  if (platform === "LINKEDIN") {
    return { ...base, background: "rgba(10,102,194,0.15)", color: "#0a66c2", border: "1px solid rgba(10,102,194,0.4)" };
  }
  return { ...base, background: "rgba(255,255,255,0.08)", color: "var(--text)", border: "1px solid var(--border)" };
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
    case "PUBLISHED":
      return { ...base, background: "var(--success-bg)", color: "var(--success)", border: "1px solid var(--success)" };
    case "SCHEDULED":
      return { ...base, background: "rgba(59,130,246,0.12)", color: "var(--accent)", border: "1px solid var(--accent)" };
    case "FAILED":
      return { ...base, background: "rgba(239,68,68,0.12)", color: "var(--danger)", border: "1px solid var(--danger)" };
    case "DRAFT":
    default:
      return { ...base, background: "var(--surface-2)", color: "var(--text-muted)", border: "1px solid var(--border)" };
  }
}

function formatScheduledTime(date: Date | null): string {
  if (!date) return "—";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export default async function SocialQueuePage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");

  await requireWorkspaceAccess(workspaceId);

  const [scheduled, recent] = await Promise.all([
    prisma.socialPost.findMany({
      where: { workspaceId, status: "SCHEDULED" },
      include: { socialAccount: true },
      orderBy: { scheduledAt: "asc" },
    }),
    prisma.socialPost.findMany({
      where: { workspaceId, status: { in: ["PUBLISHED", "FAILED"] } },
      include: { socialAccount: true },
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
  ]);

  return (
    <div className="scrollable">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <div style={{ marginBottom: 6 }}>
            <Link
              href="/social"
              style={{ fontSize: 12, color: "var(--text-muted)", textDecoration: "none" }}
            >
              ← Social
            </Link>
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 4 }}>
            Post Queue
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
            Scheduled posts and publishing history
          </p>
        </div>
        <Link href="/social/compose" className="btn btn-primary btn-sm">
          Compose Post
        </Link>
      </div>

      {/* Scheduled posts */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h2
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--text-dim)",
            }}
          >
            Scheduled ({scheduled.length})
          </h2>
        </div>

        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          {scheduled.length === 0 ? (
            <div style={{ padding: "40px 24px", textAlign: "center" }}>
              <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>
                No posts scheduled
              </p>
              <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 16 }}>
                Schedule posts in advance to maintain a consistent presence.
              </p>
              <Link href="/social/compose" className="btn btn-secondary btn-sm">
                Compose a post →
              </Link>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 56 }}>Platform</th>
                    <th>Preview</th>
                    <th style={{ width: 140 }}>Account</th>
                    <th style={{ width: 160 }}>Scheduled</th>
                    <th style={{ width: 80 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {scheduled.map((post) => {
                    const preview = post.content.slice(0, 80) + (post.content.length > 80 ? "…" : "");
                    return (
                      <tr key={post.id}>
                        <td>
                          <span style={platformBadgeStyle(post.socialAccount.platform)}>
                            {platformLabel(post.socialAccount.platform)}
                          </span>
                        </td>
                        <td style={{ maxWidth: 300 }}>
                          <span
                            style={{
                              fontSize: 12,
                              color: "var(--text)",
                              display: "block",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={post.content}
                          >
                            {preview}
                          </span>
                        </td>
                        <td
                          style={{
                            fontSize: 12,
                            color: "var(--text-muted)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {post.socialAccount.displayName}
                        </td>
                        <td style={{ fontSize: 12, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                          {formatScheduledTime(post.scheduledAt)}
                        </td>
                        <td>
                          <DeleteButton
                            url={`/api/social/posts/${post.id}`}
                            label="Cancel"
                            confirmMessage="Cancel this scheduled post?"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Published / Failed history */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h2
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--text-dim)",
            }}
          >
            History ({recent.length})
          </h2>
          {recent.length === 50 && (
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Showing latest 50</span>
          )}
        </div>

        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          {recent.length === 0 ? (
            <div style={{ padding: "40px 24px", textAlign: "center" }}>
              <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
                No published or failed posts yet.
              </p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 56 }}>Platform</th>
                    <th>Preview</th>
                    <th style={{ width: 100 }}>Status</th>
                    <th style={{ width: 140 }}>Account</th>
                    <th style={{ width: 130 }}>Published</th>
                    <th style={{ width: 100 }}>Post link</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((post) => {
                    const preview = post.content.slice(0, 80) + (post.content.length > 80 ? "…" : "");
                    const time = post.publishedAt ?? post.updatedAt;
                    return (
                      <tr key={post.id}>
                        <td>
                          <span style={platformBadgeStyle(post.socialAccount.platform)}>
                            {platformLabel(post.socialAccount.platform)}
                          </span>
                        </td>
                        <td style={{ maxWidth: 280 }}>
                          <span
                            style={{
                              fontSize: 12,
                              color: "var(--text)",
                              display: "block",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={post.content}
                          >
                            {preview}
                          </span>
                          {post.status === "FAILED" && post.errorMessage && (
                            <span
                              style={{
                                fontSize: 11,
                                color: "var(--danger)",
                                display: "block",
                                marginTop: 2,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={post.errorMessage}
                            >
                              Error: {post.errorMessage}
                            </span>
                          )}
                        </td>
                        <td>
                          <span style={statusBadgeStyle(post.status)}>
                            {post.status.charAt(0) + post.status.slice(1).toLowerCase()}
                          </span>
                        </td>
                        <td
                          style={{
                            fontSize: 12,
                            color: "var(--text-muted)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {post.socialAccount.displayName}
                        </td>
                        <td style={{ fontSize: 12, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                          {formatDistanceToNow(time)}
                        </td>
                        <td>
                          {post.platformPostId ? (
                            <a
                              href={
                                post.socialAccount.platform === "LINKEDIN"
                                  ? `https://www.linkedin.com/feed/update/${post.platformPostId}`
                                  : `https://x.com/i/web/status/${post.platformPostId}`
                              }
                              target="_blank"
                              rel="noreferrer"
                              style={{
                                fontSize: 12,
                                color: "var(--accent)",
                                textDecoration: "none",
                              }}
                            >
                              View →
                            </a>
                          ) : (
                            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

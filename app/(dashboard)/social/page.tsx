import { getServerSession } from "@/lib/session";
import { redirect } from "next/navigation";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import { prisma } from "@/lib/prisma";
import { formatDistanceToNow } from "@/lib/utils";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const metadata = { title: "Social — marketing.erp.io" };

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

function platformLabel(platform: string): string {
  return platform === "LINKEDIN" ? "LI" : "X";
}

function isExpiringSoon(expiresAt: Date | null): boolean {
  if (!expiresAt) return false;
  const sevenDaysFromNow = new Date();
  sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
  return expiresAt < sevenDaysFromNow;
}

export default async function SocialPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");

  await requireWorkspaceAccess(workspaceId);

  const [accounts, recentPosts, published, scheduled, failed, today] = await Promise.all([
    prisma.socialAccount.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.socialPost.findMany({
      where: { workspaceId },
      include: { socialAccount: true },
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
    prisma.socialPost.count({ where: { workspaceId, status: "PUBLISHED" } }),
    prisma.socialPost.count({ where: { workspaceId, status: "SCHEDULED" } }),
    prisma.socialPost.count({ where: { workspaceId, status: "FAILED" } }),
    prisma.socialPost.count({
      where: {
        workspaceId,
        status: "PUBLISHED",
        publishedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      },
    }),
  ]);

  return (
    <div className="scrollable">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 4 }}>
            Social Publishing
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
            LinkedIn and X auto-posting, scheduling, and AI generation
          </p>
        </div>
        <Link href="/social/compose" className="btn btn-primary btn-sm">
          Compose Post
        </Link>
      </div>

      {/* Quick stats bar */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 10,
          marginBottom: 28,
        }}
      >
        {[
          { label: "Total Published", value: published, color: undefined },
          { label: "Published Today", value: today, color: "var(--success)" },
          { label: "Scheduled", value: scheduled, color: "var(--accent)" },
          { label: "Failed", value: failed, color: failed > 0 ? "var(--danger)" : undefined },
        ].map((stat) => (
          <div key={stat.label} className="stat-card">
            <div className="stat-value" style={stat.color ? { color: stat.color } : undefined}>
              {stat.value}
            </div>
            <div className="stat-label">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Connected Accounts */}
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
            Connected Accounts
          </h2>
          <Link
            href="/social/accounts"
            style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none" }}
          >
            Manage accounts →
          </Link>
        </div>

        {accounts.length === 0 ? (
          <div
            style={{
              background: "var(--surface)",
              border: "1px dashed var(--border)",
              borderRadius: 8,
              padding: "40px 24px",
              textAlign: "center",
            }}
          >
            <p style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>
              No accounts connected
            </p>
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16 }}>
              Connect a LinkedIn or X account to start publishing posts.
            </p>
            <Link href="/social/accounts" className="btn btn-primary btn-sm">
              Connect an account →
            </Link>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
            {accounts.map((account) => {
              const expiring = isExpiringSoon(account.expiresAt);
              return (
                <div
                  key={account.id}
                  style={{
                    background: "var(--surface)",
                    border: expiring ? "1px solid var(--warning)" : "1px solid var(--border)",
                    borderRadius: 8,
                    padding: 16,
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 6,
                        background: account.platform === "LINKEDIN" ? "rgba(10,102,194,0.15)" : "var(--surface-2)",
                        border: "1px solid var(--border)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 11,
                        fontWeight: 700,
                        color: account.platform === "LINKEDIN" ? "#0a66c2" : "var(--text)",
                        flexShrink: 0,
                      }}
                    >
                      {platformLabel(account.platform)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: "var(--text)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {account.displayName}
                      </div>
                      {account.username && (
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          @{account.username}
                        </div>
                      )}
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                        padding: "2px 6px",
                        borderRadius: 4,
                        background: "var(--surface-2)",
                        color: "var(--text-muted)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      {account.accountType === "PERSONAL" ? "Personal" : "Company"}
                    </span>
                    {expiring && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          letterSpacing: "0.04em",
                          textTransform: "uppercase",
                          padding: "2px 6px",
                          borderRadius: 4,
                          background: "rgba(234,179,8,0.12)",
                          color: "var(--warning)",
                          border: "1px solid var(--warning)",
                        }}
                      >
                        Token expiring
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent Posts */}
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
            Recent Posts
          </h2>
          <Link
            href="/social/queue"
            style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none" }}
          >
            View queue →
          </Link>
        </div>

        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          {recentPosts.length === 0 ? (
            <div style={{ padding: "48px 24px", textAlign: "center" }}>
              <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>
                No posts yet
              </p>
              <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 16 }}>
                Compose your first post and schedule or publish it immediately.
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
                    <th style={{ width: 100 }}>Status</th>
                    <th style={{ width: 140 }}>Time</th>
                    <th style={{ width: 140 }}>Account</th>
                  </tr>
                </thead>
                <tbody>
                  {recentPosts.map((post) => {
                    const preview = post.content.slice(0, 80) + (post.content.length > 80 ? "…" : "");
                    const time = post.publishedAt ?? post.scheduledAt ?? post.updatedAt;
                    return (
                      <tr key={post.id}>
                        <td>
                          <span style={platformBadgeStyle(post.socialAccount.platform)}>
                            {platformLabel(post.socialAccount.platform)}
                          </span>
                        </td>
                        <td style={{ maxWidth: 320 }}>
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
                        <td>
                          <span style={statusBadgeStyle(post.status)}>
                            {post.status.charAt(0) + post.status.slice(1).toLowerCase()}
                          </span>
                        </td>
                        <td style={{ fontSize: 12, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                          {formatDistanceToNow(time)}
                        </td>
                        <td
                          style={{
                            fontSize: 12,
                            color: "var(--text-muted)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            maxWidth: 140,
                          }}
                        >
                          {post.socialAccount.displayName}
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

      {/* Quick Links */}
      <div>
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
          Quick Links
        </h2>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {[
            { href: "/social/compose", label: "Compose Post" },
            { href: "/social/queue", label: "Post Queue" },
            { href: "/social/accounts", label: "Connected Accounts" },
          ].map((link) => (
            <Link
              key={link.href}
              href={link.href}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 14px",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 500,
                color: "var(--text)",
                textDecoration: "none",
              }}
            >
              {link.label} →
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

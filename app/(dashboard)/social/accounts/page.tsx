import { getServerSession } from "@/lib/session";
import { redirect } from "next/navigation";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { DeleteButton } from "@/components/social/DeleteButton";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connected Accounts — Social — marketing.erp.io" };

function platformLabel(platform: string): string {
  return platform === "LINKEDIN" ? "LI" : "X";
}

function isExpiringSoon(expiresAt: Date | null): boolean {
  if (!expiresAt) return false;
  const sevenDaysFromNow = new Date();
  sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
  return expiresAt < sevenDaysFromNow;
}

export default async function SocialAccountsPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");

  await requireWorkspaceAccess(workspaceId);

  const accounts = await prisma.socialAccount.findMany({
    where: { workspaceId },
    orderBy: { platform: "asc" },
  });

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
            Connected Accounts
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
            Manage LinkedIn and X accounts for automated posting
          </p>
        </div>
      </div>

      {/* Connect new accounts */}
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
          Connect Account
        </h2>
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <a
              href="/api/linkedin/connect"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 16px",
                background: "rgba(10,102,194,0.1)",
                border: "1px solid rgba(10,102,194,0.4)",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
                color: "#0a66c2",
                textDecoration: "none",
                cursor: "pointer",
              }}
            >
              <span style={{ fontWeight: 700, fontSize: 11 }}>LI</span>
              Connect LinkedIn (Personal)
            </a>
            <a
              href="/api/linkedin/connect?org=1"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 16px",
                background: "rgba(10,102,194,0.1)",
                border: "1px solid rgba(10,102,194,0.4)",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
                color: "#0a66c2",
                textDecoration: "none",
                cursor: "pointer",
              }}
            >
              <span style={{ fontWeight: 700, fontSize: 11 }}>LI</span>
              Connect LinkedIn (+ Pages)
            </a>
            <a
              href="/api/x/connect"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 16px",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
                color: "var(--text)",
                textDecoration: "none",
                cursor: "pointer",
              }}
            >
              <span style={{ fontWeight: 700, fontSize: 11 }}>X</span>
              Connect X
            </a>
          </div>

          {/* LinkedIn rate limit notice */}
          <div
            style={{
              background: "rgba(234,179,8,0.08)",
              border: "1px solid rgba(234,179,8,0.35)",
              borderRadius: 6,
              padding: "12px 16px",
              display: "flex",
              gap: 10,
            }}
          >
            <span style={{ fontSize: 14, color: "var(--warning)", flexShrink: 0, marginTop: 1 }}>⚠</span>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--warning)", marginBottom: 3 }}>
                LinkedIn auto-posting limit: 3 posts per day maximum
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                {"LinkedIn's API enforces strict limits on automated posting — exceeding these may result in account restrictions."}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Connected accounts list */}
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
          Connected ({accounts.length})
        </h2>

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
            <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
              No accounts connected yet. Use the buttons above to connect your first account.
            </p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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
                    alignItems: "center",
                    gap: 14,
                  }}
                >
                  {/* Platform icon */}
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 8,
                      background: account.platform === "LINKEDIN" ? "rgba(10,102,194,0.15)" : "var(--surface-2)",
                      border: "1px solid var(--border)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 12,
                      fontWeight: 700,
                      color: account.platform === "LINKEDIN" ? "#0a66c2" : "var(--text)",
                      flexShrink: 0,
                    }}
                  >
                    {platformLabel(account.platform)}
                  </div>

                  {/* Account info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                        {account.displayName}
                      </span>
                      {account.username && (
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                          @{account.username}
                        </span>
                      )}
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
                          Token expiring soon
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                      {account.expiresAt && (
                        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                          Expires {account.expiresAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        </span>
                      )}
                      {account.scopes && (
                        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                          Scopes: {account.scopes}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Disconnect button */}
                  <DeleteButton
                    url={`/api/social/accounts/${account.id}`}
                    label="Disconnect"
                    confirmMessage={`Disconnect ${account.displayName}? Any scheduled posts using this account will fail.`}
                    style={{ flexShrink: 0, padding: "6px 12px", fontSize: 12, borderRadius: 6, color: "var(--text-muted)" }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

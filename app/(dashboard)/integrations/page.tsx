import { getServerSession } from "@/lib/session";
import { redirect } from "next/navigation";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import { prisma } from "@/lib/prisma";
import Link from "next/link";

export const metadata = { title: "Integrations — marketing.erp.io" };

const INTEGRATIONS = [
  {
    provider: "GOOGLE_SEARCH_CONSOLE",
    name: "Google Search Console",
    description: "Index performance, keyword data, URL inspection",
    agents: ["Technical Audit", "SEO agents"],
    color: "#4285F4",
    docsUrl: "#",
  },
  {
    provider: "WORDPRESS",
    name: "WordPress",
    description: "Publish blog posts and pages directly to your site",
    agents: ["Blog Writer", "On-site Publisher"],
    color: "#21759B",
    docsUrl: "#",
  },
  {
    provider: "CARTESIA",
    name: "Cartesia",
    description: "Text-to-speech synthesis for podcast episodes",
    agents: ["Podcast"],
    color: "#6366F1",
    docsUrl: "#",
  },
  {
    provider: "GOOGLE_ADS",
    name: "Google Ads",
    description: "Campaign management and performance reporting",
    agents: ["Paid Media agents"],
    color: "#FBBC05",
    docsUrl: "#",
    comingSoon: true,
  },
  {
    provider: "META_ADS",
    name: "Meta Ads",
    description: "Facebook & Instagram campaign management",
    agents: ["Paid Media agents"],
    color: "#1877F2",
    docsUrl: "#",
    comingSoon: true,
  },
  {
    provider: "KLAVIYO",
    name: "Klaviyo",
    description: "Email and SMS lifecycle marketing campaigns",
    agents: ["Lifecycle agents"],
    color: "#6B2FFC",
    docsUrl: "#",
    comingSoon: true,
  },
  {
    provider: "APOLLO",
    name: "Apollo.io",
    description: "Prospect sourcing for outbound plays — DEV-01, DEV-02, DEV-03",
    agents: ["Outbound Scout"],
    color: "#3B82F6",
    docsUrl: "#",
  },
  {
    provider: "INSTANTLY",
    name: "Instantly",
    description: "Email campaign management and reply handling",
    agents: ["Outbound Email"],
    color: "#F59E0B",
    docsUrl: "#",
  },
  {
    provider: "AIMFOX",
    name: "Aimfox",
    description: "LinkedIn outreach sequences and reply handling",
    agents: ["Outbound LinkedIn"],
    color: "#8B5CF6",
    docsUrl: "#",
  },
  {
    provider: "GO_HIGH_LEVEL",
    name: "GoHighLevel",
    description: "CRM contacts and opportunity pipeline management",
    agents: ["Outbound Revenue"],
    color: "#16A34A",
    docsUrl: "#",
  },
] as const;

export default async function IntegrationsPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");

  await requireWorkspaceAccess(workspaceId);

  const connectedIntegrations = await prisma.integration.findMany({
    where: { workspaceId },
    select: { provider: true, id: true },
  });

  const connectedSet = new Set(connectedIntegrations.map((i) => i.provider));

  return (
    <div className="scrollable">
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 6 }}>Integrations</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Connect your accounts so agents can read data and publish on your behalf.
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {INTEGRATIONS.map((integration) => {
          const isConnected = connectedSet.has(integration.provider as never);
          const isSoon = "comingSoon" in integration && integration.comingSoon;

          return (
            <div
              key={integration.provider}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                padding: "16px 20px",
                background: "var(--surface)",
                border: `1px solid ${isConnected ? "var(--success)" : "var(--border)"}`,
                borderRadius: "var(--radius)",
                opacity: isSoon ? 0.65 : 1,
              }}
            >
              {/* Color dot */}
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: integration.color,
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  fontWeight: 700,
                  color: "white",
                  letterSpacing: "-0.02em",
                }}
              >
                {integration.name.charAt(0)}
              </div>

              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{integration.name}</span>
                  {isConnected && <span className="badge badge-completed">Connected</span>}
                  {isSoon && <span className="badge badge-soon">Soon</span>}
                </div>
                <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>{integration.description}</p>
                <p style={{ fontSize: 11, color: "var(--text-dim)", margin: "4px 0 0" }}>
                  Used by: {integration.agents.join(", ")}
                </p>
              </div>

              {!isSoon && (
                <div style={{ flexShrink: 0 }}>
                  {isConnected ? (
                    <button className="btn btn-ghost btn-sm" style={{ color: "var(--danger)" }}>
                      Disconnect
                    </button>
                  ) : (
                    <Link href={`/integrations/connect/${integration.provider.toLowerCase()}`} className="btn btn-secondary btn-sm">
                      Connect
                    </Link>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div
        style={{
          marginTop: 28,
          padding: "16px 20px",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          fontSize: 12,
          color: "var(--text-muted)",
        }}
      >
        <strong style={{ color: "var(--text)" }}>Security note:</strong> Integration credentials are encrypted with AES-256-GCM and stored in your workspace. Agents use them only during authorized runs.
      </div>
    </div>
  );
}

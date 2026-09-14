import { getServerSession } from "@/lib/session";
import { redirect } from "next/navigation";
import { resolveWorkspaceId, requireWorkspaceAccess } from "@/lib/actions/workspace";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { CONNECT_METHODS } from "@/lib/integrations/catalog";
import { DisconnectButton } from "@/components/integrations/DisconnectButton";
import { SETUP_GUIDES } from "@/lib/integrations/guides";
import { SetupGuideExpander } from "@/components/integrations/SetupGuide";

export const metadata = { title: "Integrations — marketing.erp.io" };

const INTEGRATIONS = [
  {
    provider: "ANTHROPIC",
    name: "Anthropic",
    description:
      "Your own Claude API key. Every agent run is billed to it, on your account and under your own rate limits. Nothing runs without one.",
    agents: ["Every agent"],
    color: "#D97757",
    docsUrl: "https://console.anthropic.com/settings/keys",
  },
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
    provider: "STORYBLOK",
    name: "Storyblok",
    description: "Publish blog posts as stories in your Storyblok space",
    agents: ["On-site Publisher"],
    color: "#09B3AF",
    docsUrl: "#",
  },
  {
    provider: "WEBFLOW",
    name: "Webflow",
    description: "Publish blog posts as CMS collection items",
    agents: ["On-site Publisher"],
    color: "#146EF5",
    docsUrl: "#",
  },
  {
    provider: "PAYLOAD",
    name: "Payload CMS",
    description: "Publish blog posts to your Payload instance, and let the Blog Writer link to your existing posts",
    agents: ["Blog Writer", "On-site Publisher", "Internal Linking"],
    color: "#000000",
    docsUrl: "https://payloadcms.com/docs/authentication/api-keys",
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
    agents: ["Email Marketing", "Newsletter"],
    color: "#6B2FFC",
    docsUrl: "#",
  },
  {
    provider: "APOLLO",
    name: "Apollo.io",
    description: "Prospect sourcing and enrichment for your workspace's outbound plays",
    agents: ["Outbound Scout", "Outbound Strategist", "Email Outbound"],
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
  {
    provider: "GOOGLE_ANALYTICS_4",
    name: "Google Analytics 4",
    description: "Session data, conversion tracking, and traffic analytics",
    agents: ["Weekly Report", "Attribution", "Anomaly Watch", "CRO Experiments"],
    color: "#E37400",
    docsUrl: "#",
  },
  {
    provider: "GOOGLE_BUSINESS_PROFILE",
    name: "Google Business Profile",
    description: "GBP posts and review management",
    agents: ["Local SEO / GBP", "Review Engine"],
    color: "#4285F4",
    docsUrl: "#",
  },
  {
    provider: "AHREFS",
    name: "Ahrefs",
    description: "Keyword research, backlink data, and competitor analysis",
    agents: ["SEO agents", "Prospector"],
    color: "#F96932",
    docsUrl: "#",
  },
  {
    provider: "SEMRUSH",
    name: "Semrush",
    description: "SEO, PPC, and competitive intelligence data",
    agents: ["SEO agents"],
    color: "#FF642D",
    docsUrl: "#",
  },
  {
    provider: "SEARCH_ATLAS",
    name: "SearchAtlas",
    description: "Topic ideas and content-gap keyword data — keywords competitors rank for that you don't",
    agents: ["Topic Planner", "Competitor Watch", "Keyword Research"],
    color: "#5B21B6",
    docsUrl: "https://dashboard.searchatlas.com/settings?active_section=api",
  },
  {
    provider: "TRANSISTOR",
    name: "Transistor",
    description: "Podcast hosting — create and publish episodes",
    agents: ["Podcast"],
    color: "#E53E3E",
    docsUrl: "#",
  },
  {
    provider: "GMAIL",
    name: "Gmail",
    description: "Inbox triage and outreach draft sending",
    agents: ["Outreach", "Inbox Responder"],
    color: "#EA4335",
    docsUrl: "#",
  },
  {
    provider: "MICROSOFT_365",
    name: "Microsoft 365",
    description: "Outlook inbox triage and outreach drafts",
    agents: ["Outreach", "Inbox Responder"],
    color: "#0078D4",
    docsUrl: "#",
  },
  {
    provider: "META",
    name: "Meta",
    description: "Publish to Facebook Pages and Instagram",
    agents: ["Meta Poster"],
    color: "#1877F2",
    docsUrl: "#",
  },
  {
    provider: "MAILCHIMP",
    name: "Mailchimp",
    description: "Email campaigns and audience management",
    agents: ["Email Marketing", "Newsletter"],
    color: "#FFE01B",
    textColor: "#000000",
    docsUrl: "#",
  },
  {
    provider: "CRM_ERP_IO",
    name: "erp.io CRM",
    description: "Stage a sequence and enroll a segment in app.erp.io/crm — per-tenant API key, never a shared secret",
    agents: ["Email Marketing"],
    color: "#4F46E5",
    docsUrl: "#",
  },
  {
    provider: "OPENAI_IMAGES",
    name: "OpenAI Images",
    description: "Generate real hero and inline images for an article, billed to your own OpenAI account",
    agents: ["Blog Writer"],
    color: "#10A37F",
    docsUrl: "https://platform.openai.com/docs/guides/image-generation",
  },
  {
    provider: "GOOGLE_IMAGES",
    name: "Google Images (Gemini)",
    description: "Generate real hero and inline images for an article using Google's Gemini image model",
    agents: ["Blog Writer"],
    color: "#4285F4",
    docsUrl: "https://ai.google.dev/gemini-api/docs/image-generation",
  },
] as const;

/**
 * Whether this server holds what the provider's connect flow needs. Without it
 * the Connect button would send someone to a flow that fails on the first
 * redirect — show "Not set up" instead, which is the truth.
 */
function serverConfigured(provider: string, kind: string | undefined): boolean {
  const env = process.env;
  if (kind === "google") {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return false;
    return provider !== "GOOGLE_ADS" || Boolean(env.GOOGLE_ADS_DEVELOPER_TOKEN);
  }
  if (kind === "microsoft") return Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET);
  if (kind === "meta") return Boolean(env.META_APP_ID && env.META_APP_SECRET);
  return true;
}

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) redirect("/onboarding");

  await requireWorkspaceAccess(workspaceId);

  const connectedIntegrations = await prisma.integration.findMany({
    where: { workspaceId },
    select: { provider: true, id: true, label: true },
  });

  const connected = new Map<string, { label: string | null }>(
    connectedIntegrations.map((i) => [i.provider, { label: i.label }]),
  );

  return (
    <div className="scrollable">
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 6 }}>Integrations</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Connect your accounts so agents can read data and publish on your behalf.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            marginBottom: 16,
            padding: "12px 16px",
            background: "var(--danger-bg)",
            color: "var(--danger)",
            borderRadius: "var(--radius)",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {INTEGRATIONS.map((integration) => {
          const isConnected = connected.has(integration.provider);
          // A provider with no connect method gets "Soon", never a Connect
          // button that lands on "Unknown provider".
          const method = CONNECT_METHODS[integration.provider]?.method;
          const isSoon = ("comingSoon" in integration && integration.comingSoon) || (!method && !isConnected);
          const connectedLabel = connected.get(integration.provider)?.label;
          const notSetUp = !isSoon && !isConnected && !serverConfigured(integration.provider, method?.kind);

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
                  {notSetUp && <span className="badge badge-muted">Not set up</span>}
                </div>
                <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>{integration.description}</p>
                <p style={{ fontSize: 11, color: "var(--text-dim)", margin: "4px 0 0" }}>
                  Used by: {integration.agents.join(", ")}
                  {isConnected && connectedLabel && connectedLabel !== integration.provider && (
                    <> · Using <span style={{ color: "var(--text-muted)" }}>{connectedLabel}</span></>
                  )}
                </p>
                {SETUP_GUIDES[integration.provider] && <SetupGuideExpander guide={SETUP_GUIDES[integration.provider]!} />}
              </div>

              {!isSoon && !notSetUp && (
                <div style={{ flexShrink: 0 }}>
                  {isConnected ? (
                    <span style={{ display: "inline-flex", gap: 6 }}>
                      {method && method.kind !== "key" && (
                        <Link href={`/integrations/connect/${integration.provider.toLowerCase()}`} className="btn btn-ghost btn-sm">
                          Settings
                        </Link>
                      )}
                      <DisconnectButton provider={integration.provider} name={integration.name} />
                    </span>
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

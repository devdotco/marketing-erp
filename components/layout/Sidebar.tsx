"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useState, useEffect } from "react";
import {
  LayoutDashboard, FileText, Mic, Share2, Search, Link2,
  BarChart2, Mail, TrendingUp, Bot, Plug, Settings,
  ChevronDown, LogOut, Plus, ExternalLink, Menu, X,
} from "lucide-react";

interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  plan: string;
  members: { role: string }[];
}

interface UserSummary {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

interface SidebarProps {
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  user: UserSummary;
  enabledCounts: Record<string, number>;
}

const NAV_GROUPS = [
  {
    label: null,
    items: [{ href: "/", icon: LayoutDashboard, label: "Dashboard" }],
  },
  {
    label: "Content",
    items: [
      { href: "/agents/suite/content",     icon: FileText,    label: "Writing",     suite: "content" },
      { href: "/agents/suite/audio-video", icon: Mic,         label: "Podcasting",  suite: "audio-video" },
      { href: "/agents/suite/content",     icon: FileText,    label: "Publishing",  suite: "content" },
      { href: "/agents/suite/social",      icon: Share2,      label: "Social",      suite: "social" },
    ],
  },
  {
    label: "Growth",
    items: [
      { href: "/agents/suite/seo",           icon: Search,    label: "SEO",           suite: "seo" },
      { href: "/agents/suite/link-building", icon: Link2,     label: "Link Building", suite: "link-building" },
    ],
  },
  {
    label: "Performance",
    items: [
      { href: "/agents/suite/paid-media", icon: BarChart2,   label: "Paid Media", suite: "paid-media" },
      { href: "/agents/suite/analytics",  icon: TrendingUp,  label: "Analytics",  suite: "analytics" },
    ],
  },
  {
    label: "Lifecycle",
    items: [
      { href: "/agents/suite/lifecycle", icon: Mail, label: "Lifecycle", suite: "lifecycle" },
    ],
  },
  {
    label: "Operator",
    items: [
      { href: "/agents/suite/operator", icon: Bot, label: "Operator", suite: "operator" },
    ],
  },
  {
    label: null,
    items: [
      { href: "/integrations", icon: Plug,     label: "Integrations" },
      { href: "/settings",     icon: Settings, label: "Settings" },
    ],
  },
];

function AppLogo() {
  return (
    <div style={{ padding: "14px 12px 10px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{
        display: "grid", placeItems: "center",
        width: 24, height: 24,
        borderRadius: 6,
        background: "var(--accent)",
        color: "var(--accent-fg)",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "-0.03em",
        flexShrink: 0,
      }}>M</span>
      <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--text)" }}>
        Marketing
      </span>
      <span style={{
        marginLeft: "auto",
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--text-dim)",
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: 3,
        padding: "1px 5px",
      }}>erp.io</span>
    </div>
  );
}

export function Sidebar({ workspaces, activeWorkspaceId, user, enabledCounts }: SidebarProps) {
  const pathname = usePathname();
  const [wsOpen, setWsOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close sidebar on route change (mobile)
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Prevent body scroll when mobile sidebar is open
  useEffect(() => {
    if (mobileOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [mobileOpen]);

  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];

  const initials = (user.name ?? user.email ?? "?")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <>
      {/* Mobile topbar — hidden on desktop via CSS */}
      <div className="mobile-topbar">
        <button
          className="mobile-hamburger"
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation"
        >
          <Menu size={20} />
        </button>
        <div className="mobile-topbar-brand">
          <span style={{
            display: "grid", placeItems: "center",
            width: 22, height: 22,
            borderRadius: 5,
            background: "var(--accent)",
            color: "var(--accent-fg)",
            fontSize: 10,
            fontWeight: 700,
          }}>M</span>
          <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--text)" }}>
            Marketing
          </span>
        </div>
      </div>

      {/* Backdrop (mobile only) */}
      {mobileOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside className={`sidebar${mobileOpen ? " sidebar-mobile-open" : ""}`}>
        {/* Close button inside sidebar (mobile only) */}
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "10px 12px 0" }}>
          <button
            className="sidebar-close-btn mobile-hamburger"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          >
            <X size={18} />
          </button>
        </div>

        <AppLogo />

        {/* Workspace switcher */}
        <div className="sidebar-top">
          <div style={{ position: "relative" }}>
            <button
              className="workspace-switcher"
              onClick={() => setWsOpen((o) => !o)}
              aria-expanded={wsOpen}
            >
              <div
                style={{
                  width: 22,
                  height: 22,
                  background: "var(--text)",
                  borderRadius: 4,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <span style={{ color: "var(--bg)", fontSize: 9, fontWeight: 700 }}>
                  {(activeWs?.name ?? "?").charAt(0).toUpperCase()}
                </span>
              </div>
              <span className="workspace-name-text" style={{ flex: 1 }}>
                {activeWs?.name ?? "My Workspace"}
              </span>
              <span className="workspace-plan-badge">
                {activeWs?.plan ?? "FREE"}
              </span>
              <ChevronDown
                size={12}
                color="var(--text-dim)"
                style={{ transform: wsOpen ? "rotate(180deg)" : undefined, transition: "transform 0.15s", flexShrink: 0 }}
              />
            </button>

            {/* Workspace dropdown */}
            {wsOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  left: 0,
                  right: 0,
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
                  zIndex: 60,
                  overflow: "hidden",
                }}
              >
                <div style={{ padding: "6px" }}>
                  {workspaces.map((ws) => (
                    <form
                      key={ws.id}
                      action={async () => {
                        const { setActiveWorkspace } = await import("@/lib/actions/workspace");
                        await setActiveWorkspace(ws.id);
                      }}
                    >
                      <button
                        type="submit"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "7px 8px",
                          borderRadius: "var(--radius-sm)",
                          cursor: "pointer",
                          width: "100%",
                          background: ws.id === activeWorkspaceId ? "var(--surface-2)" : "transparent",
                          border: "none",
                          textAlign: "left",
                        }}
                      >
                        <div
                          style={{
                            width: 20,
                            height: 20,
                            background: "var(--surface-3)",
                            borderRadius: 3,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 9,
                            fontWeight: 700,
                            flexShrink: 0,
                            color: "var(--text-muted)",
                          }}
                        >
                          {ws.name.charAt(0).toUpperCase()}
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {ws.name}
                        </span>
                        {ws.id === activeWorkspaceId && (
                          <span style={{ color: "var(--success)", fontSize: 10 }}>✓</span>
                        )}
                      </button>
                    </form>
                  ))}
                </div>
                <div style={{ borderTop: "1px solid var(--border)", padding: "6px" }}>
                  <Link
                    href="/settings/new-workspace"
                    onClick={() => setWsOpen(false)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 8px",
                      borderRadius: "var(--radius-sm)",
                      fontSize: 12,
                      color: "var(--text-muted)",
                      textDecoration: "none",
                    }}
                  >
                    <Plus size={12} />
                    New workspace
                  </Link>
                  <a
                    href={process.env.NEXT_PUBLIC_DASHBOARD_URL || "https://dashboard.erp.io"}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 8px",
                      borderRadius: "var(--radius-sm)",
                      fontSize: 12,
                      color: "var(--text-muted)",
                      textDecoration: "none",
                    }}
                  >
                    <ExternalLink size={12} />
                    erp.io dashboard
                  </a>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Navigation */}
        <nav className="sidebar-nav">
          <Link
            href="/agents"
            className={`nav-item ${isActive("/agents") ? "active" : ""}`}
            style={{ marginBottom: 4 }}
          >
            <Bot size={14} />
            All Agents
            <span className="nav-item-count">48</span>
          </Link>

          {NAV_GROUPS.map((group, gi) => (
            <div key={gi}>
              {group.label && (
                <div className="sidebar-section-label">{group.label}</div>
              )}
              {group.items.map((item) => {
                const Icon = item.icon;
                const count = "suite" in item ? enabledCounts[item.suite] : undefined;
                return (
                  <Link
                    key={item.href + item.label}
                    href={item.href}
                    className={`nav-item ${isActive(item.href) ? "active" : ""}`}
                  >
                    <Icon size={14} />
                    {item.label}
                    {count != null && count > 0 && (
                      <span className="nav-item-count" style={{ color: "var(--success)" }}>{count}</span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}

          <div style={{ marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <Link href="/runs" className={`nav-item ${isActive("/runs") ? "active" : ""}`}>
              <LayoutDashboard size={14} />
              Runs
            </Link>
          </div>
        </nav>

        {/* User footer */}
        <div className="sidebar-bottom">
          <div className="user-row" title={user.email ?? ""}>
            <div className="user-avatar">
              {user.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={user.image} alt={user.name ?? ""} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                initials
              )}
            </div>
            <span className="user-name">{user.name ?? user.email}</span>
            <button
              onClick={() => signOut({ callbackUrl: "/login" })}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 4, borderRadius: 4, color: "var(--text-dim)" }}
              title="Sign out"
            >
              <LogOut size={13} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

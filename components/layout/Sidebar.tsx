"use client";

import { useTransition } from "react";
import {
  LayoutDashboard, FileText, Mic, Share2, Search, Link2, BarChart2,
  TrendingUp, Mail, Bot, Crosshair, Target, PenSquare, CalendarClock,
  UserCheck, Activity, Plug, Radar,
} from "lucide-react";
import { AppRail, ModuleSidebar, buildRailItems } from "@erp-ui";
import type { ErpBrand, ErpNavSection } from "@erp-ui";
import { ERP_MODULE_ICONS } from "@erp-ui/icons";
import { setActiveWorkspace } from "@/lib/actions/workspace";

export interface SidebarWorkspace {
  id: string;
  name: string;
  slug: string;
  plan: string;
  members?: unknown;
}

interface SidebarProps {
  workspaces: SidebarWorkspace[];
  activeWorkspaceId: string | null;
  user: { id: string; name?: string | null; email?: string | null; image?: string | null };
  enabledCounts: Record<string, number>;
}

/**
 * Marketing's chrome, drawn with the shared suite components.
 *
 * This module was the furthest out of line in the whole suite: a LIGHT sidebar
 * where the other eleven are dark, its own "M / Marketing / erp.io" lockup, its
 * own workspace dropdown and its own rail. Moving between /home and here
 * changed the product's colour scheme.
 *
 * The rail must be built in here, not in the layout: the layout is a server
 * component and `buildRailItems()` returns items whose `icon` is a React
 * component. Passing that across the boundary compiles and builds, then throws
 * on every request — it took /crm down for a deploy.
 */
export function MarketingRail({ brand, modules }: { brand?: ErpBrand | null; modules?: string[] | null }) {
  return (
    <AppRail
      items={buildRailItems({ enabled: modules ?? undefined })}
      activeKey="marketing"
      brand={brand}
    />
  );
}

const NAV: ErpNavSection[] = [
  { items: [{ label: "Dashboard", href: "/", icon: LayoutDashboard, exact: true }] },
  {
    label: "Content",
    items: [
      { label: "Content", href: "/agents/suite/content", icon: FileText },
      { label: "Audio & Video", href: "/agents/suite/audio-video", icon: Mic },
      { label: "Social", href: "/agents/suite/social", icon: Share2 },
    ],
  },
  {
    label: "Growth",
    items: [
      { label: "AI Visibility", href: "/visibility", icon: Radar },
      { label: "AI Crawlers", href: "/visibility/crawlers", icon: Bot },
      { label: "SEO", href: "/agents/suite/seo", icon: Search },
      { label: "Link Building", href: "/agents/suite/link-building", icon: Link2 },
    ],
  },
  {
    label: "Performance",
    items: [
      { label: "Paid Media", href: "/agents/suite/paid-media", icon: BarChart2 },
      { label: "Analytics", href: "/agents/suite/analytics", icon: TrendingUp },
    ],
  },
  { label: "Lifecycle", items: [{ label: "Lifecycle", href: "/agents/suite/lifecycle", icon: Mail }] },
  { label: "Operator", items: [{ label: "Operator", href: "/agents/suite/operator", icon: Bot }] },
  {
    label: "Outbound",
    items: [
      { label: "Pipeline", href: "/outbound", icon: Crosshair, exact: true },
      { label: "Agents", href: "/agents/suite/outbound", icon: Target },
    ],
  },
  {
    label: "Social",
    items: [
      { label: "Overview", href: "/social", icon: Share2, exact: true },
      { label: "Compose", href: "/social/compose", icon: PenSquare },
      { label: "Queue", href: "/social/queue", icon: CalendarClock },
      { label: "Accounts", href: "/social/accounts", icon: UserCheck },
    ],
  },
  {
    items: [
      { label: "Runs", href: "/runs", icon: Activity },
      { label: "Integrations", href: "/integrations", icon: Plug },
    ],
  },
];

/** Which agent-suite each nav item counts, for its badge. */
const SUITE_BY_HREF: Record<string, string> = {
  "/agents/suite/content": "content",
  "/agents/suite/audio-video": "audio-video",
  "/agents/suite/social": "social",
  "/agents/suite/seo": "seo",
  "/agents/suite/link-building": "link-building",
  "/agents/suite/paid-media": "paid-media",
  "/agents/suite/analytics": "analytics",
  "/agents/suite/lifecycle": "lifecycle",
  "/agents/suite/operator": "operator",
  "/agents/suite/outbound": "outbound",
};

export function Sidebar({ workspaces, activeWorkspaceId, user, enabledCounts }: SidebarProps) {
  const [, startTransition] = useTransition();

  const sections: ErpNavSection[] = NAV.map((section) => ({
    ...section,
    items: section.items.map((item) => {
      const suite = item.href ? SUITE_BY_HREF[item.href] : undefined;
      return suite ? { ...item, badge: enabledCounts[suite] || undefined } : item;
    }),
  }));

  return (
    <ModuleSidebar
      moduleLabel="Marketing"
      moduleIcon={ERP_MODULE_ICONS.marketing}
      moduleHref="/"
      sections={sections}
      /**
       * These are marketing WORKSPACES, and today each one is its own shell
       * organization — "Dev.co" has its own `shellOrgId`. That is the level
       * mismatch the suite still has to resolve: accounting keeps books for
       * three or four legal entities, and Phony's own schema notes that one
       * workspace runs a dozen brands. Once brands are demoted to properties
       * under an entity, these move to `scopeSwitcher` and the org switcher
       * above them shows the entity. Left here until that migration runs,
       * because pretending to a hierarchy the data does not have would be
       * worse than showing what is actually there.
       */
      orgs={workspaces.map((w) => ({ id: w.id, name: w.name }))}
      currentOrgId={activeWorkspaceId}
      onSwitchOrg={(id) => startTransition(() => { void setActiveWorkspace(id); })}
      user={{ name: user.name || user.email || "", email: user.email || "" }}
      settingsHref="/settings"
    />
  );
}

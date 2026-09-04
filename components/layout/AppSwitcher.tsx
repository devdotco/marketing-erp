"use client";

import {
  Home, MessageSquare, CheckSquare, Users, TrendingUp, Building2,
  FileSignature, Share2, PenTool, Scale, Calculator, Phone, Megaphone,
} from "lucide-react";

/**
 * The suite rail.
 *
 * Same 44px strip as every other module, in the same order, because people
 * navigate it by muscle memory rather than by reading the tooltips. Marketing
 * had only a single "erp.io dashboard" link buried in the workspace menu, so
 * there was no way to reach a sibling app from here at all.
 *
 * Hosts are the ones actually served: Accounting and CFO have moved onto
 * app.erp.io paths, and a mechanical `<name>.erp.io` would give two dead links.
 */
const MODULES = [
  { key: "shell",     title: "erp.io Home",        url: "https://app.erp.io",            Icon: Home },
  { key: "messaging", title: "erp.io Chat",        url: "https://chat.erp.io",           Icon: MessageSquare },
  { key: "pm",        title: "erp.io Projects",    url: "https://pm.erp.io",             Icon: CheckSquare },
  { key: "portal",    title: "erp.io Client Portal", url: "https://portal.erp.io",       Icon: Users },
  { key: "finance",   title: "erp.io Accounting",  url: "https://app.erp.io/accounting", Icon: TrendingUp },
  { key: "cfo",       title: "erp.io CFO",         url: "https://app.erp.io/cfo",        Icon: Calculator },
  { key: "crm",       title: "erp.io CRM",         url: "https://crm.erp.io",            Icon: Building2 },
  { key: "legal",     title: "erp.io Legal",       url: "https://legal.erp.io",          Icon: Scale },
  { key: "sign",      title: "erp.io Sign",        url: "https://sign.erp.io",           Icon: FileSignature },
  { key: "sdr",       title: "Phony",              url: "https://phony.erp.io",          Icon: Phone },
  { key: "canvas",    title: "erp.io Canvas",      url: "https://canvas.erp.io",         Icon: PenTool },
  { key: "social",    title: "erp.io Social",      url: "https://social.erp.io",         Icon: Share2 },
] as const;

export function AppSwitcher() {
  return (
    <nav className="app-rail" aria-label="Applications">
      <a href="https://app.erp.io" className="app-rail-logo" title="erp.io Home">E.</a>
      <span className="app-rail-divider" />

      {/* Marketing is where we already are, so it is a marker, not a link. */}
      <span className="app-rail-icon app-rail-icon-active" title="erp.io Marketing" aria-current="page">
        <Megaphone size={17} />
      </span>

      {MODULES.map(({ key, title, url, Icon }) => (
        <a key={key} href={url} className="app-rail-icon" title={title}>
          <Icon size={17} />
        </a>
      ))}
    </nav>
  );
}
